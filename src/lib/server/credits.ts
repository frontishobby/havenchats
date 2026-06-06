import { createGateway } from '@ai-sdk/gateway';
import { env } from '$env/dynamic/private';

/** Vercel AI Gateway 크레딧 잔량(USD). 키 없음·조회 실패 시 null(미표시). */
export async function fetchGatewayCredits(): Promise<{
	balance: number;
	totalUsed: number;
} | null> {
	const apiKey = env.AI_GATEWAY_API_KEY;
	if (!apiKey) return null;
	try {
		const c = await createGateway({ apiKey }).getCredits();
		return { balance: Number(c.balance), totalUsed: Number(c.totalUsed) };
	} catch {
		return null; // 게이트웨이 일시 오류가 페이지를 막지 않게.
	}
}
