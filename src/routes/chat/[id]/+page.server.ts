import { error, redirect } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import { getCharacterOwnership } from '$lib/server/db/characters';
import { getSession, getSessionMessages } from '$lib/server/db/chats';
import type { ChatMessage } from '$lib/types';
import type { PageServerLoad } from './$types';

/**
 * 세션 진입 규칙:
 *  - ?s=<id>  → 그 세션 이어가기 (사이드바 '최근 세션'에서만 진입)
 *  - 그 외   → 항상 새 세션(전송 시 lazy 생성). ?o=<idx> 오프닝, 없으면 0
 * (기존 세션 자동 이어가기 없음 — '채팅 시작하기'는 늘 새로 시작)
 */
export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const db = platform?.env?.DB;
	const character = await findCharacter(db, params.id);
	if (!character) {
		throw error(404, '캐릭터를 찾을 수 없어요.');
	}

	// 비공개 캐릭터는 제작자 본인만 접근 가능 (URL 직접 접근 차단).
	if (character.visibility === 'private') {
		const owner = db ? await getCharacterOwnership(db, params.id) : null;
		if (owner && owner.creatorId !== locals.user?.id) {
			throw error(404, '캐릭터를 찾을 수 없어요.');
		}
	}

	// NSFW 캐릭터는 비로그인 상태에서 접근 불가 (목록에서도 숨겨짐)
	if (character.contentRating === 'nsfw' && !locals.user) {
		redirect(302, '/');
	}

	// 첫 상황(오프닝) 선택 — 메인 상세 모달에서 ?o=<index> 로 전달. 범위 밖이면 기본(0).
	const o = Number(url.searchParams.get('o'));
	const openingIndex = Number.isInteger(o) && o >= 0 && o < character.greetings.length ? o : 0;
	const sessionParam = url.searchParams.get('s');

	// 이어갈 세션은 ?s=<id> 로 명시했을 때만 (사이드바 진입). 그 외엔 항상 새로 시작.
	let resumed: ChatMessage[] | null = null;
	let sessionId: string | null = null;
	if (locals.user && db && sessionParam) {
		const s = await getSession(db, sessionParam, locals.user.id);
		if (s && s.characterId === character.id) {
			sessionId = s.id;
			const msgs = await getSessionMessages(db, sessionId);
			resumed = msgs.map((m) => ({ id: m.id, role: m.role, content: m.content }));
		}
	}

	return { character, user: locals.user, openingIndex, sessionId, resumed };
};
