import { loadJson } from '$lib/api/load';
import type { ChatPageLoadData } from '$lib/api/chat';
import type { PageLoad } from './$types';

// 데이터는 단일 엔드포인트(GET /api/chat/page)에서 — 세션·디버그 라우트와 동일 형태(ChatPageLoadData).
export const load: PageLoad = async ({ fetch, params, url }) => {
	const o = url.searchParams.get('o') ?? '';
	const s = url.searchParams.get('s') ?? '';
	const query = `/api/chat/page?characterId=${params.id}&sessionId=&o=${o}&s=${s}`;
	return loadJson<ChatPageLoadData>(fetch, query);
};
