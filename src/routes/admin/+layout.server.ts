import { createGateway } from '@ai-sdk/gateway';
import { env } from '$env/dynamic/private';
import { requireAdmin } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

/** Vercel AI Gateway 크레딧 잔량(USD). 키 없음·조회 실패 시 null(헤더에 미표시). */
async function fetchCredits(): Promise<{ balance: number; totalUsed: number } | null> {
	const apiKey = env.AI_GATEWAY_API_KEY;
	if (!apiKey) return null;
	try {
		const c = await createGateway({ apiKey }).getCredits();
		return { balance: Number(c.balance), totalUsed: Number(c.totalUsed) };
	} catch {
		return null; // 게이트웨이 일시 오류가 어드민 페이지를 막지 않게.
	}
}

/**
 * /admin 전체 게이트. 관리자(owner@example.com) 외에는 비로그인이든 일반 유저든
 * 모두 404 로 처리(존재 자체를 숨김). 하위 모든 라우트가 이 게이트를 상속한다.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	requireAdmin(locals.user?.email);
	return { user: locals.user, credits: await fetchCredits() };
};
