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
	// /api/me 를 await 하지 않고 promise 로 흘려보낸다(streaming) → 셸·페이지 콘텐츠는
	// 응답을 기다리지 않고 즉시 렌더되고, 유저 의존 UI(프로필/사이드바/크레딧)만 도착 후 채워진다.
	return { me: loadJson<MeData>(fetch, '/api/me') };
};
