import { error, redirect } from '@sveltejs/kit';
import { getCharacterById, getCharacterOwnership } from '$lib/server/db/characters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	if (!locals.user) {
		redirect(302, '/');
	}
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const owner = await getCharacterOwnership(db, params.id);
	if (!owner) error(404, '캐릭터를 찾을 수 없어요.');
	if (owner.creatorId !== locals.user.id) error(403, '내가 만든 캐릭터만 수정할 수 있어요.');

	const character = await getCharacterById(db, params.id);
	if (!character) error(404, '캐릭터를 찾을 수 없어요.');

	// charx(로컬·기기 한정) 캐릭터는 수정 불가 — 장면 이미지가 R2 가 아닌 브라우저에만 있어
	// 폼 저장 시 image_set 이 깨진다. '기기간 공유'로 클라우드 전환한 뒤에야 수정 가능.
	if (character.imageSet?.storage === 'local') {
		redirect(302, `/user/${locals.user.id}`);
	}

	return { character, ownerId: locals.user.id };
};
