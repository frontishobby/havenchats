/**
 * 이미지 서비스워커 — `<img src="/img/<key>">` 를 IndexedDB(`haven-images`.`objects`)에서 서빙한다.
 * 페이지 쪽 R2 shim(src/lib/local/r2.ts, idb.ts)과 같은 스키마. `/img/` 외 요청은 건드리지 않는다.
 */
const IMAGES_DB = 'haven-images';
const IMAGES_STORE = 'objects';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
	if (e.request.method !== 'GET') return;
	const url = new URL(e.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith('/img/')) return;
	e.respondWith(serve(url));
});

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(IMAGES_DB, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(IMAGES_STORE)) {
				db.createObjectStore(IMAGES_STORE, { keyPath: 'key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function getObject(key) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(IMAGES_STORE, 'readonly');
		const req = tx.objectStore(IMAGES_STORE).get(key);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function serve(url) {
	const key = decodeURIComponent(url.pathname.slice('/img/'.length));
	try {
		const obj = key ? await getObject(key) : null;
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
