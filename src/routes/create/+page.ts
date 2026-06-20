import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	// 캐릭터 만들기는 로그인 필수.
	const { user } = await parent();
	if (!user) redirect(302, '/');
	return { user };
};
