/**
 * 저장소 모드 + Google Drive 동기화 엔진(반응형 상태 포함). 2026-09-08 재설계.
 *
 * 모드(localStorage `haven:storage`):
 *  - 'local' : 이 기기(IndexedDB)에만 저장.
 *  - 'drive' : IndexedDB 를 캐시로 두고 Google Drive appDataFolder 와 동기화(원본 = Drive).
 *  - 미설정  : 랜딩(StorageLanding)에서 고른다.
 *
 * 원칙
 *  1. **앱은 로컬 데이터로 즉시 뜬다.** 동기화는 뒤에서 돌고 헤더 칩이 상태를 보인다. 화면을 막는 경우는 둘뿐:
 *     저장소를 아직 안 골랐을 때, Drive 를 처음 연결하는데 로컬이 비어 있어 받아와야 할 때(`sync.ready=false`).
 *  2. **Drive 가 원본.** 로컬 DB 는 `base`(마지막으로 맞춘 원격 DB 의 md5) + `dirty`(그 뒤 로컬 변경) 로 표현된다.
 *  3. **한 번에 한 작업.** 모든 작업은 `reconcile` 하나로 수렴한다(부팅·저장 후 디바운스·주기 확인·수동 동기화 전부):
 *       원격 없음            → push(생성)
 *       base 없음(첫 연결)   → 로컬 비었으면 pull, 아니면 conflict
 *       원격 == base         → dirty 면 push
 *       원격 != base         → clean 이면 pull, dirty 면 conflict
 *     push 는 이 판정 직후 같은 작업 안에서만 일어나므로 다른 기기 변경을 덮어쓰지 않는다(Drive 에 CAS 가 없어
 *     작업 길이만큼의 경쟁 창은 남는다 — 1인 전제).
 *  4. **이미지는 대기열만.** put/delete 대기열(IndexedDB 영속)을 처리할 뿐, 로컬 전체를 원격과 대조하지 않는다
 *     (예전 '원격에 없는 로컬 파일 전부 올리기' 스캔이 모바일에서 수십 초를 먹던 원인). 백업 가져오기만 명시적으로
 *     전체를 대기열에 넣는다. 다른 기기가 올린 이미지는 볼 때 지연 다운로드(서비스워커/miss 핸들러, 인덱스 필요).
 *  5. **인덱스는 증분 갱신.** pull 뒤 `modifiedTime > 마지막 동기화` 로 바뀐 파일만 받아(요청 1회) 인덱스에 합치고,
 *     그중 md5 가 달라진 키의 로컬 캐시를 지운다(같은 키에 덮어쓰는 썸네일 교체가 다른 기기에서도 보이게).
 *     전체 목록(`listAll`)은 첫 연결·'Drive 기준으로 맞추기'·이미지 전부 내려받기에서만.
 *
 * 다기기: 탭이 보이는 동안 `POLL_MS`(다른 기기가 최근 썼으면 `POLL_ACTIVE_MS`)마다 원격 DB 메타 1회 조회 + 탭 표시/
 * 포커스 전환 시 즉시. 바뀌었으면 reconcile. 채팅 스트림 등 요청이 진행 중(`rt.busy`)이면 pull 을 다음으로 미룬다.
 * DB 파일 appProperties 에 마지막으로 쓴 기기(`deviceId`/`deviceName`)를 남겨 '다른 기기 사용 중' 을 표시한다.
 *
 * 충돌은 화면을 막지 않는다(첫 연결 중만 랜딩에서 선택). `status='conflict'` 칩 → 저장소 모달에서 어느 쪽을 쓸지 고르고,
 * 고르기 전까지 push/pull 은 멈춘다(데이터는 양쪽 다 보존).
 */
import { invalidateAll } from '$app/navigation';
import { kvGet, kvSet, kvDelete, objClear, objDelete, objGet, objKeys, objPut, type StoredObject } from './idb';
import { getLocalRuntime, onDatabaseSaved, onObjectsChanged, type LocalRuntime } from './runtime';
import {
	createFile,
	deleteFile,
	download,
	ensureToken,
	findByName,
	forgetToken,
	getMeta,
	getQuota,
	hasStoredToken,
	listAll,
	listChangedSince,
	updateFile,
	currentToken,
	DriveAuthError,
	DriveHttpError,
	GOOGLE_CLIENT_ID,
	type DriveFile
} from './drive';

export type StorageMode = 'unset' | 'local' | 'drive';
export type SyncStatus = 'off' | 'idle' | 'syncing' | 'conflict' | 'needs-auth' | 'error';

