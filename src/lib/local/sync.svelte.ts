/**
 * 저장소 모드 + Google Drive 동기화 엔진(반응형 상태 포함).
 *
 * 모드(localStorage `haven:storage`):
 *  - 'local' : 이 기기(IndexedDB)에만 저장.
 *  - 'drive' : IndexedDB 를 캐시로 두고 Google Drive appDataFolder 와 동기화(원본 = Drive).
 *  - 미설정  : 랜딩(StorageLanding)에서 고른다.
 *
 * 동기화 단위: DB 스냅샷 `haven.sqlite` 통째 1파일 + 이미지 파일(name = R2 키).
 * 로컬 스냅샷이 저장될 때(runtime.onDatabaseSaved) dirty 표시 → 디바운스 후 Drive 에 업로드.
 * 이미지 put/delete(runtime.onObjectsChanged)는 대기열(IndexedDB 에 영속)에 넣고 같이 처리한다.
 *
 * 충돌: 시작 시 원격 DB 의 md5 가 마지막 동기화 기록과 다르고(다른 기기가 씀) 로컬도 dirty 면
 * 자동으로 고르지 않고 `conflict` 를 띄워 유저가 고른다(1인 사용이라 드묾).
 */
import { invalidateAll } from '$app/navigation';
import { kvGet, kvSet, kvDelete, objGet, objKeys, objPut, type StoredObject } from './idb';
import {
	getLocalRuntime,
	onDatabaseSaved,
	onObjectsChanged,
	type LocalRuntime
} from './runtime';
import {
	createFile,
	deleteFile,
	download,
	ensureToken,
	forgetToken,
	hasStoredToken,
	listAll,
	getQuota,
	updateFile,
	currentToken,
	DriveAuthError,
	DriveHttpError,
	GOOGLE_CLIENT_ID,
	type DriveFile
} from './drive';

export type StorageMode = 'unset' | 'local' | 'drive';
export type SyncStatus = 'off' | 'syncing' | 'idle' | 'needs-auth' | 'error';

const MODE_KEY = 'haven:storage';
const DB_NAME = 'haven.sqlite';
const PUSH_DEBOUNCE_MS = 3000;
/** 이미지 업로드/다운로드 동시 수. */
const PARALLEL = 4;

// IndexedDB kv 키
const K_INDEX = 'drive:index'; // Record<name, {id, md5}>
const K_DB = 'drive:db'; // {id, md5} — 마지막 push/pull 시점의 원격 DB
const K_DIRTY = 'drive:dbDirty';
const K_PUTS = 'drive:pendingPuts';
const K_DELS = 'drive:pendingDeletes';
const K_LAST = 'drive:lastSyncAt';

interface RemoteRef {
	id: string;
	md5?: string;
}

function readMode(): StorageMode {
	try {
		const v = localStorage.getItem(MODE_KEY);
		return v === 'local' || v === 'drive' ? v : 'unset';
	} catch {
		return 'unset';
	}
}

const initialMode = readMode();

export const sync = $state({
	mode: initialMode as StorageMode,
	status: 'off' as SyncStatus,
	/** 진행 설명(랜딩·모달 표시용). */
	phase: '',
	/** 초기 동기화(또는 로컬 모드 선택)가 끝나 앱을 렌더해도 되는지. 로컬 모드는 즉시. */
	ready: initialMode === 'local',
	pending: 0,
	lastSyncAt: null as number | null,
	error: null as string | null,
	conflict: null as null | { remoteModified: string },
	clientIdMissing: !GOOGLE_CLIENT_ID
});

let rt: LocalRuntime | null = null;
let index: Record<string, RemoteRef> = {};
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let hooked = false;

function writeMode(m: StorageMode) {
	sync.mode = m;
	try {
		if (m === 'unset') localStorage.removeItem(MODE_KEY);
		else localStorage.setItem(MODE_KEY, m);
	} catch {
		/* ignore */
	}
}

async function refreshPendingCount() {
	const puts = (await kvGet<string[]>(K_PUTS)) ?? [];
	const dels = (await kvGet<string[]>(K_DELS)) ?? [];
	const dirty = (await kvGet<boolean>(K_DIRTY)) ?? false;
	sync.pending = puts.length + dels.length + (dirty ? 1 : 0);
}

