/**
 * 유저별 일일 비용 상한(daily spend cap). KV(SESSIONS 바인딩) 카운터로 추적한다.
 *
 * - 키: `spend:<userId>:<YYYY-MM-DD(KST)>` — 자정(KST)에 자연 리셋.
 * - 값: 누적 비용(USD, 문자열). assistant 추론·이미지 상황프롬프트 비용을 더한다.
 * - TTL 2일로 지난 날짜 키는 자동 소멸(수동 정리 불필요).
 *
 * 함정: KV 는 원자적 increment 가 없다. 동시 턴이 겹치면 read-modify-write 경합으로
 * 약간의 과소집계가 가능하나, $10/일 캡에선 소폭 초과만 발생 → 허용 범위.
 * KV 바인딩이 없으면(예: 키 미설정 로컬) 가드는 **fail-open**(통과)한다.
 */

/** 유저당 하루 추론 비용 상한(USD). 초과 시 다음 자정(KST)까지 채팅/이미지 차단. */
export const DAILY_BUDGET_USD = 10;

/** 지난 날짜 키 자동 소멸용 TTL(초). 2일이면 어제치까지만 남는다. */
const TTL_SECONDS = 60 * 60 * 48;

/** KST(UTC+9) 기준 날짜 문자열(YYYY-MM-DD). 자정(KST)에 카운터가 바뀐다. */
function kstDateKey(nowMs: number): string {
	return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
}

function spendKey(userId: string, nowMs: number): string {
	return `spend:${userId}:${kstDateKey(nowMs)}`;
}

/** 오늘(KST) 누적 사용액(USD). KV 없거나 미기록이면 0. */
export async function getDailySpend(
	kv: KVNamespace | undefined,
	userId: string,
	nowMs: number
): Promise<number> {
	if (!kv) return 0;
	const raw = await kv.get(spendKey(userId, nowMs));
	const n = raw ? Number(raw) : 0;
	return Number.isFinite(n) ? n : 0;
}

/** 일일 상한 도달 여부(요청 전 게이트). KV 없으면 false(통과). */
export async function isOverDailyBudget(
	kv: KVNamespace | undefined,
	userId: string,
	nowMs: number
): Promise<boolean> {
	if (!kv) return false;
	return (await getDailySpend(kv, userId, nowMs)) >= DAILY_BUDGET_USD;
}

/** 이번 턴 비용을 오늘 카운터에 가산(응답 종료 후 호출). cost 가 양수가 아니면 무시. */
export async function addDailySpend(
	kv: KVNamespace | undefined,
	userId: string,
	cost: number | undefined,
	nowMs: number
): Promise<void> {
	if (!kv || !(typeof cost === 'number' && cost > 0)) return;
	const key = spendKey(userId, nowMs);
	const cur = await getDailySpend(kv, userId, nowMs);
	await kv.put(key, String(cur + cost), { expirationTtl: TTL_SECONDS });
}