const MODE_KEY = 'haven:storage';
const DB_NAME = 'haven.sqlite';
const DB_MIME = 'application/x-sqlite3';
/** 로컬 저장 뒤 이 시간 안에 더 저장이 없으면 올린다. */
const PUSH_DEBOUNCE_MS = 3000;
/** 원격 변경 확인 주기(탭이 보일 때만). 다른 기기가 최근에 썼으면 짧게. */
const POLL_MS = 20_000;
const POLL_ACTIVE_MS = 8_000;
/** 다른 기기의 마지막 쓰기가 이 시간 안이면 '사용 중' 으로 본다. */
const OTHER_ACTIVE_MS = 3 * 60_000;
/** 이미지 업로드/다운로드 동시 수. */
const PARALLEL = 4;

// IndexedDB kv 키(이전 버전과 같은 이름 — 기존 기기의 상태를 그대로 이어받는다)
const K_INDEX = 'drive:index'; // Record<name, {id, md5}>
const K_BASE = 'drive:db'; // {id, md5} — 마지막으로 맞춘 원격 DB
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
	/** 앱을 렌더해도 되는지. false 면 StorageLanding 이 덮는다(모드 미선택, 첫 연결 pull 중, 첫 연결 충돌). */
	ready: initialMode === 'local',
	/** 올릴 것(DB dirty 1 + 이미지 대기열). */
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

let rt: LocalRuntime | null = null;
let index: Record<string, RemoteRef> = {};
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastPollAt = 0;
let running: Promise<void> | null = null;
let hooked = false;
let abortFlag = false;

// ── 유틸 ────────────────────────────────────────────────────

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

async function isDirty(): Promise<boolean> {
	return ((await kvGet<boolean>(K_DIRTY)) ?? false) || !!rt?.dirty;
}

async function localIsEmpty(): Promise<boolean> {
	const r = rt!.db.exec(
		'SELECT (SELECT count(*) FROM characters) + (SELECT count(*) FROM chat_sessions) + (SELECT count(*) FROM art_styles) + (SELECT count(*) FROM prompt_modules)'
	);
	return Number(r[0]?.values[0]?.[0] ?? 0) === 0;
}

async function saveIndex() {
	await kvSet(K_INDEX, index);
}

function toRef(f: DriveFile): RemoteRef {
	return { id: f.id, md5: f.md5Checksum };
}

/** 기기 id 는 브라우저 프로필당 1회 생성해 kv 에 보관, 이름은 UA 로 대충(iPhone/Android/Mac/…) + id 앞 4자. */
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

// ── 시작 ────────────────────────────────────────────────────

/** 앱 시작 시(런타임 부팅 후) 호출. Drive 모드면 뒤에서 reconcile 을 돌린다(로컬이 비어 있지 않으면 화면은 바로 연다). */
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
	if (sync.mode !== 'drive') return; // 미설정 → 랜딩

	// 첫 연결인데 로컬이 비어 있으면 받아올 때까지만 막는다. 그 외엔 로컬 데이터로 바로 연다.
	const base = await kvGet<RemoteRef>(K_BASE);
	sync.ready = !!base || !(await localIsEmpty());
	if (currentToken()) {
		await runOp(reconcile);
	} else {
		// 토큰 만료 — 팝업은 제스처가 필요하니 칩(또는 랜딩)의 '다시 연결' 을 기다린다. 변경은 dirty 로 쌓인다.
		sync.status = 'needs-auth';
	}
	startPolling();
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
		if (sync.mode === 'drive' && sync.ready && !sync.conflict) void runOp(reconcile);
	}, delay);
}

// ── 주기 확인(다른 기기 변경 감지) ────────────────────────────

function startPolling(): void {
	if (pollTimer) return;
	schedulePoll();
}

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

/** 원격 DB 메타 1회 조회(요청 1회). 바뀌었으면 reconcile. 팝업이 필요한 토큰 갱신은 하지 않는다(제스처 경로가 담당). */
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
	const base = await kvGet<RemoteRef>(K_BASE);
	if (base?.md5 && meta.md5Checksum === base.md5) return;
	await runOp(reconcile);
}

// ── 사용자 액션 ──────────────────────────────────────────────

/** 랜딩: 이 기기에만 저장. */
export function chooseLocal(): void {
	writeMode('local');
	sync.status = 'off';
	sync.ready = true;
}

/** 랜딩/설정: Drive 연결(유저 제스처 안에서 호출 — GIS 팝업). 첫 연결은 판정이 끝날 때까지 랜딩이 진행을 보인다. */
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
	sync.ready = false;
	await runOp(reconcile);
	startPolling();
}

