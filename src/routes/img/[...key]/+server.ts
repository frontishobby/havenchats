import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * R2(IMAGES) 에 저장된 캐릭터 썸네일을 서빙한다.
 * 키 예: char/<uuid>.webp  → URL: /img/char/<uuid>.webp
 * 파일명에 콘텐츠 해시가 없으므로 immutable 은 아니지만, 캐릭터당 키가 고정이라
 * 적당한 캐시(1일)만 둔다.
 */
export const GET: RequestHandler = async ({ params, platform }) => {
	const bucket = platform?.env?.IMAGES;
	if (!bucket) throw error(404, 'not found');

	const obj = await bucket.get(params.key);
	if (!obj) throw error(404, 'not found');

	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set('etag', obj.httpEtag);
	headers.set('cache-control', 'public, max-age=86400');
	return new Response(obj.body, { headers });
};
