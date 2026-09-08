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
 * 다기기(PocketRisu 의 서버 동기화를 Drive 위에 흉내): 탭이 보이는 동안 주기적으로(`POLL_MS`) 원격 DB 의
 * md5 를 확인해, 다른 기기가 썼고 로컬이 clean 이면 조용히 pull(`invalidateAll`). 탭 포커스/표시 전환 시 즉시 확인.
 * 모든 push 는 직전에 원격 md5 가 마지막 동기화 기록과 같은지 확인(선행조건)해서 다른 기기 변경을 덮어쓰지 않는다.
 * DB 파일의 appProperties 에 마지막으로 쓴 기기(`deviceId`/`deviceName`)를 남겨 '다른 기기 사용 중' 을 표시한다.
 *
 * 충돌: 원격 DB 의 md5 가 마지막 동기화 기록과 다르고(다른 기기가 씀) 로컬도 dirty 면
 * 자동으로 고르지 않고 `conflict` 를 띄워 유저가 고른다(시작 시·주기 확인·push 직전 모두 같은 규칙).
 */
import { invalidateAll } from '$app/navigation';
import { kvGet, kvSet, kvDelete, objDelete, objGet, objKeys, objPut, type StoredObject } from './idb';
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
	getMeta,
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
/** 원격 변경 확인 주기(탭이 보일 때만). 다른 기기가 최근에 썼으면 짧게. */
const POLL_MS = 20_000;
const POLL_ACTIVE_MS = 8_000;
/** 다른 기기의 마지막 쓰기가 이 시간 안이면 '사용 중' 으로 본다. */
const OTHER_ACTIVE_MS = 3 * 60_000;
/** 이미지 업로드/다운로드 동시 수. */
const PARALLEL = 4;

// IndexedDB kv 키
const K_INDEX = 'drive:index'; // Record<name, {id, md5}>
const K_DB = 'drive:db'; // {id, md5} — 마지막 push/pull 시점의 원격 DB
const K_DIRTY = 'drive:dbDirty';
const K_PUTS = 'drive:pendingPuts';
const K_DELS = 'drive:pendingDeletes';
const K_LAST = 'drive:lastSyncAt';
const K_DEVICE = 'drive:deviceId';

interface RemoteRef {
	id: string;
	md5?: string;
}

/** 원격 DB 를 마지막으로 쓴 기기(DB 파일 appProperties + modifiedTime). */
export interface Writer {
	deviceId: string;
	deviceName: string;
	at: number;
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
	conflict: null as null | { remoteModified: string; writer: Writer | null },
	clientIdMissing: !GOOGLE_CLIENT_ID,
	/** 이 기기 식별(Drive 파일 appProperties 에 기록). */
	deviceId: '',
	deviceName: '',
	/** 원격 DB 를 마지막으로 쓴 기기. */
	writer: null as Writer | null,
	/** 다른 기기가 최근(OTHER_ACTIVE_MS)에 썼는지 — 헤더 칩 표시용. */
	otherActive: false,
	/** 진행 중인 동기화를 취소할 수 있는지(이미지 업로드/다운로드 단계). */
	cancellable: false
});

let abortFlag = false;

/** 진행 중인 이미지 업로드/다운로드를 중단한다(대기열은 남아 다음에 이어짐). */
export function cancelSync(): void {
	if (sync.status === 'syncing') abortFlag = true;
}

let rt: LocalRuntime | null = null;
let index: Record<string, RemoteRef> = {};
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let hooked = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastPollAt = 0;
/** 세션당 1회: 덮어쓰기 키의 로컬 캐시를 원격과 직접 대조했는지. */
let cacheVerified = false;
/** 같은 키에 새 내용을 덮어쓰는 이미지 접두(썸네일·상세·그림체·아바타). 장면·채팅 이미지는 id 별 불변. */
const OVERWRITABLE_PREFIXES = ['char/', 'charfull/', 'style/', 'avatar/'];

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
	await ensureDeviceIdentity();
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
	const onVisible = () => {
		if (document.visibilityState === 'visible') void poll(true);
	};
	document.addEventListener('visibilitychange', onVisible);
	window.addEventListener('focus', onVisible);
}

