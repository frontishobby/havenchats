import { getDB } from '$lib/server/db/remote';
import { error } from '@sveltejs/kit';
import {
	getUserDetail,
	getUserStats,
	listCharactersForAdmin
} from '$lib/server/db/admin';
import type { PageServerLoad } from './$types';

const DAY = 86_400_000;

export const load: PageServerLoad = async ({ params, platform }) => {
	const db = getDB(platform);
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const detail = await getUserDetail(db, params.id);
	if (!detail) error(404, '사용자를 찾을 수 없어요.');

	const since7d = Date.now() - 7 * DAY;
	const [stats, characters] = await Promise.all([
		getUserStats(db, params.id, since7d),
		listCharactersForAdmin(db, params.id)
	]);

	return { detail, stats, characters };
};
