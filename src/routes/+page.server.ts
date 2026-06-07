import { getVisibleCharacters } from '$lib/server/characters';
import { canSeeNsfw } from '$lib/nsfw';
import type { PageServerLoad } from './$types';

// NSFW 캐릭터는 파라과이(country=PY) 프로필 유저에게만 노출. 그 외(비로그인·KR·미선택)는 숨김.
export const load: PageServerLoad = async ({ locals, url, platform }) => {
	const visible = await getVisibleCharacters(platform?.env?.DB, canSeeNsfw(locals.user));
	const tags = [...new Set(visible.flatMap((c) => c.tags))];
	return {
		characters: visible,
		tags,
		loggedIn: !!locals.user,
		authError: url.searchParams.get('auth')
	};
};
