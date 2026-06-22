import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin';
import type { LayoutLoad } from './$types';

/**
 * /admin 전체 게이트. 관리자 외에는 홈으로 보낸다(UX 가드 — API 도 별도로 강제).
 * 하위 모든 라우트가 이 게이트를 상속한다.
 */
export const load: LayoutLoad = async ({ parent }) => {
	const { user } = await (await parent()).me;
	if (!isAdmin(user?.email)) redirect(302, '/');
	return { user };
};
