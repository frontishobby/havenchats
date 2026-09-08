/**
 * Google Drive 클라이언트 — 브라우저 전용(서버 없음).
 *
 *  - 인증: Google Identity Services(GIS) 토큰 모델. `drive.appdata` 스코프만 요청해 앱 전용 숨김 폴더
 *    (appDataFolder)에만 접근한다(유저의 다른 Drive 파일은 보지 못함). 액세스 토큰은 1시간 만료 —
 *    갱신은 팝업이 필요하므로 **유저 제스처 안에서** `ensureToken()` 을 부르는 편이 안전하다.
 *  - 저장: DB 스냅샷(`haven.sqlite`) 1개 + 이미지 파일(name = R2 키, 예 `char/<id>.webp`).
 *
 * Google Cloud 콘솔 준비: OAuth 클라이언트(웹) 의 '승인된 JavaScript 원본'에 이 페이지 오리진
 * (https://havenchats.com, http://localhost:5173)을 넣는다. 앱은 '테스트' 상태로 두고 테스트 사용자에 본인만 추가.
 */
import { env } from '$env/dynamic/public';
import { kvDelete, kvSet } from './idb';

/** OAuth 클라이언트 ID(비밀 아님 — 공개 식별자). 빌드 env PUBLIC_GOOGLE_CLIENT_ID 로 덮어쓸 수 있다. */
const DEFAULT_CLIENT_ID = '965110096401-ddiqcikdcsn0ffp2d7n0uvno534t3f1l.apps.googleusercontent.com';
export const GOOGLE_CLIENT_ID = env.PUBLIC_GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_KEY = 'haven:drive:token';
/** 서비스워커(static/img-sw.js)가 Drive 지연 다운로드에 쓰는 kv 키. */
export const TOKEN_KV_KEY = 'drive:token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
/** 만료 이 시간 전이면 갱신 시도. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface StoredToken {
	accessToken: string;
	expiresAt: number; // epoch ms
}

// ── GIS 최소 타입 ──
interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}
interface TokenClient {
	requestAccessToken(opts?: { prompt?: '' | 'consent' | 'select_account' }): void;
}
interface GoogleAccounts {
	accounts: {
		oauth2: {
			initTokenClient(cfg: {
				client_id: string;
				scope: string;
				callback: (r: TokenResponse) => void;
				error_callback?: (e: { type: string; message?: string }) => void;
			}): TokenClient;
			revoke(token: string, done?: () => void): void;
		};
	};
}
declare global {
	interface Window {
		google?: GoogleAccounts;
	}
}

export class DriveAuthError extends Error {
	constructor(
		message: string,
		readonly kind: 'popup_blocked' | 'denied' | 'no_client_id' | 'other' = 'other'
	) {
		super(message);
	}
}

let token: StoredToken | null = null;
let gisLoading: Promise<void> | null = null;

function loadStored(): StoredToken | null {
	if (token) return token;
	try {
		const raw = localStorage.getItem(TOKEN_KEY);
		if (raw) token = JSON.parse(raw) as StoredToken;
	} catch {
		token = null;
	}
	return token;
}

function store(t: StoredToken | null) {
	token = t;
	try {
		if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		/* storage unavailable */
	}
	// 서비스워커는 localStorage 를 못 읽으므로 IndexedDB 에도 복사.
	void (t ? kvSet(TOKEN_KV_KEY, t) : kvDelete(TOKEN_KV_KEY)).catch(() => {});
}

/** 유효한(만료 여유 있는) 토큰이 있으면 반환, 없으면 null(팝업 없음). */
export function currentToken(): string | null {
	const t = loadStored();
	if (!t) return null;
	if (t.expiresAt - Date.now() < REFRESH_MARGIN_MS) return null;
	return t.accessToken;
}

/** 저장된 토큰이 있는지(만료 여부 무관 — '연결한 적 있음' 판단용). */
export function hasStoredToken(): boolean {
	return !!loadStored();
}

export function forgetToken(): void {
	const t = loadStored();
	store(null);
	if (t && window.google) {
		try {
			window.google.accounts.oauth2.revoke(t.accessToken);
		} catch {
			/* ignore */
		}
	}
}