/** Drive 연결 해제(로컬 데이터는 그대로, 원격 파일도 지우지 않음). */
export async function disconnectDrive(): Promise<void> {
	forgetToken();
	stopPolling();
	writeMode('local');
	index = {};
	sync.writer = null;
	sync.otherActive = false;
	await Promise.all([kvDelete(K_INDEX), kvDelete(K_BASE), kvDelete(K_DIRTY), kvDelete(K_PUTS), kvDelete(K_DELS)]);
	sync.status = 'off';
	sync.pending = 0;
	sync.conflict = null;
	sync.ready = true;
}

/** 랜딩(첫 연결·토큰 만료)에서 '연결 없이 계속' — 변경은 dirty 로 쌓여 다음 연결 때 올라간다. */
export function continueOffline(): void {
	sync.ready = true;
}

/** 충돌 해결: 'remote' = Drive 것으로 로컬 덮어쓰기, 'local' = 이 기기 것으로 Drive 덮어쓰기. */
export async function resolveConflict(pick: 'remote' | 'local'): Promise<void> {
	if (!sync.conflict) return;
	sync.conflict = null;
	await runOp(async (token) => {
		const remote = index[DB_NAME] ? await getMeta(token, index[DB_NAME].id) : await findByName(token, DB_NAME);
		if (pick === 'remote' && remote) {
			await pull(token, remote);
			await processImageQueue(token);
		} else {
			await processImageQueue(token);
			await push(token, remote);
		}
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
	await runOp(reconcile);
	startPolling();
}

/**
 * 설정 모달 'Drive 기준으로 맞추기'(제스처 안): Drive 를 원본으로 이 기기를 통째 맞춘다 — **올리지 않은 로컬 변경은 버린다**.
 * 이미지 대기열과 로컬 이미지 캐시를 전부 비우고(전부 Drive 에서 지연 다운로드 가능), 인덱스를 전체 목록으로 다시 만들고,
 * DB 를 Drive 것으로 교체한다. 다른 기기가 바꾼 썸네일이 옛것으로 보이는 등 캐시가 꼬였을 때의 복구용.
 */
export async function resetToDrive(): Promise<void> {
	if (sync.mode !== 'drive') return;
	await ensureToken(true);
	await runOp(async (token) => {
		sync.conflict = null;
		sync.phase = '이미지 캐시 비우는 중…';
		await kvSet(K_PUTS, []);
		await kvSet(K_DELS, []);
		await objClear();
		sync.phase = 'Drive 목록 받는 중…';
		await loadFullIndex(token);
		const remote = index[DB_NAME] ? await getMeta(token, index[DB_NAME].id) : null;
		if (remote) await pull(token, remote, { refreshIndex: false });
		else await push(token, null);
	});
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

/** 진행 중인 이미지 업로드/다운로드를 중단한다(대기열은 남아 다음에 이어짐). */
export function cancelSync(): void {
	if (sync.status === 'syncing') abortFlag = true;
}

// ── 엔진 ────────────────────────────────────────────────────

/**
 * 작업 하나를 직렬로 실행한다(동시에 둘 이상 돌지 않음). 토큰은 저장된 것만 쓴다(팝업 없음 → 없으면 needs-auth).
 * 정상 종료 + 충돌 없음 → idle/ready. 충돌 → status 'conflict'(ready 는 그대로 — 첫 연결이면 랜딩이 보여준다).
 */
async function runOp(job: (token: string) => Promise<void>): Promise<void> {
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
			if (sync.conflict) {
				sync.status = 'conflict';
			} else {
				sync.lastSyncAt = Date.now();
				await kvSet(K_LAST, sync.lastSyncAt);
				sync.status = 'idle';
				sync.ready = true;
			}
		} catch (e) {
			if (e instanceof SyncCancelled) {
				sync.status = 'idle';
				sync.ready = true;
			} else if (e instanceof SyncDeferred) {
				sync.status = 'idle';
			} else if ((e instanceof DriveHttpError && e.status === 401) || e instanceof DriveAuthError) {
				sync.status = 'needs-auth';
				if (e instanceof DriveAuthError) sync.error = e.message;
			} else {
				sync.status = 'error';
				sync.error = e instanceof Error ? e.message : String(e);
				console.error('[sync]', e);
			}
		} finally {
			sync.phase = '';
			updateOtherActive();
			await refreshPendingCount();
		}
	})();
	await running;
	running = null;
}

/**
 * 핵심: 원격 DB 와 로컬의 관계를 판정해 필요한 한 가지를 하고, 이미지 대기열을 처리한다.
 * 올릴 때는 **이미지 먼저, DB 마지막** — 다른 기기는 DB md5 변화를 보고 받아가므로, 그 시점에 DB 가 참조하는 이미지가
 * 이미 Drive 에 있어야 한다(반대 순서면 상대가 DB 만 받고 옛 썸네일 캐시를 계속 쓰는데, 다음 DB 변경까지 갱신 계기가 없다).
 */
