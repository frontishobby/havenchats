import { error, redirect } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const character = await findCharacter(platform?.env?.DB, params.id);
	if (!character) {
		throw error(404, '캐릭터를 찾을 수 없어요.');
	}

	// NSFW 캐릭터는 비로그인 상태에서 접근 불가 (목록에서도 숨겨짐)
	if (character.contentRating === 'nsfw' && !locals.user) {
		redirect(302, '/');
	}

	// 첫 상황(오프닝) 선택 — 메인 상세 모달에서 ?o=<index> 로 전달. 범위 밖이면 기본(0).
	const o = Number(url.searchParams.get('o'));
	const openingIndex =
		Number.isInteger(o) && o >= 0 && o < character.greetings.length ? o : 0;

	return { character, user: locals.user, openingIndex };
};
