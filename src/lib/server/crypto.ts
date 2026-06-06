import { env } from '$env/dynamic/private';

/**
 * 외부 API 키 등 "다시 평문이 필요한" 비밀의 양방향(대칭) 암호화.
 * Workers 런타임 = Web Crypto(crypto.subtle)만 사용(node crypto 금지).
 *
 * 키 파생: 서버 시크릿(KEY_SECRET, 없으면 AUTH_SECRET)을 SHA-256 → 32바이트 AES-GCM 키.
 *  → 시크릿을 바꾸면 기존 암호문은 복호화 불가(키 재등록 필요). 로컬은 AUTH_SECRET 으로 폴백 가능.
 * 포맷: base64url( iv(12바이트) || ciphertext(+GCM tag) ).
 */

function secret(): string {
	const s = env.KEY_SECRET || env.AUTH_SECRET;
	if (!s) throw new Error('KEY_SECRET / AUTH_SECRET 미설정 — 비밀 암호화 불가');
	return s;
}

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function aesKey(): Promise<CryptoKey> {
	const s = secret();
	if (cachedKey && cachedKey.secret === s) return cachedKey.key;
	const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
	cachedKey = { secret: s, key };
	return key;
}

function bytesToB64url(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** 평문 → base64url(iv || ciphertext). */
export async function encryptSecret(plaintext: string): Promise<string> {
	const key = await aesKey();
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
	);
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0);
	out.set(ct, iv.length);
	return bytesToB64url(out);
}

/** base64url(iv || ciphertext) → 평문. 손상/키 불일치면 throw. */
export async function decryptSecret(encoded: string): Promise<string> {
	const key = await aesKey();
	const all = b64urlToBytes(encoded);
	const iv = all.slice(0, 12);
	const ct = all.slice(12);
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(pt);
}
