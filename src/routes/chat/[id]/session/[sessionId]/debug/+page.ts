import { error } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin';
import { loadJson } from '$lib/api/load';
import type { ChatPageLoadData } from '$lib/api/chat';
import type { PageLoad } from './$types';

/**
 * 세션 디버그 모드 로더. 메인 채팅과 같은 데이터를 싣되, 시스템 프롬프트·숨김 카드 내부가
 * 노출되므로 **캐릭터 제작자 본인 또는 관리자**에게만 허용한다(그 외 404).
 * (디버그 스냅샷 자체는 클라가 POST /api/chat/inspect 로 따로 가져온다.)
 */
export const load: PageLoad = async ({ fetch, params, url }) => {
	const o = url.searchParams.get('o') ?? '';
	const s = url.searchParams.get('s') ?? '';
	const query = `/api/chat/page?characterId=${params.id}&sessionId=${params.sessionId ?? ''}&o=${o}&s=${s}`;
	const data = await loadJson<ChatPageLoadData>(fetch, query);
	const user = data.user;
	const canDebug = isAdmin(user?.email) || data.character.creator.id === user?.id;
	if (!canDebug) throw error(404, '페이지를 찾을 수 없어요.');
	return data;
};
