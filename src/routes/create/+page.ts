import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	// 캐릭터 만들기는 로그인 필수. (layout 은 me 를 promise 로 흘리므로 여기서 await)
	const { user } = await (await parent()).me;
	if (!user) redirect(302, '/');
	return { user };
};
