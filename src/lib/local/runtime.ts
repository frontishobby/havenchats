/**
 * 브라우저 런타임 부트스트랩 — 정적 페이지 1인 모드의 '서버'.
 *
 *  1. sql.js(SQLite WASM) 로드 → IndexedDB 스냅샷(`haven-meta.kv.db`)이 있으면 열고 없으면 새로 생성.
 *  2. `migrations/*.sql` 적용, `users` 유일 행('나') 보장.
 *  3. D1 shim(LocalD1)·R2 shim(LocalR2) + Hono 앱 생성 → `window.__havenFetch` 에 연결
 *     (`app.html` 의 fetch 래퍼가 `/api/*`·`/img/*` 를 여기로 보낸다).
 *  4. `/img/*` 를 `<img>` 태그에서도 쓸 수 있게 서비스워커(`/img-sw.js`) 등록·제어권 확보.
 *
 * 영속화: 쓰기 쿼리마다 `scheduleSave()`(디바운스 400ms) → `db.export()` 바이트를 IndexedDB 에 저장.
 * 탭 숨김/닫힘(`pagehide`, `visibilitychange`)에도 즉시 저장. Drive 동기화는 `sync.ts` 가 이 훅에 얹는다.
 */
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import type { WorkerEnv } from '$lib/backend/env';
import { LocalD1 } from './d1';
import { LocalR2, type R2ChangeKind } from './r2';
import { kvGet, kvSet } from './idb';
import { migrate, markAllApplied } from './schema';
import { createLocalApp, createLocalCtx, type LocalRuntimeCtx } from './app';

export const DB_SNAPSHOT_KEY = 'db';
const SAVE_DEBOUNCE_MS = 400;

declare global {
	interface Window {
		__havenFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	}
}

export interface LocalRuntime {
	sql: SqlJsStatic;
	db: Database;
	d1: LocalD1;
	r2: LocalR2;
	ctx: LocalRuntimeCtx;
	userId: string;
	/** 마지막 저장 이후 변경 여부. */
	dirty: boolean;
	/** 진행 중인 `/api` 요청(스트림 본문이 끝날 때까지 포함)이나 백그라운드 작업(waitUntil)이 있는지 — Drive pull 로 DB 를 바꿔도 되는지 판단용. */
	busy: boolean;
	/** 스냅샷을 즉시 IndexedDB 에 저장(대기 중 디바운스 취소). */
	flush(): Promise<void>;
	/** 다른 스냅샷 바이트로 DB 를 교체(Drive 에서 받은 것·백업 복원). */
	replaceDatabase(bytes: Uint8Array): Promise<void>;
	/** DB 스냅샷 바이트(export). */
	exportDatabase(): Uint8Array;
}

type Listener = () => void;
const dbListeners = new Set<Listener>();
const r2Listeners = new Set<(kind: R2ChangeKind, keys: string[]) => void>();

/** DB 스냅샷이 IndexedDB 에 저장될 때마다 호출(Drive 동기화 훅). */
export function onDatabaseSaved(fn: Listener): () => void {
	dbListeners.add(fn);
	return () => dbListeners.delete(fn);
}
/** 이미지 오브젝트 put/delete 시 호출(Drive 동기화 훅). */
export function onObjectsChanged(fn: (kind: R2ChangeKind, keys: string[]) => void): () => void {
	r2Listeners.add(fn);
	return () => r2Listeners.delete(fn);
}

let runtime: LocalRuntime | null = null;
let initPromise: Promise<LocalRuntime> | null = null;

export function getLocalRuntime(): LocalRuntime {
	if (!runtime) throw new Error('local runtime not initialized');
	return runtime;
}

export function initLocalRuntime(): Promise<LocalRuntime> {
	return (initPromise ??= boot());
}

