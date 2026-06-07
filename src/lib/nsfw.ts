/**
 * NSFW 노출 게이트(클라·서버 공용 순수함수).
 *
 * 규칙: 프로필 국가가 **파라과이(PY)** 인 유저만 NSFW 콘텐츠를 본다.
 * 비로그인·미선택(NULL)·대한민국(KR)은 SFW 만.
 *
 * 직접 접근(특정 캐릭터 채팅/에셋)에서는 **제작자 본인**은 이 게이트와 무관하게 자기 캐릭터에
 * 접근 가능해야 하므로, 호출부에서 `canSeeNsfw(user) || character.creator.id === user?.id` 로 합친다.
 */
export function canSeeNsfw(user: { country?: string | null } | null | undefined): boolean {
	return user?.country === 'PY';
}
