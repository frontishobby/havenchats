/**
 * 이미지 서비스워커 — `<img src="/img/<key>">` 를 IndexedDB(`haven-images`.`objects`)에서 서빙한다.
 * 페이지 쪽 R2 shim(src/lib/local/r2.ts, idb.ts)과 같은 스키마. `/img/` 외 요청은 건드리지 않는다.
 *
 * 로컬에 없으면(다른 기기에서 만든 이미지) Google Drive 에서 **지연 다운로드**한다:
 *  `haven-meta`.`kv` 의 `drive:index`(키 → Drive 파일 id)와 `drive:token`(액세스 토큰)을 읽어
 *  `alt=media` 로 받아 IndexedDB 에 넣고 응답한다. 토큰이 없거나 만료면 404.
 */
const META_DB = 'haven-meta';
const META_STORE = 'kv';
const IMAGES_DB = 'haven-images';
const IMAGES_STORE = 'objects';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
	if (e.request.method !== 'GET') return;
	const url = new URL(e.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith('/img/')) return;
	e.respondWith(serve(url));
});

function openDb(name, store, keyPath) {
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

function reqp(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function getObject(key) {
	const db = await openDb(IMAGES_DB, IMAGES_STORE, 'key');
	return reqp(db.transaction(IMAGES_STORE, 'readonly').objectStore(IMAGES_STORE).get(key));
}

async function putObject(obj) {
	const db = await openDb(IMAGES_DB, IMAGES_STORE, 'key');
	const tx = db.transaction(IMAGES_STORE, 'readwrite');
	tx.objectStore(IMAGES_STORE).put(obj);
	await new Promise((resolve, reject) => {
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
	});
}

async function kvGet(key) {
	const db = await openDb(META_DB, META_STORE);
	return reqp(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key));
}

/** Drive 지연 다운로드. 성공하면 StoredObject, 아니면 null. */
async function fetchFromDrive(key) {
	const [index, token] = await Promise.all([kvGet('drive:index'), kvGet('drive:token')]);
	const ref = index && index[key];
	if (!ref || !token || !token.accessToken || token.expiresAt < Date.now()) return null;
	const res = await fetch(`${DRIVE_API}/files/${ref.id}?alt=media`, {
		headers: { authorization: `Bearer ${token.accessToken}` }
	});
	if (!res.ok) return null;
	const blob = await res.blob();
	const obj = {
		key,
		blob,
		contentType: blob.type || guessType(key),
		size: blob.size,
		uploaded: Date.now(),
		etag: ref.md5 || String(Date.now())
	};
	await putObject(obj);
	return obj;
}

function guessType(key) {
	const ext = key.split('.').pop().toLowerCase();
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

async function serve(url) {
	const key = decodeURIComponent(url.pathname.slice('/img/'.length));
	try {
		let obj = key ? await getObject(key) : null;
		if (!obj && key) obj = await fetchFromDrive(key);
		if (!obj) return new Response('not found', { status: 404 });
		const versioned = url.searchParams.has('v');
		return new Response(obj.blob, {
			headers: {
				'content-type': obj.contentType || 'application/octet-stream',
				'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
				etag: `"${obj.etag}"`
			}
		});
	} catch (e) {
		return new Response('storage error', { status: 500 });
	}
}
