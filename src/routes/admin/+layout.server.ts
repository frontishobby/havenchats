import { requireAdmin } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

/**
 * /admin 전체 게이트. 관리자(owner@example.com) 외에는 비로그인이든 일반 유저든
 * 모두 404 로 처리(존재 자체를 숨김). 하위 모든 라우트가 이 게이트를 상속한다.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	requireAdmin(locals.user?.email);
	return { user: locals.user };
};