/** 기기 id 는 브라우저 프로필당 1회 생성해 kv 에 보관, 이름은 UA 로 대충(iPhone/Android/Mac/Windows/Linux) + id 앞 4자. */
async function ensureDeviceIdentity(): Promise<void> {
	let id = await kvGet<string>(K_DEVICE);
	if (!id) {
		id = crypto.randomUUID().replace(/-/g, '');
		await kvSet(K_DEVICE, id);
	}
	sync.deviceId = id;
	const ua = navigator.userAgent;
	const os = /iPhone|iPod/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Macintosh/.test(ua)
					? 'Mac'
					: /Windows/.test(ua)
						? 'Windows'
						: /Linux/.test(ua)
							? 'Linux'
							: '기기';
	sync.deviceName = `${os} · ${id.slice(0, 4)}`;
}

function deviceProps(): Record<string, string> {
	return { deviceId: sync.deviceId, deviceName: sync.deviceName };
}

/** 원격 DB 파일 메타에서 마지막 작성 기기를 읽어 상태에 반영. */
function noteWriter(f: DriveFile): void {
	const p = f.appProperties ?? {};
	const at = Date.parse(f.modifiedTime) || Date.now();
	sync.writer = p.deviceId ? { deviceId: p.deviceId, deviceName: p.deviceName || '다른 기기', at } : null;
	updateOtherActive();
}

function updateOtherActive(): void {
	const w = sync.writer;
	sync.otherActive = !!w && w.deviceId !== sync.deviceId && Date.now() - w.at < OTHER_ACTIVE_MS;
}

// ── 주기 확인(다른 기기 변경 감지) ────────────────────────────
function schedulePoll(): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = setTimeout(
		() => {
			pollTimer = null;
			void poll().finally(schedulePoll);
		},
		sync.otherActive ? POLL_ACTIVE_MS : POLL_MS
	);
}

function stopPolling(): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
}

/**
 * 원격 DB md5 를 한 번 확인한다(요청 1회). 다른 기기가 썼으면:
 *  - 로컬 clean → 바로 pull + 화면 갱신(다른 기기가 올린 이미지를 알기 위해 인덱스도 갱신).
 *  - 로컬 dirty → push 를 앞당긴다(pushDb 선행조건에서 conflict 로 이어짐).
 * 팝업이 필요한 토큰 갱신은 하지 않는다(제스처 경로가 담당).
 */
