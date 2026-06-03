import { error, redirect } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import { getCharacterOwnership } from '$lib/server/db/characters';
import type { PageServerLoad } from './$types';

/**
 * 캐릭터 에셋(장면 이미지 카탈로그) 미리보기.
 * 접근 규칙은 채팅 진입과 동일: 비공개=제작자만, NSFW=로그인 필수.
 */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform?.env?.DB;
	const character = await findCharacter(db, params.id);
	if (!character) {
		throw error(404, '캐릭터를 찾을 수 없어요.');
	}

	// 비공개 캐릭터는 제작자 본인만 접근 가능.
	if (character.visibility === 'private') {
		const owner = db ? await getCharacterOwnership(db, params.id) : null;
		if (owner && owner.creatorId !== locals.user?.id) {
			throw error(404, '캐릭터를 찾을 수 없어요.');
		}
	}

	// NSFW 캐릭터는 비로그인 접근 불가.
	if (character.contentRating === 'nsfw' && !locals.user) {
		redirect(302, '/');
	}

	return { character };
};
