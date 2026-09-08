/**
 * OneDrive 클라이언트 — 브라우저 전용(서버 없음). 2026-09-09 Google Drive 에서 이전.
 *
 *  - 인증: Microsoft identity platform **SPA 코드 플로우(PKCE)** — MSAL(`@azure/msal-browser`, 동적 import).
 *    시크릿 없이 refresh token 을 받고 토큰 엔드포인트가 CORS 를 열어 두어 **팝업 없이 갱신**된다(Google 은 웹 클라이언트에
 *    client_secret 을 요구해 서버 없인 불가능했다). SPA refresh token 은 24시간이 지나면 MSAL 이 숨은 iframe(`auth.html`)으로
 *    재발급하는데 서드파티 쿠키가 막힌 브라우저(Safari·iOS)에선 실패 → 그때만 '지금 동기화' 로그인(하루 1회).
 *    스코프 `Files.ReadWrite.AppFolder` — 앱 전용 폴더(`/me/drive/special/approot`, 'Apps/<앱 이름>')만 접근.
 *  - 저장: 앱 폴더 아래 키를 **경로 그대로**(`char/<id>.webp` → `approot:/char/<id>.webp:`) + DB 스냅샷 `haven.sqlite`.
 *  - 변경 감지: 파일 `cTag`(내용 태그 — 내용이 바뀔 때만 변함). 덮어쓰기 방지는 `If-Match: <eTag>` 조건부 업로드(412 → 충돌).
 *  - 목록: delta 조회(`approot/delta`) — 처음엔 전체, 이후 `@odata.deltaLink` 로 바뀐 것만(삭제 포함).
 *  - 작성 기기 표시: DB 파일의 `description` 에 JSON `{deviceId, deviceName}` (OneDrive 개인용은 파일 description 쓰기 가능).
 *
 * Entra(Azure) 앱 등록: 지원 계정 유형 = 개인 Microsoft 계정(또는 모든 계정 + 개인), 플랫폼 = **단일 페이지 애플리케이션**,
 * 리디렉트 URI = `https://havenchats.com/auth.html`, `https://havenchats.com/`, `http://localhost:5173/auth.html`,
 * `http://localhost:5173/`. 클라이언트 시크릿 없음. API 권한 Files.ReadWrite.AppFolder(위임) 은 첫 로그인 때 동의.
 */
import { env } from '$env/dynamic/public';
import type * as Msal from '@azure/msal-browser';
import { kvDelete, kvSet } from './idb';

/** Entra 앱(클라이언트) ID — 공개 식별자. 빌드 env PUBLIC_MS_CLIENT_ID 로 덮어쓸 수 있다. */
const DEFAULT_CLIENT_ID = '';
export const MS_CLIENT_ID = env.PUBLIC_MS_CLIENT_ID || DEFAULT_CLIENT_ID;

const AUTHORITY = 'https://login.microsoftonline.com/common';
const SCOPES = ['Files.ReadWrite.AppFolder'];
/** 서비스워커(static/img-sw.js)가 지연 다운로드에 쓰는 kv 키(액세스 토큰 복사본). */
export const TOKEN_KV_KEY = 'od:token';
const RETURN_KEY = 'haven:od:returnTo';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const APPROOT = `${GRAPH}/me/drive/special/approot`;
const SELECT = 'id,name,size,lastModifiedDateTime,cTag,eTag,file,folder,deleted,parentReference,description';
/** 단순 업로드 상한(Graph 4MB). 넘으면 업로드 세션. */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** 업로드 세션 조각 크기(320KiB 의 배수). */
const CHUNK = 32 * 320 * 1024;
/** 만료 이 시간 전이면 갱신 시도. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** 조용한 갱신이 '상호작용 필요' 로 실패하면 이 시간 동안은 다시 시도하지 않는다(주기 확인마다 iframe 을 띄우지 않게). */
const SILENT_BACKOFF_MS = 5 * 60 * 1000;

export class CloudAuthError extends Error {
	constructor(
		message: string,
		readonly kind: 'popup_blocked' | 'denied' | 'no_client_id' | 'other' = 'other'
	) {
		super(message);
	}
}

export class CloudHttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

// ── 인증 ────────────────────────────────────────────────────

interface Cached {
	accessToken: string;
	expiresAt: number;
}

let msal: Msal.PublicClientApplication | null = null;
let msalLoading: Promise<Msal.PublicClientApplication> | null = null;
let msalMod: typeof Msal | null = null;
let cached: Cached | null = null;
let silentFailedAt = 0;
let silentInFlight: Promise<string | null> | null = null;

