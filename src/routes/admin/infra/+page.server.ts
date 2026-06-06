import { error } from '@sveltejs/kit';
import { fetchInfraMetrics } from '$lib/server/cloudflare';
import { estimateBilling } from '$lib/server/cfPricing';
import type { PageServerLoad } from './$types';

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

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const [infra, rows] = await Promise.all([fetchInfraMetrics(), tableRows(db)]);
	const billing = estimateBilling(infra);
	return { infra, rows, billing };
};
