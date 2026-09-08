import { Hono } from 'hono';
import type { AppEnv } from '$lib/backend/context';

/**
 * 이미지(썸네일·장면·아바타·실시간 생성) 서빙 — `fetch('/img/<key>')` 경로.
 * (`<img src>` 는 서비스워커 `static/img-sw.js` 가 같은 스토어에서 직접 응답한다.)
 * 키 예: char/<uuid>.webp  → URL: /img/char/<uuid>.webp
 */

const IMMUTABLE = 'public, max-age=31536000, immutable';

export const imgRouter = new Hono<AppEnv>();

imgRouter.get('/*', async (c) => {
	const bucket = c.env.IMAGES;
	if (!bucket) return c.text('not found', 404);

	const url = new URL(c.req.url);
	const key = decodeURIComponent(url.pathname.replace(/^\/img\//, ''));
	if (!key) return c.text('not found', 404);

	const obj = await bucket.get(key);
	if (!obj) return c.text('not found', 404);

	const headers = new Headers();
	const contentType = obj.httpMetadata?.contentType;
	if (contentType) headers.set('content-type', contentType);
	headers.set('etag', obj.httpEtag);
	headers.set('cache-control', url.searchParams.has('v') ? IMMUTABLE : 'no-cache');
	return new Response(obj.body, { headers });
});
