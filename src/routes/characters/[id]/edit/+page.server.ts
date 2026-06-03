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

	return { character, ownerId: locals.user.id };
};
