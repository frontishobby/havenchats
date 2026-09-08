/**
 * NSFW 노출 게이트 — 정적 1인 모드에선 게이트가 없다(유일한 유저 = 성인 본인).
 * 호출부(홈 목록·채팅 진입·에셋 미리보기)의 시그니처는 유지하고 항상 true 를 돌려준다.
 */
export function canSeeNsfw(_user?: unknown): boolean {
	return true;
}
