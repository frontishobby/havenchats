import { redirect } from '@sveltejs/kit';
import { listCharactersByCreator } from '$lib/server/db/characters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	// 캐릭터 관리는 로그인 필수
	if (!locals.user) {
		redirect(302, '/');
	}
	const db = platform?.env?.DB;
	const characters = db ? await listCharactersByCreator(db, locals.user.id) : [];
	return { characters };
};
