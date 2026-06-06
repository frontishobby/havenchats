import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * R2(IMAGES) 의 이미지(썸네일·장면·아바타)를 서빙한다.
 * 키 예: char/<uuid>.webp  → URL: /img/char/<uuid>.webp
 *
 * 캐싱 전략 (URL 에 `?v=` 버전 쿼리가 있는지로 분기):
 *  - 버전 있음 → `immutable, max-age=1년`. 키는 엔티티 id 로 고정이지만 재업로드 시
 *    제작자/유저의 updatedAt 이 바뀌어 ?v= 가 달라지므로 stale 없이 영구 캐시 가능.
 *  - 버전 없음 → `max-age=1일`(보수적). 일부 미버전 경로(charx import 등) 안전망.
 *
 * 엣지 캐시(Cache API, caches.default): 같은 colo 의 여러 유저가 공유 → R2 왕복 제거(지연↓).
 * `cf-cache-status` 는 Worker 응답엔 신뢰 못 하므로 직접 `x-cache: HIT|MISS|BYPASS` 를 붙인다.
 * (dev/vite 에는 caches 글로벌이 없어 BYPASS.)
 */

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=86400';

export const GET: RequestHandler = async ({ params, platform, request, url }) => {
	const bucket = platform?.env?.IMAGES;
	if (!bucket) throw error(404, 'not found');

	const versioned = url.searchParams.has('v');
	const cacheControl = versioned ? IMMUTABLE : SHORT;

	// 엣지 캐시 — 키는 ?v= 포함 전체 URL(버전 바뀌면 자동 별도 엔트리).
	// platform.caches 는 adapter-cloudflare 가 제공(dev/vite 엔 없음 → BYPASS).
	const cache = platform?.caches?.default;
	const cacheKey = new Request(url.toString(), { method: 'GET' });

	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const r = new Response(hit.body, hit);
			r.headers.set('x-cache', 'HIT');
			return r;
		}
	}

	const obj = await bucket.get(params.key);
	if (!obj) throw error(404, 'not found');

	// 조건부 요청: etag 일치 → 304(본문 없이). 미버전 URL 재검증 비용 절감.
	const inm = request.headers.get('if-none-match');
	if (inm && inm === obj.httpEtag) {
		return new Response(null, {
			status: 304,
			headers: { etag: obj.httpEtag, 'cache-control': cacheControl }
		});
	}

	// content-type 은 obj.httpMetadata 에서 직접 읽는다.
	// (obj.writeHttpMetadata(headers) 는 로컬 dev platformProxy 에서 Headers 직렬화 실패 →
	//  DevalueError 로 500. 수동 set 이 dev·prod 양쪽에서 안전.)
	const headers = new Headers();
	const contentType = obj.httpMetadata?.contentType;
	if (contentType) headers.set('content-type', contentType);
	headers.set('etag', obj.httpEtag);
	headers.set('cache-control', cacheControl);

	const res = new Response(obj.body, { headers });

	if (cache) {
		// 본문을 소비하기 전 clone 을 캐시에 저장(응답 지연 없이 백그라운드).
		// dev(getPlatformProxy)의 caches 는 no-op 스텁 → 항상 MISS. prod 워커 런타임선 정상 HIT.
		platform?.context?.waitUntil?.(cache.put(cacheKey, res.clone()));
	}
	res.headers.set('x-cache', cache ? 'MISS' : 'BYPASS');
	return res;
};