async function client(): Promise<Msal.PublicClientApplication> {
	if (msal) return msal;
	if (!MS_CLIENT_ID) throw new CloudAuthError('Microsoft 클라이언트 ID 가 설정되지 않았어요.', 'no_client_id');
	return (msalLoading ??= (async () => {
		const mod = await import('@azure/msal-browser');
		msalMod = mod;
		const app = new mod.PublicClientApplication({
			auth: {
				clientId: MS_CLIENT_ID,
				authority: AUTHORITY,
				redirectUri: `${location.origin}/auth.html`,
				postLogoutRedirectUri: `${location.origin}/`
			},
			cache: { cacheLocation: 'localStorage' },
			system: { allowPlatformBroker: false }
		});
		await app.initialize();
		msal = app;
		return app;
	})());
}

function account(app: Msal.PublicClientApplication): Msal.AccountInfo | null {
	const active = app.getActiveAccount();
	if (active) return active;
	const all = app.getAllAccounts();
	if (all[0]) app.setActiveAccount(all[0]);
	return all[0] ?? null;
}

function remember(r: Msal.AuthenticationResult): string {
	cached = { accessToken: r.accessToken, expiresAt: r.expiresOn?.getTime() ?? Date.now() + 3600_000 };
	if (r.account) msal?.setActiveAccount(r.account);
	silentFailedAt = 0;
	void kvSet(TOKEN_KV_KEY, cached).catch(() => {});
	return r.accessToken;
}

/** 유효한(만료 여유 있는) 토큰이 메모리에 있으면 반환, 없으면 null(요청 없음). */
export function currentToken(): string | null {
	if (!cached) return null;
	if (cached.expiresAt - Date.now() < REFRESH_MARGIN_MS) return null;
	return cached.accessToken;
}

/** 로그인한 적이 있는지(MSAL 캐시에 계정이 있는지 — '연결한 적 있음' 판단용). 동기 확인은 localStorage 키로. */
export function hasStoredToken(): boolean {
	try {
		return Object.keys(localStorage).some((k) => k.startsWith('msal.account.keys') || k.includes('-login.windows.net-'));
	} catch {
		return false;
	}
}

/** 앱 시작 시 1회: 리디렉트 로그인에서 돌아온 경우 결과를 처리한다(해시의 code 교환). 돌아갈 경로가 있으면 반환. */
export async function handleRedirect(): Promise<string | null> {
	if (!MS_CLIENT_ID) return null;
	if (!location.hash.includes('code=') && !location.hash.includes('error=')) return null;
	try {
		const app = await client();
		// 돌아갈 경로는 sessionStorage 로 직접 관리(MSAL 의 loginRequestUrl 복귀는 끔).
		const r = await app.handleRedirectPromise({ navigateToLoginRequestUrl: false });
		if (r) remember(r);
	} catch (e) {
		console.warn('[onedrive] 리디렉트 처리 실패', e);
	}
	try {
		const back = sessionStorage.getItem(RETURN_KEY);
		sessionStorage.removeItem(RETURN_KEY);
		return back;
	} catch {
		return null;
	}
}

/**
 * 팝업 없이 쓸 수 있는 토큰. 메모리에 유효한 게 있으면 그대로, 아니면 MSAL 조용한 갱신(캐시 → refresh token → 숨은 iframe).
 * 실패하면 null(재연결 필요). 동시 호출은 하나로 합친다.
 */
export async function silentToken(): Promise<string | null> {
	const cur = currentToken();
	if (cur) return cur;
	if (!MS_CLIENT_ID) return null;
	if (Date.now() - silentFailedAt < SILENT_BACKOFF_MS) return null;
	return (silentInFlight ??= (async () => {
		try {
			const app = await client();
			const acc = account(app);
			if (!acc) return null;
			const r = await app.acquireTokenSilent({ scopes: SCOPES, account: acc, redirectUri: `${location.origin}/auth.html` });
			return remember(r);
		} catch (e) {
			silentFailedAt = Date.now();
			console.warn('[onedrive] 조용한 토큰 갱신 실패 → 재연결 필요', e);
			return null;
		} finally {
			silentInFlight = null;
		}
	})());
}

/**
 * 액세스 토큰 확보. 조용한 갱신이 안 되면 로그인 팝업, 팝업이 막히면(모바일 등) 페이지 리디렉트(돌아오면 `handleRedirect`).
 * @param interactive false 면 팝업 없이(조용한 갱신만).
 */