async function reconcile(token: string): Promise<void> {
	sync.phase = 'Drive 확인 중…';
	let remote: DriveFile | null = null;
	if (index[DB_NAME]) {
		remote = await getMeta(token, index[DB_NAME].id);
		if (!remote) delete index[DB_NAME]; // 원격에서 지워짐
	}
	if (!remote && !index[DB_NAME]) {
		remote = await findByName(token, DB_NAME);
		if (remote) {
			index[DB_NAME] = toRef(remote);
			await saveIndex();
		}
	}
	if (remote) noteWriter(remote);

	const base = await kvGet<RemoteRef>(K_BASE);
	const dirty = await isDirty();

	if (!remote) {
		await processImageQueue(token);
		sync.phase = 'Drive 에 처음 올리는 중…';
		await push(token, null);
	} else if (!base) {
		// 이 기기에서 처음 연결. 로컬이 비어 있으면 받아오고, 데이터가 있으면 유저가 고른다.
		if (await localIsEmpty()) {
			await pull(token, remote);
			await processImageQueue(token);
		} else {
			setConflict(remote);
		}
	} else if (remote.md5Checksum === base.md5) {
		await processImageQueue(token);
		if (dirty) await push(token, remote);
	} else if (!dirty) {
		// 다른 기기가 썼고 이쪽은 깨끗함 → 받아온다. 요청(채팅 스트림 등)이 진행 중이면 다음 확인으로.
		if (rt!.busy) throw new SyncDeferred();
		await pull(token, remote);
		await processImageQueue(token);
	} else {
		setConflict(remote);
	}
}

function setConflict(remote: DriveFile): void {
	index[DB_NAME] = toRef(remote);
	void saveIndex();
	sync.conflict = { remoteModified: remote.modifiedTime, writer: sync.writer };
}

/** 로컬 DB 스냅샷을 Drive 에 올린다(`remote` 가 있으면 그 파일을 교체). base 갱신, dirty 해제. */
async function push(token: string, remote: DriveFile | null): Promise<void> {
	sync.phase = '변경 사항 올리는 중…';
	await rt!.flush();
	const bytes = rt!.exportDatabase();
	const blob = new Blob([bytes as BlobPart], { type: DB_MIME });
	const f = remote
		? await updateFile(token, remote.id, blob, DB_MIME, deviceProps())
		: await createFile(token, DB_NAME, blob, DB_MIME, deviceProps());
	index[DB_NAME] = toRef(f);
	await saveIndex();
	await kvSet(K_BASE, index[DB_NAME]);
	await kvSet(K_DIRTY, false);
	noteWriter(f);
}

/** 원격 DB 로 로컬을 덮어쓴다. base 갱신, dirty 해제, 인덱스 증분 갱신(+낡은 캐시 정리), 화면 갱신. */
async function pull(token: string, remote: DriveFile, opts: { refreshIndex?: boolean } = {}): Promise<void> {
	sync.phase = 'Drive 데이터 받는 중…';
	const blob = await download(token, remote.id);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	// 판정 뒤 내려받는 몇 초 사이에 로컬 쓰기(캐릭터 저장 등)가 끼어들었으면 덮어쓰지 않고 다음 reconcile 로 넘긴다
	// (그때는 dirty + 원격 변경 = conflict 로 유저가 고른다). 진행 중 요청도 마찬가지.
	if ((await isDirty()) || rt!.busy) throw new SyncDeferred();
	// replaceDatabase 는 flush → onDatabaseSaved 를 부르므로 dirty 가 다시 켜진다 → 뒤에서 끈다.
	await rt!.replaceDatabase(bytes);
	index[DB_NAME] = toRef(remote);
	await saveIndex();
	await kvSet(K_BASE, index[DB_NAME]);
	await kvSet(K_DIRTY, false);
	if (opts.refreshIndex !== false) await refreshIndex(token);
	await invalidateAll();
}

/** 전체 목록으로 인덱스를 다시 만든다(첫 연결·복구·전부 내려받기). */
async function loadFullIndex(token: string): Promise<void> {
	const files = await listAll(token);
	index = {};
	for (const f of files) index[f.name] = toRef(f);
	await saveIndex();
}

