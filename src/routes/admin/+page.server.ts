import { error } from '@sveltejs/kit';
import { listUsersWithStats, getOverallSummary, getDailyCost } from '$lib/server/db/admin';
import type { PageServerLoad } from './$types';

const DAY = 86_400_000;
const TREND_DAYS = 14;

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const now = Date.now();
	const since7d = now - 7 * DAY;
	const since30d = now - 30 * DAY;
	const sinceTrend = now - TREND_DAYS * DAY;

	const [users, summary, daily] = await Promise.all([
		listUsersWithStats(db, since7d),
		getOverallSummary(db, since7d, since30d),
		getDailyCost(db, sinceTrend)
	]);

	return { users, summary, daily, trendDays: TREND_DAYS };
};