export async function ensureToken(interactive = true): Promise<string> {
	const cur = await silentToken();
	if (cur) return cur;
	if (!interactive) throw new CloudAuthError('OneDrive 로그인이 만료됐어요.', 'other');
	const app = await client();
	const acc = account(app);
	const req: Msal.PopupRequest = { scopes: SCOPES, account: acc ?? undefined, prompt: acc ? undefined : 'select_account' };
	try {
		const r = await app.acquireTokenPopup(req);
		return remember(r);
	} catch (e) {
		const code = (e as { errorCode?: string }).errorCode ?? '';
		if (code === 'user_cancelled') {
			throw new CloudAuthError('로그인이 취소됐어요.', 'denied');
		}
		if (code === 'popup_window_error' || code === 'empty_window_error' || code === 'block_iframe_reload') {
			// 팝업 불가 → 전체 페이지 리디렉트. 돌아오면 initStorage 의 handleRedirect 가 처리하고 원래 경로로 복귀.
			try {
				sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
			} catch {
				/* ignore */
			}
			await app.acquireTokenRedirect({ ...req, redirectUri: `${location.origin}/` });
			// 여기 도달하지 않음(페이지 이동). 혹시 남아 있으면:
			throw new CloudAuthError('로그인 페이지로 이동 중…', 'other');
		}
		if (msalMod && e instanceof msalMod.InteractionRequiredAuthError) {
			throw new CloudAuthError(e.errorMessage || '로그인이 필요해요.', 'other');
		}
		throw new CloudAuthError(e instanceof Error ? e.message : String(e), 'other');
	}
}

/** 로그아웃(로컬 MSAL 캐시만 정리 — 서버 세션은 그대로, 페이지 이동 없음). */
export function forgetToken(): void {
	cached = null;
	silentFailedAt = 0;
	void kvDelete(TOKEN_KV_KEY).catch(() => {});
	if (!msal) {
		try {
			for (const k of Object.keys(localStorage)) if (k.startsWith('msal.')) localStorage.removeItem(k);
		} catch {
			/* ignore */
		}
		return;
	}
	const acc = account(msal);
	void msal.clearCache(acc ? { account: acc } : undefined).catch(() => {});
	msal.setActiveAccount(null);
}

// ── Graph REST ───────────────────────────────────────────────

export interface CloudFile {
	id: string;
	/** 앱 폴더 기준 경로(= 저장소 키, 예 `char/<id>.webp`). */
	name: string;
	size: number;
	modifiedTime: string;
	/** 내용 태그(cTag) — 내용이 바뀔 때만 변한다. 변경 감지용. */
	rev?: string;
	/** eTag — 조건부 업로드(If-Match)용. */
	etag?: string;
	/** DB 파일 description 의 JSON(작성 기기). */
	props?: Record<string, string>;
}

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
	const res = await fetch(url, {
		...init,
		headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }
	});
	if (res.status === 401) {
		cached = null;
		throw new CloudHttpError(401, 'OneDrive 로그인이 만료됐어요.');
	}
	if (!res.ok) {
		let msg = `OneDrive 요청 실패 (${res.status})`;
		try {
			const j = (await res.json()) as { error?: { message?: string; code?: string } };
			if (j.error?.message) msg = `${j.error.code ? j.error.code + ': ' : ''}${j.error.message}`;
		} catch {
			/* non-json */
		}
		throw new CloudHttpError(res.status, msg);
	}
	return res;
}

function encodePath(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/');
}

/** 경로 주소: `approot:/a/b.webp:` (뒤에 `/content` 등을 붙인다). */
function byPath(key: string): string {
	return `${APPROOT}:/${encodePath(key)}:`;
}

function parseProps(desc: unknown): Record<string, string> | undefined {
	if (typeof desc !== 'string' || !desc.startsWith('{')) return undefined;
	try {
		const j = JSON.parse(desc) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(j)) if (typeof v === 'string') out[k] = v;
		return out;
	} catch {
		return undefined;
	}
}

interface Item {
	id: string;
	name: string;
	size?: number;
	lastModifiedDateTime?: string;
	cTag?: string;
	eTag?: string;
	file?: unknown;
	folder?: unknown;
	deleted?: unknown;
	description?: string;
	parentReference?: { path?: string; id?: string };
	'@microsoft.graph.downloadUrl'?: string;
}

function toFile(it: Item, name: string): CloudFile {
	return {
		id: it.id,
		name,
		size: Number(it.size ?? 0),
		modifiedTime: it.lastModifiedDateTime ?? '',
		rev: it.cTag,
		etag: it.eTag,
		props: parseProps(it.description)
	};
}