/** 앱 시작 시(런타임 부팅 후) 호출. Drive 모드면 초기 동기화를 시도한다. */
export async function initStorage(): Promise<void> {
	rt = getLocalRuntime();
	sync.mode = readMode();
	sync.lastSyncAt = (await kvGet<number>(K_LAST)) ?? null;
	index = (await kvGet<Record<string, RemoteRef>>(K_INDEX)) ?? {};
	await refreshPendingCount();
	hookRuntime();
	// 로컬에 없는 이미지(다른 기기에서 만든 것)는 볼 때 Drive 에서 내려받는다.
	rt.r2.setMissHandler((key) => (sync.mode === 'drive' ? fetchImageFromDrive(key) : Promise.resolve(null)));

	if (sync.mode === 'local') {
		sync.status = 'off';
		sync.ready = true;
		return;
	}
	if (sync.mode === 'drive') {
		if (currentToken()) {
			await runInitialSync();
		} else {
			// 토큰 만료 — 팝업은 제스처가 필요하니 랜딩에서 '다시 연결' 을 누르게 한다.
			sync.status = 'needs-auth';
			sync.ready = false;
		}
	}
}

function hookRuntime() {
	if (hooked) return;
	hooked = true;
	onDatabaseSaved(() => {
		if (sync.mode !== 'drive') return;
		void kvSet(K_DIRTY, true).then(refreshPendingCount);
		schedulePush();
	});
	onObjectsChanged((kind, keys) => {
		if (sync.mode !== 'drive') return;
		void enqueue(kind === 'put' ? K_PUTS : K_DELS, keys, kind === 'put' ? K_DELS : K_PUTS).then(() => {
			void refreshPendingCount();
			schedulePush();
		});
	});
	window.addEventListener('online', () => {
		if (sync.mode === 'drive' && sync.pending > 0) schedulePush(500);
	});
}

async function enqueue(key: string, keys: string[], oppositeKey: string) {
	const cur = new Set((await kvGet<string[]>(key)) ?? []);
	for (const k of keys) cur.add(k);
	await kvSet(key, [...cur]);
	// 같은 키가 반대 대기열에 있으면 제거(put 후 delete, delete 후 put 정리)
	const opp = (await kvGet<string[]>(oppositeKey)) ?? [];
	const filtered = opp.filter((k) => !keys.includes(k));
	if (filtered.length !== opp.length) await kvSet(oppositeKey, filtered);
}

function schedulePush(delay = PUSH_DEBOUNCE_MS) {
	if (pushTimer) clearTimeout(pushTimer);
	pushTimer = setTimeout(() => {
		pushTimer = null;
		void flush();
	}, delay);
}

// ── 사용자 액션 ──────────────────────────────────────────────
/** 랜딩: 이 기기에만 저장. */
export function chooseLocal(): void {
	writeMode('local');
	sync.status = 'off';
	sync.ready = true;
}

/** 랜딩/설정: Drive 연결(유저 제스처 안에서 호출 — GIS 팝업). */
export async function connectDrive(): Promise<void> {
	sync.error = null;
	try {
		await ensureToken(true);
	} catch (e) {
		sync.error = e instanceof Error ? e.message : String(e);
		sync.status = 'needs-auth';
		return;
	}
	writeMode('drive');
	await runInitialSync();
}

/** Drive 연결 해제(로컬 데이터는 그대로, 원격 파일도 지우지 않음). */
export async function disconnectDrive(): Promise<void> {
	forgetToken();
	writeMode('local');
	index = {};
	await Promise.all([kvDelete(K_INDEX), kvDelete(K_DB), kvDelete(K_DIRTY), kvDelete(K_PUTS), kvDelete(K_DELS)]);
	sync.status = 'off';
	sync.pending = 0;
	sync.conflict = null;
	sync.ready = true;
}

/** 로컬 모드에서 '오프라인으로 계속'(토큰 만료 상태로 앱 진입 — 변경은 대기열에 쌓임). */
export function continueOffline(): void {
	sync.ready = true;
}

/** 충돌 해결: 'remote' = Drive 것으로 로컬 덮어쓰기, 'local' = 이 기기 것으로 Drive 덮어쓰기. */
export async function resolveConflict(pick: 'remote' | 'local'): Promise<void> {
	if (!sync.conflict) return;
	sync.conflict = null;
	await run(async (token) => {
		sync.phase = pick === 'remote' ? 'Drive 데이터 받는 중…' : 'Drive 에 올리는 중…';
		if (pick === 'remote') await pullDb(token);
		else await pushDb(token);
		await syncImages(token);
		await finishOk();
	});
}

/** 수동 '지금 동기화'(제스처 안). 토큰이 만료됐으면 팝업으로 갱신. */
export async function syncNow(): Promise<void> {
	if (sync.mode !== 'drive') return;
	try {
		await ensureToken(true);
	} catch (e) {
		sync.error = e instanceof Error ? e.message : String(e);
		sync.status = 'needs-auth';
		return;
	}
	if (!sync.ready) await runInitialSync();
	else await flush();
}

/** 유저 제스처 안에서 호출 — 토큰 만료가 임박했으면 미리 갱신(팝업이 바로 닫힘). */
export function refreshTokenInGesture(): void {
	if (sync.mode !== 'drive' || !hasStoredToken() || currentToken()) return;
	void ensureToken(true)
		.then(() => {
			if (sync.status === 'needs-auth') schedulePush(0);
		})
		.catch(() => {});
}