function loadGis(): Promise<void> {
	if (window.google?.accounts?.oauth2) return Promise.resolve();
	return (gisLoading ??= new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = 'https://accounts.google.com/gsi/client';
		s.async = true;
		s.onload = () => resolve();
		s.onerror = () => reject(new DriveAuthError('Google 로그인 스크립트를 불러오지 못했어요.'));
		document.head.appendChild(s);
	}));
}

/**
 * 액세스 토큰 확보. 유효한 게 있으면 그대로, 없으면 GIS 팝업으로 발급(이미 동의한 계정이면 팝업이
 * 바로 닫힌다). 팝업은 유저 제스처 밖에선 차단될 수 있다 → DriveAuthError('popup_blocked').
 * @param interactive false 면 팝업 없이 저장된 토큰만 확인.
 */
export async function ensureToken(interactive = true): Promise<string> {
	const cur = currentToken();
	if (cur) return cur;
	if (!interactive) throw new DriveAuthError('Drive 토큰이 만료됐어요.', 'other');
	if (!GOOGLE_CLIENT_ID) throw new DriveAuthError('Google 클라이언트 ID 가 설정되지 않았어요.', 'no_client_id');
	await loadGis();
	const first = !hasStoredToken();
	return new Promise<string>((resolve, reject) => {
		const client = window.google!.accounts.oauth2.initTokenClient({
			client_id: GOOGLE_CLIENT_ID,
			scope: SCOPE,
			callback: (r) => {
				if (r.error || !r.access_token) {
					reject(
						new DriveAuthError(
							r.error_description || r.error || 'Google 인증에 실패했어요.',
							r.error === 'access_denied' ? 'denied' : 'other'
						)
					);
					return;
				}
				const t: StoredToken = {
					accessToken: r.access_token,
					expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000
				};
				store(t);
				resolve(t.accessToken);
			},
			error_callback: (e) => {
				reject(
					new DriveAuthError(
						e.message || e.type,
						e.type === 'popup_failed_to_open' ? 'popup_blocked' : e.type === 'popup_closed' ? 'denied' : 'other'
					)
				);
			}
		});
		client.requestAccessToken({ prompt: first ? 'consent' : '' });
	});
}

// ── Drive REST ───────────────────────────────────────────────
export interface DriveFile {
	id: string;
	name: string;
	size: number;
	modifiedTime: string;
	md5Checksum?: string;
	/** 앱 전용 메타(appProperties). DB 파일엔 마지막으로 쓴 기기 `deviceId`/`deviceName` 을 남긴다. */
	appProperties?: Record<string, string>;
}

export class DriveHttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
	const res = await fetch(url, {
		...init,
		headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }
	});
	if (res.status === 401) {
		store(null); // 만료·취소 → 다음 ensureToken 이 재발급
		throw new DriveHttpError(401, 'Drive 인증이 만료됐어요.');
	}
	if (!res.ok) {
		let msg = `Drive 요청 실패 (${res.status})`;
		try {
			const j = (await res.json()) as { error?: { message?: string } };
			if (j.error?.message) msg = j.error.message;
		} catch {
			/* non-json */
		}
		throw new DriveHttpError(res.status, msg);
	}
	return res;
}

const FIELDS = 'id,name,size,modifiedTime,md5Checksum,appProperties';

function toFile(f: Record<string, unknown>): DriveFile {
	return {
		id: String(f.id),
		name: String(f.name),
		size: Number(f.size ?? 0),
		modifiedTime: String(f.modifiedTime ?? ''),
		md5Checksum: typeof f.md5Checksum === 'string' ? f.md5Checksum : undefined,
		appProperties:
			f.appProperties && typeof f.appProperties === 'object'
				? (f.appProperties as Record<string, string>)
				: undefined
	};
}

/** Drive 전체 저장 용량(바이트). limit 은 무제한 계정이면 null. */
export async function getQuota(token: string): Promise<{ limit: number | null; usage: number }> {
	const res = await call(token, `${API}/about?fields=storageQuota`);
	const j = (await res.json()) as { storageQuota?: { limit?: string; usage?: string } };
	const q = j.storageQuota ?? {};
	return { limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage ?? 0) };
}

