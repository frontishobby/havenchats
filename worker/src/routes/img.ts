import { Hono } from 'hono';
import { getWaitUntil } from '$lib/server/waitUntil';
import type { AppEnv } from '../context';

/**
 * R2(IMAGES) 의 이미지(썸네일·장면·아바타)를 서빙한다.
 * 키 예: char/<uuid>.webp  → URL: /img/char/<uuid>.webp
 *
 * 캐싱: `?v=` 버전 쿼리 있으면 immutable 1년, 없으면 1일(보수적).
 * 엣지 캐시(global caches.default): 같은 colo 의 여러 유저가 공유 → R2 왕복 제거.
 */

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=86400';

export const imgRouter = new Hono<AppEnv>();

imgRouter.get('/*', async (c) => {
	const bucket = c.env.IMAGES;
	if (!bucket) return c.text('not found', 404);

	// '/img/' 프리픽스를 떼어 R2 키 복원(디코딩 포함).
	const url = new URL(c.req.url);
	const key = decodeURIComponent(url.pathname.replace(/^\/img\//, ''));
	if (!key) return c.text('not found', 404);

	const versioned = url.searchParams.has('v');
	const cacheControl = versioned ? IMMUTABLE : SHORT;

	// 엣지 캐시 — 키는 ?v= 포함 전체 URL.
	const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
	const cacheKey = new Request(url.toString(), { method: 'GET' });

	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const r = new Response(hit.body, hit);
			r.headers.set('x-cache', 'HIT');
			return r;
		}
	}

	const obj = await bucket.get(key);
	if (!obj) return c.text('not found', 404);

	// 조건부 요청: etag 일치 → 304.
	const inm = c.req.header('if-none-match');
	if (inm && inm === obj.httpEtag) {
		return new Response(null, {
			status: 304,
			headers: { etag: obj.httpEtag, 'cache-control': cacheControl }
		});
	}

	const headers = new Headers();
	const contentType = obj.httpMetadata?.contentType;
	if (contentType) headers.set('content-type', contentType);
	headers.set('etag', obj.httpEtag);
	headers.set('cache-control', cacheControl);

	const res = new Response(obj.body, { headers });

	if (cache) {
		getWaitUntil()(cache.put(cacheKey, res.clone()));
	}
	res.headers.set('x-cache', cache ? 'MISS' : 'BYPASS');
	return res;
});