let approotPath: string | null = null;

/** 앱 폴더의 드라이브 경로(`/drive/root:/Apps/Haven`). delta 항목의 parentReference.path 에서 키를 뽑을 때 쓴다. */
async function getApprootPath(token: string): Promise<string> {
	if (approotPath) return approotPath;
	const res = await call(token, `${APPROOT}?$select=id,name,parentReference`);
	const it = (await res.json()) as Item;
	approotPath = `${it.parentReference?.path ?? '/drive/root:'}/${it.name}`;
	return approotPath;
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** delta 항목 → 앱 폴더 기준 키. 앱 폴더 밖·폴더 자체면 null. */
function keyOf(it: Item, root: string): string | null {
	if (!it.file) return null;
	const p = it.parentReference?.path;
	if (!p) return null;
	const dp = safeDecode(p);
	const dr = safeDecode(root);
	if (dp !== dr && !dp.startsWith(dr + '/')) return null;
	const rel = dp.length > dr.length ? dp.slice(dr.length + 1) : '';
	return rel ? `${rel}/${it.name}` : it.name;
}

export interface DeltaResult {
	/** 존재하는 파일(변경분 조회면 바뀐 것만). */
	files: CloudFile[];
	/** 지워진 파일 키(변경분 조회에서만). */
	deleted: string[];
	/** 다음 변경분 조회에 쓸 링크. */
	deltaLink: string;
}

/**
 * delta 조회. `link` 없으면 앱 폴더 전체(첫 연결·복구), 있으면 그 뒤 바뀐 것만(삭제 포함).
 * `link` 가 만료(410)됐으면 전체를 다시 받는다.
 */
export async function delta(token: string, link?: string | null): Promise<DeltaResult> {
	const root = await getApprootPath(token);
	const files: CloudFile[] = [];
	const deleted: string[] = [];
	let url = link || `${APPROOT}/delta?$select=${SELECT}&$top=1000`;
	let deltaLink = '';
	for (;;) {
		let res: Response;
		try {
			res = await call(token, url);
		} catch (e) {
			if (link && e instanceof CloudHttpError && (e.status === 410 || e.status === 400)) return delta(token, null);
			throw e;
		}
		const j = (await res.json()) as { value?: Item[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
		for (const it of j.value ?? []) {
			if (it.deleted) {
				// 지워진 항목은 parentReference.path 가 없을 수 있어 id 로만 안다 → 호출부가 인덱스의 id 로 대조한다.
				deleted.push(it.id);
				continue;
			}
			const key = keyOf(it, root);
			if (key) files.push(toFile(it, key));
		}
		if (j['@odata.nextLink']) {
			url = j['@odata.nextLink'];
			continue;
		}
		deltaLink = j['@odata.deltaLink'] ?? '';
		break;
	}
	return { files, deleted, deltaLink };
}

/** 앱 폴더 전체 파일 목록(delta 전체 조회). */
export async function listAll(token: string): Promise<CloudFile[]> {
	return (await delta(token, null)).files;
}

/** 드라이브 용량(바이트). */
export async function getQuota(token: string): Promise<{ limit: number | null; usage: number }> {
	const res = await call(token, `${GRAPH}/me/drive?$select=quota`);
	const j = (await res.json()) as { quota?: { total?: number; used?: number } };
	return { limit: j.quota?.total ?? null, usage: j.quota?.used ?? 0 };
}

/** 키(경로)로 파일 메타 1개. 없으면 null. */
export async function findByName(token: string, key: string): Promise<CloudFile | null> {
	try {
		const res = await call(token, `${byPath(key)}?$select=${SELECT}`);
		return toFile((await res.json()) as Item, key);
	} catch (e) {
		if (e instanceof CloudHttpError && e.status === 404) return null;
		throw e;
	}
}

/** id 로 파일 메타. 없으면 null. `name` 은 호출부가 아는 키를 넣는다. */
export async function getMeta(token: string, id: string, name = ''): Promise<CloudFile | null> {
	try {
		const res = await call(token, `${GRAPH}/me/drive/items/${id}?$select=${SELECT}`);
		const it = (await res.json()) as Item;
		if (it.deleted) return null;
		return toFile(it, name || it.name);
	} catch (e) {
		if (e instanceof CloudHttpError && e.status === 404) return null;
		throw e;
	}
}

const folderCache = new Set<string>();

/** 상위 폴더 체인을 만든다(없으면 생성, 있으면 통과). */
async function ensureFolders(token: string, dir: string): Promise<void> {
	if (!dir || folderCache.has(dir)) return;
	const parts = dir.split('/');
	for (let i = 1; i <= parts.length; i++) {
		const path = parts.slice(0, i).join('/');
		if (folderCache.has(path)) continue;
		const parent = i === 1 ? APPROOT : byPath(parts.slice(0, i - 1).join('/'));
		await call(token, `${parent}/children`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: parts[i - 1], folder: {}, '@microsoft.graph.conflictBehavior': 'replace' })
		});
		folderCache.add(path);
	}
}

