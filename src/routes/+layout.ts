import { loadJson } from '$lib/api/load';
import type { MeData } from '$lib/api/pages';
import type { LayoutLoad } from './$types';

// 정적 SPA — 모든 라우트 클라 렌더(서버 로직은 Worker/Hono).
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'ignore';

export const load: LayoutLoad = async ({ fetch, depends }) => {
	// 채팅 전송·세션 삭제 후 invalidate('app:recentChats') 로 사이드바만 새로고침.
	depends('app:recentChats');
	return loadJson<MeData>(fetch, '/api/me');
};
