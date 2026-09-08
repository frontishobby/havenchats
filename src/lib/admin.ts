/**
 * 관리자 판별 — 정적(1인) 런타임에선 유일한 유저가 곧 관리자다.
 * 호출부(디버그 패널·charx import 등 예전 관리자 전용 기능)는 그대로 두고 항상 허용한다.
 */
export function isAdmin(_email?: string | null | undefined): boolean {
	return true;
}

/** 예전 관리자 게이트 — 1인 런타임에선 no-op. */
export function requireAdmin(_email?: string | null | undefined): void {}