/**
 * 인덱스 갱신. 인덱스가 DB 파일뿐이면(첫 연결) 전체 목록, 아니면 마지막 동기화 이후 바뀐 파일만(요청 1회).
 * 바뀐 파일 중 인덱스의 md5 와 다른 키는 다른 기기가 교체한 것 → 로컬 캐시를 지워 다음 표시 때 새로 받게 한다.
 * 이 기기가 올릴 차례인 키(put 대기열)는 이 기기 것이 최신이므로 건드리지 않는다.
 * idb.objDelete 는 R2 shim 을 거치지 않아 삭제 대기열(Drive 삭제)로 번지지 않는다.
 */
async function refreshIndex(token: string): Promise<void> {
	const known = Object.keys(index).filter((k) => k !== DB_NAME).length;
	if (known === 0 || !sync.lastSyncAt) {
		sync.phase = 'Drive 목록 받는 중…';
		await loadFullIndex(token);
		return;
	}
	sync.phase = '바뀐 파일 확인 중…';
	const changed = await listChangedSince(token, sync.lastSyncAt - 60_000);
	const puts = new Set((await kvGet<string[]>(K_PUTS)) ?? []);
	const stale: string[] = [];
	for (const f of changed) {
		if (f.name === DB_NAME) continue;
		const old = index[f.name];
		if (old && old.md5 && f.md5Checksum && old.md5 !== f.md5Checksum && !puts.has(f.name)) stale.push(f.name);
		index[f.name] = toRef(f);
	}
	await saveIndex();
	if (stale.length) {
		await objDelete(stale);
		console.info(`[sync] 다른 기기가 바꾼 이미지 캐시 ${stale.length}개 정리`);
	}
}

/**
 * 백업 가져오기 직후: 로컬이 zip 내용으로 통째 바뀌었으므로 Drive 도 그에 맞춘다 —
 * 로컬 이미지 전부를 업로드 대기열에, zip 에 없는 원격 이미지는 삭제 대기열에. DB 는 replaceDatabase 가 dirty 로 만들었다.
 */
export async function reconcileAfterImport(): Promise<void> {
	if (sync.mode !== 'drive') return;
	const local = await objKeys();
	const localSet = new Set(local);
	const extras = Object.keys(index).filter((k) => k !== DB_NAME && !localSet.has(k));
	await kvSet(K_PUTS, local);
	await kvSet(K_DELS, extras);
	await refreshPendingCount();
	schedulePush(500);
}

// ── 이미지 ──────────────────────────────────────────────────

/** 대기열 처리: 삭제 → 업로드. 20개마다 진행 상태 저장(중단돼도 재개). 취소 가능. */
async function processImageQueue(token: string): Promise<void> {
	const dels = new Set((await kvGet<string[]>(K_DELS)) ?? []);
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
				await saveIndex();
			}
		});
		await kvSet(K_DELS, [...dels]);
		await saveIndex();
		await refreshPendingCount();
	}

	const puts = new Set((await kvGet<string[]>(K_PUTS)) ?? []);
	if (puts.size) {
		let n = 0;
		const total = puts.size;
		await parallel([...puts], async (key) => {
			const obj = await objGet(key);
			if (obj) {
				const ref = index[key];
				const f = ref
					? await updateFile(token, ref.id, obj.blob, obj.contentType)
					: await createFile(token, key, obj.blob, obj.contentType);
				index[key] = toRef(f);
				// 로컬 etag 를 Drive md5 로 맞춰 둔다(서비스워커 ETag 응답과 일치).
				if (f.md5Checksum && obj.etag !== f.md5Checksum) await objPut({ ...obj, etag: f.md5Checksum });
			}
			puts.delete(key);
			n++;
			sync.phase = `이미지 올리는 중… (${n}/${total})`;
			if (n % 20 === 0) {
				await kvSet(K_PUTS, [...puts]);
				await saveIndex();
				await refreshPendingCount();
			}
		});
		await kvSet(K_PUTS, [...puts]);
		await saveIndex();
		await refreshPendingCount();
	}
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
	let n = 0;
	let total = 0;
	await runOp(async (token) => {
		await loadFullIndex(token);
		const localKeys = new Set(await objKeys());
		const todo = Object.keys(index).filter((k) => k !== DB_NAME && !localKeys.has(k));
		total = todo.length;
		await parallel(todo, async (key) => {
			await fetchImageFromDrive(key);
			n++;
			sync.phase = `이미지 받는 중… (${n}/${total})`;
		});
	});
	return { downloaded: n, total };
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

/** pull 을 지금 하면 안 되는 상황(요청 진행 중) — 오류가 아니라 다음 확인으로 미룸. */
class SyncDeferred extends Error {
	constructor() {
		super('deferred');
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

// ── 설정 모달 정보 ─────────────────────────────────────────

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