// ── 엔진 ────────────────────────────────────────────────────
async function run(job: (token: string) => Promise<void>): Promise<void> {
	if (running) await running.catch(() => {});
	running = (async () => {
		let token: string;
		try {
			token = await ensureToken(false);
		} catch {
			sync.status = 'needs-auth';
			return;
		}
		sync.status = 'syncing';
		sync.error = null;
		try {
			await job(token);
		} catch (e) {
			if (e instanceof DriveHttpError && e.status === 401) {
				sync.status = 'needs-auth';
			} else if (e instanceof DriveAuthError) {
				sync.status = 'needs-auth';
				sync.error = e.message;
			} else {
				sync.status = 'error';
				sync.error = e instanceof Error ? e.message : String(e);
				console.error('[sync]', e);
			}
		} finally {
			sync.phase = '';
			await refreshPendingCount();
		}
	})();
	await running;
	running = null;
}

async function finishOk() {
	sync.lastSyncAt = Date.now();
	await kvSet(K_LAST, sync.lastSyncAt);
	sync.status = 'idle';
	sync.ready = true;
}

async function runInitialSync(): Promise<void> {
	await run(async (token) => {
		sync.phase = 'Drive 확인 중…';
		const files = await listAll(token);
		index = {};
		for (const f of files) index[f.name] = { id: f.id, md5: f.md5Checksum };
		await kvSet(K_INDEX, index);

		const remoteDb = files.find((f) => f.name === DB_NAME) ?? null;
		const rec = await kvGet<RemoteRef>(K_DB);
		const dirty = (await kvGet<boolean>(K_DIRTY)) ?? false;

		if (!remoteDb) {
			sync.phase = 'Drive 에 처음 올리는 중…';
			await pushDb(token);
		} else if (!rec) {
			// 이 기기에서 처음 연결. 로컬이 비어 있으면 받아오고, 데이터가 있으면 유저가 고른다.
			if (await localIsEmpty()) {
				sync.phase = 'Drive 데이터 받는 중…';
				await pullDb(token);
			} else {
				sync.conflict = { remoteModified: remoteDb.modifiedTime };
				sync.status = 'idle';
				return;
			}
		} else if (remoteDb.md5Checksum === rec.md5) {
			if (dirty) {
				sync.phase = '변경 사항 올리는 중…';
				await pushDb(token);
			}
		} else {
			// 원격이 다른 기기에서 바뀜.
			if (!dirty) {
				sync.phase = 'Drive 데이터 받는 중…';
				await pullDb(token);
			} else {
				sync.conflict = { remoteModified: remoteDb.modifiedTime };
				sync.status = 'idle';
				return;
			}
		}
		await syncImages(token);
		await finishOk();
	});
}

async function localIsEmpty(): Promise<boolean> {
	const r = rt!.db.exec(
		'SELECT (SELECT count(*) FROM characters) + (SELECT count(*) FROM chat_sessions) + (SELECT count(*) FROM art_styles) + (SELECT count(*) FROM prompt_modules)'
	);
	return Number(r[0]?.values[0]?.[0] ?? 0) === 0;
}

async function pushDb(token: string): Promise<void> {
	await rt!.flush();
	const bytes = rt!.exportDatabase();
	const blob = new Blob([bytes as BlobPart], { type: 'application/x-sqlite3' });
	const existing = index[DB_NAME];
	const f: DriveFile = existing
		? await updateFile(token, existing.id, blob, 'application/x-sqlite3')
		: await createFile(token, DB_NAME, blob, 'application/x-sqlite3');
	index[DB_NAME] = { id: f.id, md5: f.md5Checksum };
	await kvSet(K_INDEX, index);
	await kvSet(K_DB, index[DB_NAME]);
	await kvSet(K_DIRTY, false);
}

async function pullDb(token: string): Promise<void> {
	const ref = index[DB_NAME];
	if (!ref) return;
	const blob = await download(token, ref.id);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	// replaceDatabase 는 flush → onDatabaseSaved 를 부르므로 dirty 가 다시 켜진다 → 뒤에서 끈다.
	await rt!.replaceDatabase(bytes);
	await kvSet(K_DB, ref);
	await kvSet(K_DIRTY, false);
	await invalidateAll();
}

