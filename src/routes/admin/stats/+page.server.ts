import { error } from '@sveltejs/kit';
import { getModelStats, getCharacterStats } from '$lib/server/db/admin';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const [models, characters] = await Promise.all([
		getModelStats(db),
		getCharacterStats(db, 20)
	]);

	return { models, characters };
};
