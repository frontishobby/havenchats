import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// charx 가져오기는 관리자(frontishobby) 전용. 그 외에는 비노출 → 홈으로.
	if (!locals.user || !isAdmin(locals.user.email)) {
		redirect(302, '/');
	}
	return { user: locals.user };
};
