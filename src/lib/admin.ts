/**
 * 관리자 신원 판별 — 클라이언트/서버 공용 (env 의존 없음).
 *
 * 클라이언트 컴포넌트는 `$lib/server/*` 를 import 할 수 없으므로(빌드 차단),
 * 관리자 이메일 상수를 양쪽에서 쓰려면 server 밖에 있어야 한다.
 * `$lib/server/auth` 는 이 모듈을 re-export 하므로 서버 코드의 import 경로는 그대로 유지된다.
 */

/** 관리자 이메일(단일 소스). */
export const ADMIN_EMAIL = 'owner@example.com';

/** 관리자 여부. (대소문자·공백 무시) */
export function isAdmin(email: string | null | undefined): boolean {
	return !!email && email.trim().toLowerCase() === ADMIN_EMAIL;
}
