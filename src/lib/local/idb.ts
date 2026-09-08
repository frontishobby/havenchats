/**
 * IndexedDB 최소 헬퍼 — 브라우저 런타임의 로컬 저장소.
 *
 * 두 DB 를 쓴다.
 *  - `haven-meta`  (store `kv`)       : SQLite 스냅샷 바이트(`db`) 등 키-값.
 *  - `haven-images`(store `objects`)  : R2 대체. key → { blob, contentType, size, uploaded, etag }.
 *    `static/img-sw.js`(서비스워커)도 같은 스키마로 열어 `<img src="/img/...">` 를 서빙한다 —
 *    스키마를 바꾸면 서비스워커 쪽도 같이 바꿀 것.
 */

export const META_DB = 'haven-meta';
export const META_STORE = 'kv';
export const IMAGES_DB = 'haven-images';
export const IMAGES_STORE = 'objects';

export interface StoredObject {
	key: string;
	blob: Blob;
	contentType: string;
	size: number;
	uploaded: number; // epoch ms
	etag: string;
}

function openDb(name: string, store: string, keyPath?: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(store)) {
				db.createObjectStore(store, keyPath ? { keyPath } : undefined);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

let metaDb: Promise<IDBDatabase> | null = null;
let imagesDb: Promise<IDBDatabase> | null = null;

export function getMetaDb(): Promise<IDBDatabase> {
	return (metaDb ??= openDb(META_DB, META_STORE));
}
export function getImagesDb(): Promise<IDBDatabase> {
	return (imagesDb ??= openDb(IMAGES_DB, IMAGES_STORE, 'key'));
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

// ── kv ──────────────────────────────────────────────────────────
export async function kvGet<T>(key: string): Promise<T | undefined> {
	const db = await getMetaDb();
	const tx = db.transaction(META_STORE, 'readonly');
	return reqToPromise(tx.objectStore(META_STORE).get(key)) as Promise<T | undefined>;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
	const db = await getMetaDb();
	const tx = db.transaction(META_STORE, 'readwrite');
	tx.objectStore(META_STORE).put(value, key);
	await txDone(tx);
}

export async function kvDelete(key: string): Promise<void> {
	const db = await getMetaDb();
	const tx = db.transaction(META_STORE, 'readwrite');
	tx.objectStore(META_STORE).delete(key);
	await txDone(tx);
}

// ── objects ─────────────────────────────────────────────────────
export async function objGet(key: string): Promise<StoredObject | undefined> {
	const db = await getImagesDb();
	const tx = db.transaction(IMAGES_STORE, 'readonly');
	return reqToPromise(tx.objectStore(IMAGES_STORE).get(key)) as Promise<StoredObject | undefined>;
}

export async function objPut(obj: StoredObject): Promise<void> {
	const db = await getImagesDb();
	const tx = db.transaction(IMAGES_STORE, 'readwrite');
	tx.objectStore(IMAGES_STORE).put(obj);
	await txDone(tx);
}

export async function objDelete(keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	const db = await getImagesDb();
	const tx = db.transaction(IMAGES_STORE, 'readwrite');
	const store = tx.objectStore(IMAGES_STORE);
	for (const k of keys) store.delete(k);
	await txDone(tx);
}

/** 모든 키(정렬됨). prefix 필터는 호출부에서. */
export async function objKeys(): Promise<string[]> {
	const db = await getImagesDb();
	const tx = db.transaction(IMAGES_STORE, 'readonly');
	const keys = await reqToPromise(tx.objectStore(IMAGES_STORE).getAllKeys());
	return (keys as string[]).sort();
}

/** 메타(blob 제외 크기·업로드 시각) 목록 — list() 용. */
export async function objMetaAll(): Promise<Omit<StoredObject, 'blob'>[]> {
	const db = await getImagesDb();
	const tx = db.transaction(IMAGES_STORE, 'readonly');
	const all = (await reqToPromise(tx.objectStore(IMAGES_STORE).getAll())) as StoredObject[];
	return all
		.map(({ key, contentType, size, uploaded, etag }) => ({ key, contentType, size, uploaded, etag }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
