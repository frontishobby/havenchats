import { error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import { loadChatPage } from '$lib/server/chatPageLoad';
import type { PageServerLoad } from './$types';

/**
 * 채팅 디버그 모드 로더. 메인 채팅과 같은 데이터를 싣되, 시스템 프롬프트·숨김 카드 내부가
 * 노출되므로 **캐릭터 제작자 본인 또는 관리자**에게만 허용한다(그 외 404).
 */
export const load: PageServerLoad = async (event) => {
	const data = await loadChatPage(event);
	const user = event.locals.user;
	const canDebug = isAdmin(user?.email) || data.character.creator.id === user?.id;
	if (!canDebug) throw error(404, '페이지를 찾을 수 없어요.');
	return data;
};
