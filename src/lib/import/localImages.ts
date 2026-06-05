/**
 * charx import 장면 이미지의 **로컬(브라우저) 저장소** — IndexedDB. 클라이언트 전용.
 *
 * 왜: charx 한 장(.charx)에는 보통 수십 장의 장면 이미지가 들어있다. 이를 매번 R2 에 올리면
 *  ① import 가 느리고 ② 같은 카드를 여러 사람이 가져오면 동일 바이트가 R2 에 중복 누적된다.
 *  charx 캐릭터는 **비공개·이 기기 한정**이므로 바이트는 서버에 둘 이유가 없다 → IndexedDB 에 보관하고
 *  채팅 렌더 시 blob URL 로 표시한다. 서버(D1)에는 메타(id·name·ext)만 두고 storage:'local' 로 표시.
 *  '기기간 공유'(promote)를 누르면 그때 R2 로 올려 일반 캐릭터처럼 전환한다.
 *
 * 키 포맷은 imageCodes.localSceneKey 와 동일: `<characterId>/<id>`.
 */

const DB_NAME = 'haven-local-scenes';
const STORE = 'scenes';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function run<T>(
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(STORE, mode);
				const req = fn(t.objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			})
	);
}

/** 로컬 장면 이미지 키 — `<characterId>/<id>`. */
export function localSceneKey(characterId: string, id: string): string {
	return `${characterId}/${id}`;
}

/** 장면 이미지 한 장을 IndexedDB 에 저장(blob 은 contentType 을 가진 채 보관). */
export async function putLocalScene(characterId: string, id: string, blob: Blob): Promise<void> {
	await run('readwrite', (s) => s.put(blob, localSceneKey(characterId, id)));
}

/** 키로 blob 조회. 없거나 실패하면 null. */
export async function getLocalSceneBlob(key: string): Promise<Blob | null> {
	try {
		const v = await run<Blob | undefined>('readonly', (s) => s.get(key));
		return v ?? null;
	} catch {
		return null;
	}
}

// blob → objectURL 캐시. 같은 키는 한 번만 createObjectURL 하고 Promise 를 재사용해
// 템플릿({#await})이 매 렌더마다 새 URL 을 만들지 않게 한다.
const urlCache = new Map<string, Promise<string | null>>();

/** 키에 해당하는 장면 이미지의 blob URL(없으면 null). 캐시됨. */
export function localSceneURL(key: string): Promise<string | null> {
	let p = urlCache.get(key);
	if (!p) {
		p = getLocalSceneBlob(key).then((b) => (b ? URL.createObjectURL(b) : null));
		urlCache.set(key, p);
	}
	return p;
}

/** 한 캐릭터의 로컬 장면 이미지를 모두 삭제(캐릭터 삭제·promote 후 정리). */
export async function deleteLocalScenes(characterId: string): Promise<void> {
	const prefix = `${characterId}/`;
	try {
		const db = await openDB();
		await new Promise<void>((resolve, reject) => {
			const t = db.transaction(STORE, 'readwrite');
			const store = t.objectStore(STORE);
			const range = IDBKeyRange.bound(prefix, prefix + '￿');
			const req = store.openCursor(range);
			req.onsuccess = () => {
				const cur = req.result;
				if (cur) {
					cur.delete();
					cur.continue();
				}
			};
			t.oncomplete = () => resolve();
			t.onerror = () => reject(t.error);
		});
	} catch {
		// 무시 — 로컬 정리는 best-effort(고아가 남아도 치명적이지 않음).
	}
	// objectURL 캐시도 정리.
	for (const k of [...urlCache.keys()]) {
		if (k.startsWith(prefix)) {
			urlCache
				.get(k)
				?.then((u) => u && URL.revokeObjectURL(u))
				.catch(() => {});
			urlCache.delete(k);
		}
	}
}

/**
 * 저장소 영속화 요청(best-effort) — 브라우저가 용량 압박 시 로컬 이미지를 함부로 비우지 않도록.
 * 거부돼도 무시(그냥 일반 캐시처럼 동작).
 */
export async function requestPersist(): Promise<void> {
	try {
		if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
			await navigator.storage.persist();
		}
	} catch {
		// 무시
	}
}
