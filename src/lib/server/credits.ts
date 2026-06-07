import { createGateway } from '@ai-sdk/gateway';

/**
 * Vercel AI Gateway 크레딧 잔량(USD) — 유저 **본인 키** 기준. 키 없음·조회 실패 시 null(미표시).
 * 네비 상단 뱃지에서 자기 키 잔량을 보여줄 때 쓴다.
 */
export async function fetchGatewayCredits(
	apiKey: string | null | undefined
): Promise<{ balance: number; totalUsed: number } | null> {
	if (!apiKey) return null;
	try {
		const c = await createGateway({ apiKey }).getCredits();
		return { balance: Number(c.balance), totalUsed: Number(c.totalUsed) };
	} catch {
		return null; // 게이트웨이 일시 오류가 페이지를 막지 않게.
	}
}