async function boot(): Promise<LocalRuntime> {
	const [sql, snapshot] = await Promise.all([
		initSqlJs({ locateFile: () => wasmUrl }),
		kvGet<Uint8Array>(DB_SNAPSHOT_KEY),
		registerImageWorker()
	]);

	let db = openDatabase(sql, snapshot);

	// ── 영속화 스케줄러 ──
	let timer: ReturnType<typeof setTimeout> | null = null;
	let saving: Promise<void> | null = null;
	const state = { dirty: false };

	const doSave = async () => {
		if (!state.dirty) return;
		state.dirty = false;
		const bytes = db.export();
		await kvSet(DB_SNAPSHOT_KEY, bytes);
		for (const fn of dbListeners) fn();
	};
	const flush = async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (saving) await saving;
		saving = doSave().finally(() => (saving = null));
		await saving;
	};
	const scheduleSave = () => {
		state.dirty = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, SAVE_DEBOUNCE_MS);
	};

	const d1 = new LocalD1(db, scheduleSave);
	const r2 = new LocalR2((kind, keys) => {
		for (const fn of r2Listeners) fn(kind, keys);
	});
	const ctx = createLocalCtx();

	const userId = ensureLocalUser(db, scheduleSave);

	const env = { DB: d1, IMAGES: r2 } as unknown as WorkerEnv;
	const app = createLocalApp(env, ctx, () => rt.userId);
	let inFlight = 0;
	window.__havenFetch = async (input, init) => {
		inFlight++;
		let res: Response;
		try {
			res = await app.fetch(input, init);
		} catch (e) {
			inFlight--;
			throw e;
		}
		if (!res.body) {
			inFlight--;
			return res;
		}
		// 스트리밍 응답(/api/chat 등)은 본문이 끝나거나 취소될 때까지 진행 중으로 본다.
		const src = res.body;
		let ended = false;
		const end = () => {
			if (!ended) {
				ended = true;
				inFlight--;
			}
		};
		const body = new ReadableStream<Uint8Array>({
			start(ctrl) {
				const reader = src.getReader();
				void (async () => {
					try {
						for (;;) {
							const { value, done } = await reader.read();
							if (done) break;
							ctrl.enqueue(value);
						}
						ctrl.close();
					} catch (e) {
						ctrl.error(e);
					} finally {
						end();
					}
				})();
			},
			cancel() {
				src.cancel().catch(() => {});
				end();
			}
		});
		return new Response(body, res);
	};

	const rt: LocalRuntime = {
		sql,
		db,
		d1,
		r2,
		ctx,
		userId,
		get dirty() {
			return state.dirty;
		},
		get busy() {
			return inFlight > 0 || ctx.pending.size > 0;
		},
		flush,
		exportDatabase: () => db.export(),
		replaceDatabase: async (bytes) => {
			await flush();
			const next = openDatabase(sql, bytes);
			db.close();
			db = next;
			// LocalD1 는 db 핸들을 생성자에서 받으므로 새로 만들어 env 에 꽂는다.
			(env as unknown as { DB: LocalD1 }).DB = new LocalD1(db, scheduleSave);
			rt.db = db;
			rt.d1 = env.DB as unknown as LocalD1;
			rt.userId = ensureLocalUser(db, scheduleSave);
			state.dirty = true;
			await flush();
		}
	};

	// 탭 숨김·닫힘 시 즉시 저장(백그라운드 작업은 기다리지 않음 — 완료되면 각자 저장을 다시 건다).
	const onHide = () => void flush();
	window.addEventListener('pagehide', onHide);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') onHide();
	});

	// 새 DB 였다면 첫 스냅샷을 바로 남긴다.
	if (!snapshot) {
		state.dirty = true;
		await flush();
	}

	runtime = rt;
	return rt;
}

function openDatabase(sql: SqlJsStatic, snapshot: Uint8Array | undefined): Database {
	const db = snapshot ? new sql.Database(snapshot) : new sql.Database();
	db.exec('PRAGMA foreign_keys = ON');
	if (snapshot && !hasTable(db, '_migrations') && hasTable(db, 'users')) {
		// 외부(구 D1)에서 가져온 DB — 마이그레이션은 이미 반영된 상태.
		markAllApplied(db);
	}
	migrate(db);
	return db;
}

function hasTable(db: Database, name: string): boolean {
	const r = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]);
	return (r[0]?.values.length ?? 0) > 0;
}

/** users 의 유일한 행 = '나'. 없으면 만든다. */
function ensureLocalUser(db: Database, onWrite: () => void): string {
	const r = db.exec('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
	const existing = r[0]?.values[0]?.[0];
	if (existing) return String(existing);
	const id = crypto.randomUUID();
	const now = Date.now();
	db.run(
		"INSERT INTO users (id, email, display_name, avatar_url, country, age_verified, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'PY', 1, ?, ?)",
		[id, 'me@local', now, now]
	);
	onWrite();
	return id;
}

/**
 * `/img/*` 서비스워커 등록. 첫 방문엔 SW 가 페이지를 아직 제어하지 않아 `<img>` 가 404 가 되므로
 * `clients.claim()` 후 controllerchange 까지 잠깐 기다린다(최대 3초).
 */
async function registerImageWorker(): Promise<void> {
	if (!('serviceWorker' in navigator)) return;
	try {
		await navigator.serviceWorker.register('/img-sw.js', { scope: '/' });
		await navigator.serviceWorker.ready;
		if (navigator.serviceWorker.controller) return;
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 3000);
			navigator.serviceWorker.addEventListener(
				'controllerchange',
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true }
			);
		});
	} catch (e) {
		console.warn('[local] service worker registration failed:', e);
	}
}