export class PreconditionFailed extends CloudHttpError {
	constructor() {
		super(412, '다른 기기가 먼저 올렸어요.');
	}
}

/**
 * 파일 업로드(생성/교체). 4MB 이하는 단순 PUT, 넘으면 업로드 세션(조각).
 * `ifMatch`(eTag) 를 주면 원격이 그 사이 바뀌었을 때 412 → `PreconditionFailed`.
 * `props` 를 주면 업로드 뒤 description 에 JSON 으로 기록(작성 기기 표시, 실패해도 무시).
 */
export async function upload(
	token: string,
	key: string,
	blob: Blob,
	contentType: string,
	opts: { ifMatch?: string; props?: Record<string, string> } = {}
): Promise<CloudFile> {
	const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
	let item: Item;
	const attempt = async (): Promise<Item> => {
		if (blob.size <= SIMPLE_UPLOAD_MAX) {
			const headers: Record<string, string> = { 'content-type': contentType || 'application/octet-stream' };
			if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
			const res = await call(token, `${byPath(key)}/content`, { method: 'PUT', headers, body: blob });
			return (await res.json()) as Item;
		}
		return uploadLarge(token, key, blob, opts.ifMatch);
	};
	try {
		item = await attempt();
	} catch (e) {
		if (e instanceof CloudHttpError && e.status === 412) throw new PreconditionFailed();
		if (e instanceof CloudHttpError && e.status === 404 && dir) {
			await ensureFolders(token, dir);
			try {
				item = await attempt();
			} catch (e2) {
				if (e2 instanceof CloudHttpError && e2.status === 412) throw new PreconditionFailed();
				throw e2;
			}
		} else {
			throw e;
		}
	}
	if (opts.props) {
		try {
			const res = await call(token, `${GRAPH}/me/drive/items/${item.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ description: JSON.stringify(opts.props) })
			});
			item = (await res.json()) as Item;
		} catch (e) {
			console.warn('[onedrive] description 기록 실패(무시)', e);
		}
	}
	return toFile(item, key);
}

async function uploadLarge(token: string, key: string, blob: Blob, ifMatch?: string): Promise<Item> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (ifMatch) headers['if-match'] = ifMatch;
	const res = await call(token, `${byPath(key)}/createUploadSession`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
	});
	const { uploadUrl } = (await res.json()) as { uploadUrl: string };
	let last: Item | null = null;
	for (let start = 0; start < blob.size; start += CHUNK) {
		const end = Math.min(start + CHUNK, blob.size);
		// uploadUrl 은 사전 인증 URL — Authorization 헤더를 붙이지 않는다.
		const r = await fetch(uploadUrl, {
			method: 'PUT',
			headers: { 'content-range': `bytes ${start}-${end - 1}/${blob.size}` },
			body: blob.slice(start, end)
		});
		if (!r.ok) throw new CloudHttpError(r.status, `업로드 조각 실패 (${r.status})`);
		if (r.status === 200 || r.status === 201) last = (await r.json()) as Item;
	}
	if (!last) throw new CloudHttpError(500, '업로드 세션이 완료되지 않았어요.');
	return last;
}

/** 파일 다운로드(id). 사전 인증 downloadUrl 을 받아 인증 헤더 없이 받는다(CORS). */
export async function download(token: string, id: string): Promise<Blob> {
	const res = await call(token, `${GRAPH}/me/drive/items/${id}?$select=id,@microsoft.graph.downloadUrl`);
	const it = (await res.json()) as Item;
	const url = it['@microsoft.graph.downloadUrl'];
	if (!url) throw new CloudHttpError(404, '다운로드 주소가 없어요.');
	const r = await fetch(url);
	if (!r.ok) throw new CloudHttpError(r.status, `다운로드 실패 (${r.status})`);
	return r.blob();
}

export async function deleteFile(token: string, id: string): Promise<void> {
	try {
		await call(token, `${GRAPH}/me/drive/items/${id}`, { method: 'DELETE' });
	} catch (e) {
		if (e instanceof CloudHttpError && e.status === 404) return;
		throw e;
	}
}
