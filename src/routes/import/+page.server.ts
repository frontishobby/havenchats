import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// charx 가져오기는 로그인 필수.
	if (!locals.user) {
		redirect(302, '/');
	}
	return { user: locals.user };
};
