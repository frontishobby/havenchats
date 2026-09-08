const CREDITS_URL = 'https://ai-gateway.vercel.sh/v1/credits';

export interface GatewayCreditsResult {
	balance: number;
	totalUsed: number;
}

/**
 * Vercel AI Gateway 크레딧 잔량(USD) — 유저 **본인 키** 기준. 키가 틀리면 throw(HTTP 401 등).
 *
 * SDK 의 `createGateway().getCredits()` 를 쓰지 않는다: SDK 는 `ai-gateway-auth-method: api-key`
 * 헤더를 붙이는데, 브라우저 요청(Origin 헤더 동반)에선 /v1/credits 가 그 조합을 401 로 거부한다
 * (2026-09-08 실측: Origin 만 → 200, Origin+auth-method → 401, 서버(Origin 없음)+auth-method → 200).
 * 채팅(/v3/ai) 경로는 같은 헤더로도 정상이라 그쪽은 SDK 그대로 둔다.
 */
export class GatewayCreditsError extends Error {
	constructor(public readonly status: number) {
		super(`gateway credits HTTP ${status}`);
	}
}

export async function getGatewayCredits(apiKey: string): Promise<GatewayCreditsResult> {
	const res = await fetch(CREDITS_URL, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	if (!res.ok) throw new GatewayCreditsError(res.status);
	const body = (await res.json()) as { balance?: unknown; total_used?: unknown };
	const balance = Number(body.balance);
	const totalUsed = Number(body.total_used);
	if (!Number.isFinite(balance) || !Number.isFinite(totalUsed)) {
		throw new Error('gateway credits: malformed response');
	}
	return { balance, totalUsed };
}

/**
 * 네비 뱃지용 — 키 없음·일시 오류 시 null(미표시). 키가 거부되면(401/403) `{ invalid: true }` 를
 * 돌려 뱃지가 '키 재등록' 경고를 띄운다(옛 암호문이 남아 있거나 폐기된 키를 조용히 숨기지 않게).
 */
export async function fetchGatewayCredits(
	apiKey: string | null | undefined
): Promise<GatewayCreditsResult | { invalid: true } | null> {
	if (!apiKey) return null;
	try {
		return await getGatewayCredits(apiKey);
	} catch (e) {
		console.warn('[credits] fetch failed', e);
		if (e instanceof GatewayCreditsError && (e.status === 401 || e.status === 403)) {
			return { invalid: true };
		}
		return null;
	}
}