async function poll(force = false): Promise<void> {
	if (sync.mode !== 'drive' || !sync.ready || sync.conflict || running) return;
	if (!force && document.visibilityState === 'hidden') return;
	if (Date.now() - lastPollAt < 3000) return;
	const token = currentToken();
	const ref = index[DB_NAME];
	if (!token || !ref) return;
	lastPollAt = Date.now();
	let meta: DriveFile | null;
	try {
		meta = await getMeta(token, ref.id);
	} catch (e) {
		if (e instanceof DriveHttpError && e.status === 401) sync.status = 'needs-auth';
		return;
	}
	if (!meta) return;
	noteWriter(meta);
	const rec = await kvGet<RemoteRef>(K_DB);
	if (!rec?.md5 || !meta.md5Checksum || meta.md5Checksum === rec.md5) return;
	const dirty = ((await kvGet<boolean>(K_DIRTY)) ?? false) || rt!.dirty;
	if (dirty) {
		schedulePush(0);
		return;
	}
	// 요청(채팅 스트림 등)이 진행 중이면 DB 를 바꾸지 않고 다음 확인으로 미룬다.
	if (rt!.busy) return;
	await run(async (token) => {
		sync.phase = '다른 기기의 변경 받는 중…';
		index[DB_NAME] = { id: meta!.id, md5: meta!.md5Checksum };
		await kvSet(K_INDEX, index);
		await pullDb(token);
		await finishOk();
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
	stopPolling();
	writeMode('local');
	index = {};
	sync.writer = null;
	sync.otherActive = false;
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
		else await pushDb(token, { verified: true });
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
			if (e instanceof SyncCancelled) {
				sync.status = 'idle';
				sync.ready = true;
			} else if (e instanceof DriveHttpError && e.status === 401) {
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
	updateOtherActive();
	if (!pollTimer) schedulePoll();
}

async function runInitialSync(): Promise<void> {
	await run(async (token) => {
		sync.phase = 'Drive 확인 중…';
		const files = await refreshIndex(token);

		const remoteDb = files.find((f) => f.name === DB_NAME) ?? null;
		if (remoteDb) noteWriter(remoteDb);
		const rec = await kvGet<RemoteRef>(K_DB);
		const dirty = (await kvGet<boolean>(K_DIRTY)) ?? false;
		const conflict = () => ({ remoteModified: remoteDb!.modifiedTime, writer: sync.writer });

		if (!remoteDb) {
			sync.phase = 'Drive 에 처음 올리는 중…';
			await pushDb(token, { verified: true });
		} else if (!rec) {
			// 이 기기에서 처음 연결. 로컬이 비어 있으면 받아오고, 데이터가 있으면 유저가 고른다.
			if (await localIsEmpty()) {
				sync.phase = 'Drive 데이터 받는 중…';
				await pullDb(token);
			} else {
				sync.conflict = conflict();
				sync.status = 'idle';
				return;
			}
		} else if (remoteDb.md5Checksum === rec.md5) {
			if (dirty) {
				sync.phase = '변경 사항 올리는 중…';
				await pushDb(token, { verified: true });
			}
		} else {
			// 원격이 다른 기기에서 바뀜.
			if (!dirty) {
				sync.phase = 'Drive 데이터 받는 중…';
				await pullDb(token, { refreshIndex: false });
			} else {
				sync.conflict = conflict();
				sync.status = 'idle';
				return;
			}
		}
		// DB 가 맞춰졌으면 화면을 연다. 이미지 업로드는 뒤에서(헤더 칩에 진행 표시, 취소 가능).
		sync.ready = true;
		await syncImages(token);
		await finishOk();
	});
}

/**
 * 백업 가져오기 직후: 로컬 이미지가 zip 내용으로 통째 바뀌었으므로 Drive 도 그에 맞춘다 —
 * zip 에 없는 원격 이미지는 삭제 대기열에, 대기 중이던 업로드 목록은 비운다(없어진 키 업로드 방지).
 */
export async function reconcileAfterImport(): Promise<void> {
	if (sync.mode !== 'drive') return;
	const local = new Set(await objKeys());
	const extras = Object.keys(index).filter((k) => k !== DB_NAME && !local.has(k));
	await kvSet(K_PUTS, []);
	await kvSet(K_DELS, extras);
	await refreshPendingCount();
	schedulePush(500);
}

async function localIsEmpty(): Promise<boolean> {
	const r = rt!.db.exec(
		'SELECT (SELECT count(*) FROM characters) + (SELECT count(*) FROM chat_sessions) + (SELECT count(*) FROM art_styles) + (SELECT count(*) FROM prompt_modules)'
	);
	return Number(r[0]?.values[0]?.[0] ?? 0) === 0;
}

/**
 * 로컬 DB 스냅샷을 Drive 에 올린다. `verified` 가 아니면 먼저 원격 md5 가 마지막 동기화 기록과 같은지
 * 확인하고, 다른 기기가 그새 썼으면 올리지 않고 `conflict` 를 띄운다(false 반환). 원격 파일이 지워졌으면 새로 만든다.
 */
async function pushDb(token: string, opts: { verified?: boolean } = {}): Promise<boolean> {
	const existing = index[DB_NAME];
	if (existing && !opts.verified) {
		const [meta, rec] = await Promise.all([getMeta(token, existing.id), kvGet<RemoteRef>(K_DB)]);
		if (!meta) {
			delete index[DB_NAME];
		} else if (rec?.md5 && meta.md5Checksum && meta.md5Checksum !== rec.md5) {
			noteWriter(meta);
			index[DB_NAME] = { id: meta.id, md5: meta.md5Checksum };
			await kvSet(K_INDEX, index);
			sync.conflict = { remoteModified: meta.modifiedTime, writer: sync.writer };
			return false;
		}
	}
	await rt!.flush();
	const bytes = rt!.exportDatabase();
	const blob = new Blob([bytes as BlobPart], { type: 'application/x-sqlite3' });
	const cur = index[DB_NAME];
	const f: DriveFile = cur
		? await updateFile(token, cur.id, blob, 'application/x-sqlite3', deviceProps())
		: await createFile(token, DB_NAME, blob, 'application/x-sqlite3', deviceProps());
	index[DB_NAME] = { id: f.id, md5: f.md5Checksum };
	await kvSet(K_INDEX, index);
	await kvSet(K_DB, index[DB_NAME]);
	await kvSet(K_DIRTY, false);
	noteWriter(f);
	return true;
}

/**
 * 원격 DB 로 로컬을 덮어쓴다. 기본으로 파일 인덱스도 다시 받는다 — 다른 기기가 올린 이미지는
 * 인덱스에 있어야 지연 다운로드(miss 핸들러/서비스워커)가 찾을 수 있다. 초기 동기화는 직전에 받았으니 생략.
 */
async function pullDb(token: string, opts: { refreshIndex?: boolean } = {}): Promise<void> {
	const ref = index[DB_NAME];
	if (!ref) return;
	const blob = await download(token, ref.id);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	// replaceDatabase 는 flush → onDatabaseSaved 를 부르므로 dirty 가 다시 켜진다 → 뒤에서 끈다.
	await rt!.replaceDatabase(bytes);
	await kvSet(K_DB, ref);
	await kvSet(K_DIRTY, false);
	if (opts.refreshIndex !== false) await refreshIndex(token);
	await invalidateAll();
}

/**
 * Drive 파일 목록으로 인덱스를 다시 만들고, 그 사이 **다른 기기가 바꾼 이미지의 로컬 캐시를 지운다**:
 *  - md5 가 달라진 키(썸네일 `char/<id>.webp` 처럼 같은 키에 덮어쓰는 교체) → 지워서 다음 표시 때 지연 다운로드.
 *  - 원격에서 사라진 키 → 지워서 고아 캐시가 남거나 syncImages 가 '원격에 없는 로컬 파일' 로 다시 올리지 않게.
 * 이 기기가 아직 올리지 않은 키(put 대기열)는 이 기기 것이 최신이므로 건드리지 않는다.
 * idb.objDelete 는 R2 shim 을 거치지 않아 삭제 대기열(Drive 삭제)로 번지지 않는다.
 */
async function refreshIndex(token: string): Promise<DriveFile[]> {
	const files = await listAll(token);
	const prev = index;
	const next: Record<string, RemoteRef> = {};
	for (const f of files) next[f.name] = { id: f.id, md5: f.md5Checksum };
	const puts = new Set((await kvGet<string[]>(K_PUTS)) ?? []);
	const stale = new Set<string>();
	for (const [k, old] of Object.entries(prev)) {
		if (k === DB_NAME || puts.has(k)) continue;
		const cur = next[k];
		if (!cur || (old.md5 && cur.md5 && old.md5 !== cur.md5)) stale.add(k);
	}
	// 인덱스 diff 로 못 잡는 경우(인덱스는 이미 새 md5 인데 캐시는 옛 파일 — 이 로직 이전 버전이 동기화한 기기)를
	// 위해 덮어쓰기 키는 로컬 오브젝트를 원격과 직접 대조한다(세션당 1회, 대상이 수백 개라 부담 적음).
	if (!cacheVerified) {
		cacheVerified = true;
		for (const k of await findStaleOverwritable(files, puts)) stale.add(k);
	}
	if (stale.size) {
		await objDelete([...stale]);
		console.info(`[sync] 다른 기기가 바꾼 이미지 캐시 ${stale.size}개 정리`);
	}
	index = next;
	await kvSet(K_INDEX, index);
	return files;
}

/**
 * 덮어쓰기 접두 키 중 로컬 캐시가 원격과 다른 것. etag 가 Drive md5 와 같으면(Drive 에서 받았거나 올린 뒤 기록) 최신.
 * 아니면(로컬 생성 etag 는 임의값) 크기로 판정 — 같은 크기의 다른 이미지는 사실상 없다.
 */
async function findStaleOverwritable(files: DriveFile[], puts: Set<string>): Promise<string[]> {
	const byName = new Map(files.map((f) => [f.name, f] as const));
	const keys = (await objKeys()).filter(
		(k) => !puts.has(k) && byName.has(k) && OVERWRITABLE_PREFIXES.some((p) => k.startsWith(p))
	);
	const out: string[] = [];
	for (const k of keys) {
		const f = byName.get(k)!;
		const obj = await objGet(k);
		if (!obj || obj.etag === f.md5Checksum) continue;
		if (f.size > 0 && obj.size !== f.size) out.push(k);
	}
	return out;
}

async function syncImages(token: string): Promise<void> {
	const localKeys = new Set(await objKeys());
	const puts = new Set((await kvGet<string[]>(K_PUTS)) ?? []);
	const dels = new Set((await kvGet<string[]>(K_DELS)) ?? []);

	// 1) 삭제 대기열(병렬)
	if (dels.size) {
		let d = 0;
		const total = dels.size;
		await parallel([...dels], async (key) => {
			const ref = index[key];
			if (ref) {
				await deleteFile(token, ref.id);
				delete index[key];
			}
			dels.delete(key);
			d++;
			sync.phase = `Drive 에서 지우는 중… (${d}/${total})`;
			if (d % 20 === 0) {
				await kvSet(K_DELS, [...dels]);
				await kvSet(K_INDEX, index);
			}
		});
		await kvSet(K_DELS, [...dels]);
		await kvSet(K_INDEX, index);
		await refreshPendingCount();
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
			// 로컬 etag 를 Drive md5 로 맞춰 두면 이후 캐시 대조가 정확해진다(refreshIndex).
			if (f.md5Checksum && obj.etag !== f.md5Checksum) await objPut({ ...obj, etag: f.md5Checksum });
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
	abortFlag = false;
	sync.cancellable = queue.length > 0;
	await Promise.all(
		Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
			while (queue.length && !firstError && !abortFlag) {
				const item = queue.shift()!;
				try {
					await fn(item);
				} catch (e) {
					firstError ??= e;
				}
			}
		})
	);
	sync.cancellable = false;
	if (firstError) throw firstError;
	if (abortFlag) {
		abortFlag = false;
		throw new SyncCancelled();
	}
}

class SyncCancelled extends Error {
	constructor() {
		super('동기화를 취소했어요. 남은 항목은 다음에 이어서 올라가요.');
	}
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
	if (sync.mode !== 'drive' || !sync.ready || sync.conflict) return;
	await run(async (token) => {
		const dirty = (await kvGet<boolean>(K_DIRTY)) ?? false;
		if (dirty) {
			sync.phase = '변경 사항 올리는 중…';
			if (!(await pushDb(token))) {
				// 다른 기기가 먼저 썼다 — 유저가 고를 때까지 올리지 않는다(이미지 대기열은 남겨 둔다).
				sync.status = 'idle';
				return;
			}
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