/** appDataFolder 의 전체 파일 목록(페이지 순회). */
export async function listAll(token: string): Promise<DriveFile[]> {
	const out: DriveFile[] = [];
	let pageToken: string | undefined;
	do {
		const q = new URLSearchParams({
			spaces: 'appDataFolder',
			pageSize: '1000',
			fields: `nextPageToken,files(${FIELDS})`
		});
		if (pageToken) q.set('pageToken', pageToken);
		const res = await call(token, `${API}/files?${q}`);
		const j = (await res.json()) as { files?: Record<string, unknown>[]; nextPageToken?: string };
		for (const f of j.files ?? []) out.push(toFile(f));
		pageToken = j.nextPageToken;
	} while (pageToken);
	return out;
}

function multipart(meta: Record<string, unknown>, blob: Blob, contentType: string): FormData {
	const body = new FormData();
	body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
	body.append('file', new Blob([blob], { type: contentType }));
	return body;
}

/** 이름으로 파일 1개 찾기(appDataFolder, 요청 1회). 없으면 null. */
export async function findByName(token: string, name: string): Promise<DriveFile | null> {
	const q = new URLSearchParams({
		spaces: 'appDataFolder',
		q: `name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
		pageSize: '1',
		fields: `files(${FIELDS})`
	});
	const res = await call(token, `${API}/files?${q}`);
	const j = (await res.json()) as { files?: Record<string, unknown>[] };
	const f = j.files?.[0];
	return f ? toFile(f) : null;
}

/** `since`(epoch ms) 이후에 바뀐 파일만(appDataFolder, 페이지 순회 — 보통 1회). 증분 인덱스 갱신용. */
export async function listChangedSince(token: string, since: number): Promise<DriveFile[]> {
	const out: DriveFile[] = [];
	let pageToken: string | undefined;
	do {
		const q = new URLSearchParams({
			spaces: 'appDataFolder',
			q: `modifiedTime > '${new Date(since).toISOString()}' and trashed = false`,
			pageSize: '1000',
			fields: `nextPageToken,files(${FIELDS})`
		});
		if (pageToken) q.set('pageToken', pageToken);
		const res = await call(token, `${API}/files?${q}`);
		const j = (await res.json()) as { files?: Record<string, unknown>[]; nextPageToken?: string };
		for (const f of j.files ?? []) out.push(toFile(f));
		pageToken = j.nextPageToken;
	} while (pageToken);
	return out;
}

/** 새 파일 생성(multipart). `appProperties` 는 선택(DB 파일의 작성 기기 표시용). */
export async function createFile(
	token: string,
	name: string,
	blob: Blob,
	contentType: string,
	appProperties?: Record<string, string>
): Promise<DriveFile> {
	const meta: Record<string, unknown> = { name, parents: ['appDataFolder'] };
	if (appProperties) meta.appProperties = appProperties;
	const res = await call(token, `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
		method: 'POST',
		body: multipart(meta, blob, contentType)
	});
	return toFile((await res.json()) as Record<string, unknown>);
}

/** 기존 파일 내용 교체. `appProperties` 를 주면 메타까지 한 요청(multipart)으로 갱신, 없으면 media 만. */
export async function updateFile(
	token: string,
	id: string,
	blob: Blob,
	contentType: string,
	appProperties?: Record<string, string>
): Promise<DriveFile> {
	const res = appProperties
		? await call(token, `${UPLOAD}/files/${id}?uploadType=multipart&fields=${FIELDS}`, {
				method: 'PATCH',
				body: multipart({ appProperties }, blob, contentType)
			})
		: await call(token, `${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, {
				method: 'PATCH',
				headers: { 'content-type': contentType },
				body: blob
			});
	return toFile((await res.json()) as Record<string, unknown>);
}

export async function getMeta(token: string, id: string): Promise<DriveFile | null> {
	try {
		const res = await call(token, `${API}/files/${id}?fields=${FIELDS}`);
		return toFile((await res.json()) as Record<string, unknown>);
	} catch (e) {
		if (e instanceof DriveHttpError && e.status === 404) return null;
		throw e;
	}
}

export async function download(token: string, id: string): Promise<Blob> {
	const res = await call(token, `${API}/files/${id}?alt=media`);
	return res.blob();
}

export async function deleteFile(token: string, id: string): Promise<void> {
	try {
		await call(token, `${API}/files/${id}`, { method: 'DELETE' });
	} catch (e) {
		if (e instanceof DriveHttpError && e.status === 404) return;
		throw e;
	}
}
