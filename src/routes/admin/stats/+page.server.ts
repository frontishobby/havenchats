import { getDB } from '$lib/server/db/remote';
import { error } from '@sveltejs/kit';
import { getModelStats, getCharacterStats, getDailyCost } from '$lib/server/db/admin';
import type { PageServerLoad } from './$types';

const DAY = 86_400_000;
const TREND_DAYS = 14;

/** 기간 옵션 → 시작 epoch ms(전체는 0). 알 수 없는 값은 1일로 폴백. */
const PERIODS: Record<string, number> = {
	'1d': DAY,
	'7d': 7 * DAY,
	'30d': 30 * DAY,
	all: 0
};

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDB(platform);
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	// 최초 진입(쿼리 없음)은 1일.
	const period = url.searchParams.get('period') ?? '1d';
	const span = PERIODS[period] ?? DAY;
	const since = period === 'all' ? 0 : Date.now() - span;

	// 일별 비용 추이는 기간 선택과 무관하게 항상 최근 14일(KST) 고정.
	const sinceTrend = Date.now() - TREND_DAYS * DAY;

	const [models, characters, daily] = await Promise.all([
		getModelStats(db, since),
		getCharacterStats(db, 20, since),
		getDailyCost(db, sinceTrend)
	]);

	// 기간 총 사용액 = 모델별 cost 합(cost 기록된 응답 전부 포함, model NULL 그룹도 합산).
	const totalSpend = models.reduce((a, m) => a + m.costSum, 0);

	return {
		models,
		characters,
		daily,
		trendDays: TREND_DAYS,
		period: period in PERIODS ? period : '1d',
		totalSpend
	};
};
