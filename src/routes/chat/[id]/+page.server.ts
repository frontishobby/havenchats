import { error, redirect } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import { getSession, getLatestSession, getSessionMessages } from '$lib/server/db/chats';
import type { ChatMessage } from '$lib/types';
import type { PageServerLoad } from './$types';

/**
 * 세션 진입 규칙:
 *  - ?s=<id>  → 그 세션 이어가기
 *  - ?o=<idx> → 새 세션(전송 시 lazy 생성). 그 오프닝으로 시작
 *  - 둘 다 없음 → 최신 세션 이어가기, 없으면 오프닝 0 으로 새로 시작
 */
export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const db = platform?.env?.DB;
	const character = await findCharacter(db, params.id);
	if (!character) {
		throw error(404, '캐릭터를 찾을 수 없어요.');
	}

	// NSFW 캐릭터는 비로그인 상태에서 접근 불가 (목록에서도 숨겨짐)
	if (character.contentRating === 'nsfw' && !locals.user) {
		redirect(302, '/');
	}

	// 첫 상황(오프닝) 선택 — 메인 상세 모달에서 ?o=<index> 로 전달. 범위 밖이면 기본(0).
	const o = Number(url.searchParams.get('o'));
	const openingIndex = Number.isInteger(o) && o >= 0 && o < character.greetings.length ? o : 0;
	const sessionParam = url.searchParams.get('s');
	const forceNew = url.searchParams.has('o');

	// 이어갈 세션 결정 (로그인 + DB 있을 때만)
	let resumed: ChatMessage[] | null = null;
	let sessionId: string | null = null;
	if (locals.user && db) {
		if (sessionParam) {
			const s = await getSession(db, sessionParam, locals.user.id);
			if (s && s.characterId === character.id) sessionId = s.id;
		} else if (!forceNew) {
			const s = await getLatestSession(db, locals.user.id, character.id);
			if (s) sessionId = s.id;
		}
		if (sessionId) {
			const msgs = await getSessionMessages(db, sessionId);
			resumed = msgs.map((m) => ({ id: m.id, role: m.role, content: m.content }));
		}
	}

	return { character, user: locals.user, openingIndex, sessionId, resumed };
};
