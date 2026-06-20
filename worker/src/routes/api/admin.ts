import { Hono } from 'hono';
import type { AppEnv } from '../../context';
import { requireUser } from '../../context';
import { requireAdmin } from '$lib/server/auth';
import { HttpError } from '$lib/server/httpError';
import {
	listUsersWithStats,
	getOverallSummary,
	getModelStats,
	getCharacterStats,
	getDailyCost,
	getUserDetail,
	getUserStats,
	listCharactersForAdmin
} from '$lib/server/db/admin';
import { fetchInfraMetrics } from '$lib/server/cloudflare';
import { estimateBilling } from '$lib/server/cfPricing';
import { setBlockedReason } from '$lib/server/db/users';

export const adminRouter = new Hono<AppEnv>();

const DAY = 86_400_000;
const TREND_DAYS = 14;

/** 기간 옵션 → 시작 epoch ms(전체는 0). 알 수 없는 값은 1일로 폴백. */
const PERIODS: Record<string, number> = {
	'1d': DAY,
	'7d': 7 * DAY,
	'30d': 30 * DAY,
	all: 0
};

// ── 관리자 메인(유저 목록 + 전체 요약) ─────────────────────────
adminRouter.get('/overview', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email);

	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');

	const now = Date.now();
	const since7d = now - 7 * DAY;
	const since30d = now - 30 * DAY;

	const [users, summary] = await Promise.all([
		listUsersWithStats(db),
		getOverallSummary(db, since7d, since30d)
	]);

	return c.json({ users, summary });
});

// ── 인프라/과금 추정 ───────────────────────────────────────────
/** D1 binding 으로 직접 센 테이블별 행 수(Analytics 권한과 무관하게 항상 동작). */
async function tableRows(db: D1Database): Promise<{ table: string; rows: number }[]> {
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM users) AS users,
			   (SELECT COUNT(*) FROM oauth_accounts) AS oauth_accounts,
			   (SELECT COUNT(*) FROM characters) AS characters,
			   (SELECT COUNT(*) FROM chat_sessions) AS chat_sessions,
			   (SELECT COUNT(*) FROM chat_messages) AS chat_messages`
		)
		.first<Record<string, number>>();
	const order = ['users', 'oauth_accounts', 'characters', 'chat_sessions', 'chat_messages'];
	return order.map((t) => ({ table: t, rows: row?.[t] ?? 0 }));
}

adminRouter.get('/infra', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email);

	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');

	const [infra, rows] = await Promise.all([fetchInfraMetrics(), tableRows(db)]);
	const billing = estimateBilling(infra);
	return c.json({ infra, rows, billing });
});

// ── 사용 통계(모델/캐릭터/일별 비용) ───────────────────────────
adminRouter.get('/stats', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email);

	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');

	// 최초 진입(쿼리 없음)은 1일.
	const period = c.req.query('period') ?? '1d';
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

	return c.json({
		models,
		characters,
		daily,
		trendDays: TREND_DAYS,
		period: period in PERIODS ? period : '1d',
		totalSpend
	});
});

// ── 유저 상세(프로필 + 사용량 + 제작 캐릭터) ───────────────────
adminRouter.get('/users/:id', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email);

	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');

	const id = c.req.param('id');
	const detail = await getUserDetail(db, id);
	if (!detail) throw new HttpError(404, '사용자를 찾을 수 없어요.');

	const since7d = Date.now() - 7 * DAY;
	const [stats, characters] = await Promise.all([
		getUserStats(db, id, since7d),
		listCharactersForAdmin(db, id)
	]);

	return c.json({ detail, stats, characters });
});

// ── 유저 차단/해제 ─────────────────────────────────────────────
/**
 * body: { reason: string | null } — 사유가 있으면 차단, 비었으면(null/'') 해제.
 * 비관리자/비로그인은 404(존재 은폐). 관리자 자기 자신은 차단 불가(자물쇠 방지).
 */
adminRouter.post('/users/:id/block', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email);

	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');

	const id = c.req.param('id');
	if (id === user.id) throw new HttpError(400, '자기 자신은 차단할 수 없어요.');

	let reason: string | null = null;
	try {
		const body = (await c.req.json()) as { reason?: unknown };
		if (typeof body.reason === 'string') reason = body.reason;
	} catch {
		// 본문 없음 = 해제
	}

	const saved = await setBlockedReason(db, id, reason);
	return c.json({ blockedReason: saved });
});
