import { loadJson } from '$lib/api/load';
import type { ChatPageLoadData } from '$lib/api/chat';
import type { PageLoad } from './$types';

// 세션 이어가기. 데이터는 메인(/chat/[id])·디버그와 동일하게 GET /api/chat/page.
export const load: PageLoad = async ({ fetch, params, url }) => {
	const o = url.searchParams.get('o') ?? '';
	const s = url.searchParams.get('s') ?? '';
	const query = `/api/chat/page?characterId=${params.id}&sessionId=${params.sessionId ?? ''}&o=${o}&s=${s}`;
	return loadJson<ChatPageLoadData>(fetch, query);
};