async function syncImages(token: string): Promise<void> {
	const localKeys = new Set(await objKeys());
	const puts = new Set((await kvGet<string[]>(K_PUTS)) ?? []);
	const dels = new Set((await kvGet<string[]>(K_DELS)) ?? []);

	// 1) 삭제 대기열
	for (const key of [...dels]) {
		const ref = index[key];
		if (ref) {
			await deleteFile(token, ref.id);
			delete index[key];
		}
		dels.delete(key);
		await kvSet(K_DELS, [...dels]);
	}

	// 2) 업로드(병렬): 대기열 + 원격에 없는 로컬 파일
	const toUpload = new Set<string>([...puts]);
	for (const k of localKeys) if (!index[k]) toUpload.add(k);
	let n = 0;
	let sinceSave = 0;
	await parallel([...toUpload], async (key) => {
		const obj = await objGet(key);
		if (obj) {
			const ref = index[key];
			const f = ref
				? await updateFile(token, ref.id, obj.blob, obj.contentType)
				: await createFile(token, key, obj.blob, obj.contentType);
			index[key] = { id: f.id, md5: f.md5Checksum };
		}
		puts.delete(key);
		n++;
		sync.phase = `이미지 올리는 중… (${n}/${toUpload.size})`;
		// 인덱스/대기열은 20개마다 저장(중단돼도 재개 가능, IndexedDB 쓰기 부담 완화)
		if (++sinceSave >= 20) {
			sinceSave = 0;
			await kvSet(K_PUTS, [...puts]);
			await kvSet(K_INDEX, index);
			await refreshPendingCount();
		}
	});
	await kvSet(K_PUTS, [...puts]);
	await kvSet(K_INDEX, index);
	await refreshPendingCount();

	// 3) 다운로드는 하지 않는다 — 로컬에 없는 원격 이미지는 볼 때 지연 다운로드(서비스워커/miss 핸들러).
	await kvSet(K_INDEX, index);
}

/** Drive 에서 이미지 1개를 받아 IndexedDB 에 넣는다(지연 다운로드). 인덱스에 없거나 토큰 없으면 null. */
async function fetchImageFromDrive(key: string): Promise<StoredObject | null> {
	const ref = index[key];
	if (!ref) return null;
	const token = currentToken();
	if (!token) return null;
	const blob = await download(token, ref.id);
	const obj: StoredObject = {
		key,
		blob,
		contentType: blob.type || guessType(key),
		size: blob.size,
		uploaded: Date.now(),
		etag: ref.md5 ?? crypto.randomUUID().replace(/-/g, '')
	};
	await objPut(obj);
	return obj;
}

/** 설정 모달: 원격 이미지를 전부 이 기기에 내려받기(오프라인 대비, 선택). 진행은 sync.phase. */
export async function downloadAllImages(): Promise<{ downloaded: number; total: number }> {
	if (sync.mode !== 'drive') return { downloaded: 0, total: 0 };
	const localKeys = new Set(await objKeys());
	const todo = Object.keys(index).filter((k) => k !== DB_NAME && !localKeys.has(k));
	let n = 0;
	await run(async () => {
		await parallel(todo, async (key) => {
			await fetchImageFromDrive(key);
			n++;
			sync.phase = `이미지 받는 중… (${n}/${todo.length})`;
		});
		await finishOk();
	});
	return { downloaded: n, total: todo.length };
}

async function parallel<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	let firstError: unknown = null;
	await Promise.all(
		Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
			while (queue.length && !firstError) {
				const item = queue.shift()!;
				try {
					await fn(item);
				} catch (e) {
					firstError ??= e;
				}
			}
		})
	);
	if (firstError) throw firstError;
}

function guessType(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase();
	return ext === 'png'
		? 'image/png'
		: ext === 'jpg' || ext === 'jpeg'
			? 'image/jpeg'
			: ext === 'avif'
				? 'image/avif'
				: ext === 'webp'
					? 'image/webp'
					: 'application/octet-stream';
}

/** 대기열 처리(디바운스 후). */
async function flush(): Promise<void> {
	if (sync.mode !== 'drive' || !sync.ready) return;
	await run(async (token) => {
		const dirty = (await kvGet<boolean>(K_DIRTY)) ?? false;
		if (dirty) {
			sync.phase = '변경 사항 올리는 중…';
			await pushDb(token);
		}
		await syncImages(token);
		await finishOk();
	});
}

export interface RemoteSummary {
	/** Haven(appDataFolder) 파일 수·바이트. */
	files: number;
	bytes: number;
	/** Google Drive 계정 전체 사용량·총 용량(무제한이면 null). */
	quotaUsage: number;
	quotaLimit: number | null;
}

/** 설정 모달용: Haven appData 사용량 + Drive 계정 전체 용량. */
export async function remoteSummary(): Promise<RemoteSummary | null> {
	if (sync.mode !== 'drive') return null;
	try {
		const token = await ensureToken(false);
		const [files, quota] = await Promise.all([listAll(token), getQuota(token)]);
		return {
			files: files.length,
			bytes: files.reduce((a, f) => a + f.size, 0),
			quotaUsage: quota.usage,
			quotaLimit: quota.limit
		};
	} catch {
		return null;
	}
}
