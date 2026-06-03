import { getVisibleCharacters } from '$lib/server/characters';
import type { PageServerLoad } from './$types';

// 비로그인 상태에서는 NSFW 캐릭터를 숨긴다 (로그인 시에만 노출).
export const load: PageServerLoad = async ({ locals, url, platform }) => {
	const visible = await getVisibleCharacters(platform?.env?.DB, !!locals.user);
	const tags = [...new Set(visible.flatMap((c) => c.tags))];
	return {
		characters: visible,
		tags,
		loggedIn: !!locals.user,
		authError: url.searchParams.get('auth')
	};
};
