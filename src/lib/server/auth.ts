import { Google } from 'arctic';
import { env } from '$env/dynamic/private';

export const SESSION_COOKIE = 'haven_session';
export const STATE_COOKIE = 'google_oauth_state';
export const VERIFIER_COOKIE = 'google_code_verifier';

/** 세션 유효기간(초). 30일. */
export const SESSION_TTL = 60 * 60 * 24 * 30;

/** 세션 쿠키에 담기는 최소 신원 정보. 프로필(이름/페르소나 등)은 DB에서 로드. */
export interface SessionIdentity {
	id: string;
	email: string;
}

/**
 * [테스트용 화이트리스트] 허용된 이메일만 로그인 가능.
 * ALLOWED_EMAILS(쉼표구분) env 로 조정. 미설정 시 기본 'owner@example.com'.
 * 빈 문자열로 두면 전체 허용(=화이트리스트 해제).
 */
export function isEmailAllowed(email: string): boolean {
	const raw = env.ALLOWED_EMAILS ?? 'owner@example.com';
	const list = raw
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (list.length === 0) return true;
	return list.includes(email.trim().toLowerCase());
}

/** 관리자 이메일. import 캐릭터 프롬프트 편집 등 일부 제한을 우회한다. */
export const ADMIN_EMAIL = 'owner@example.com';

/** 관리자 여부. (대소문자·공백 무시) */
export function isAdmin(email: string | null | undefined): boolean {
	return !!email && email.trim().toLowerCase() === ADMIN_EMAIL;
}

/** 요청 origin 기준으로 Google OAuth 클라이언트 생성. (GOOGLE_REDIRECT_URI 로 override 가능) */
export function createGoogle(origin: string): Google {
	const redirectURI = env.GOOGLE_REDIRECT_URI || `${origin}/auth/google/callback`;
	return new Google(env.GOOGLE_CLIENT_ID ?? '', env.GOOGLE_CLIENT_SECRET ?? '', redirectURI);
}

// ─────────────────────────────────────────────────────────────
// 서명된(stateless) 세션 토큰: base64url(payload).base64url(HMAC-SHA256)
//   추후 D1 도입 시 DB 기반 세션으로 승격 예정.
// ─────────────────────────────────────────────────────────────
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

async function hmac(data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(env.AUTH_SECRET ?? ''),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

export async function createSessionToken(identity: SessionIdentity): Promise<string> {
	const payload = { ...identity, exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
	const body = bytesToB64url(encoder.encode(JSON.stringify(payload)));
	const sig = bytesToB64url(await hmac(body));
	return `${body}.${sig}`;
}

export async function verifySessionToken(token: string): Promise<SessionIdentity | null> {
	const [body, sig] = token.split('.');
	if (!body || !sig) return null;

	const expected = bytesToB64url(await hmac(body));
	if (!timingSafeEqual(sig, expected)) return null;

	try {
		const payload = JSON.parse(decoder.decode(b64urlToBytes(body))) as SessionIdentity & {
			exp: number;
		};
		if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
		return { id: payload.id, email: payload.email };
	} catch {
		return null;
	}
}
