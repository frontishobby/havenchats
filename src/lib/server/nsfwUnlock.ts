import { env } from '$env/dynamic/private';

/**
 * 파라과이(=NSFW 노출) 전환 승인 코드 검증.
 *
 * NSFW 게이트의 실질 방어선은 **서버**다. country='PY' 는 이 코드를 통과해야만 저장된다
 * (클라에서 막아도 직접 POST 로 우회 가능하므로 반드시 서버에서 확인).
 *
 * 기본 코드 'arca'. 운영 중 바꾸려면 env `NSFW_UNLOCK_CODE` 설정(미설정 시 'arca').
 */
export function isValidUnlockCode(code: string | null | undefined): boolean {
	const expected = (env.NSFW_UNLOCK_CODE ?? 'arca').trim();
	return !!code && code.trim() === expected;
}
