import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	// charx 가져오기는 관리자(frontishobby) 전용. 그 외에는 비노출 → 홈으로.
	const { user } = await (await parent()).me;
	if (!user || !isAdmin(user.email)) redirect(302, '/');
	return { user };
};
