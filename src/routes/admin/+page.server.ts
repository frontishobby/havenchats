import { error } from '@sveltejs/kit';
import { listUsersWithStats, getOverallSummary } from '$lib/server/db/admin';
import type { PageServerLoad } from './$types';

const DAY = 86_400_000;

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const now = Date.now();
	const since7d = now - 7 * DAY;
	const since30d = now - 30 * DAY;

	const [users, summary] = await Promise.all([
		listUsersWithStats(db),
		getOverallSummary(db, since7d, since30d)
	]);

	return { users, summary };
};
