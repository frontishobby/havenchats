import { error, redirect } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import { getCharacterOwnership } from '$lib/server/db/characters';
import { getSession, getMessagePage } from '$lib/server/db/chats';
import { getStyle } from '$lib/server/db/styles';
import type { ArtStyle, Character, ChatMessage } from '$lib/types';

/** 최초 진입 시 가져올 최근 메시지 수. 더 위로 올리면 같은 크기로 페이징. */
const PAGE_SIZE = 20;

/** ChatView 가 받는 페이지 데이터(메인·디버그 라우트 공용 형태). */
export interface ChatPageLoadData {
	character: Character;
	user: App.Locals['user'];
	openingIndex: number;
	sessionId: string | null;
	resumed: ChatMessage[] | null;
	oldestSeq: number;
	hasMore: boolean;
	/** 캐릭터 제작자가 지정한 추천 그림체(없으면 null). 이미지 모달에 '추천'으로 노출. */
	recommendedStyle: ArtStyle | null;
}

/**
 * 채팅 페이지 로더(메인·디버그·세션 라우트 공용).
 *
 * 세션 진입 규칙:
 *  - `/chat/[id]/session/[sessionId]`  → 그 세션 이어가기 (사이드바 '최근 세션'에서 진입)
 *  - `/chat/[id]` (세션 없음)          → 항상 새 세션(전송 시 lazy 생성). ?o=<idx> 오프닝, 없으면 0
 *  - 구버전 `?s=<id>` 도 하위호환으로 인정.
 */
export async function loadChatPage(opts: {
	params: { id: string; sessionId?: string };
	locals: App.Locals;
	platform: Readonly<App.Platform> | undefined;
	url: URL;
}): Promise<ChatPageLoadData> {
	const { params, locals, platform, url } = opts;
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
	const sessionParam = params.sessionId ?? url.searchParams.get('s');

	// 이어갈 세션은 경로(/session/<id>)나 구버전 ?s=<id> 로 명시했을 때만. 그 외엔 항상 새로 시작.
	let resumed: ChatMessage[] | null = null;
	let sessionId: string | null = null;
	let oldestSeq = 0;
	let hasMore = false;
	if (locals.user && db && sessionParam) {
		const s = await getSession(db, sessionParam, locals.user.id);
		if (s && s.characterId === character.id) {
			sessionId = s.id;
			const page = await getMessagePage(db, sessionId, PAGE_SIZE);
			resumed = page.messages.map((m) => ({
				id: m.id,
				role: m.role,
				content: m.content,
				cost: m.cost
			}));
			oldestSeq = page.oldestSeq;
			hasMore = page.hasMore;
		}
	}

	// 캐릭터 추천 그림체(있으면) 로드 — 이미지 모달에 '제작자 추천'으로 노출.
	let recommendedStyle: ArtStyle | null = null;
	if (db) {
		const row = await db
			.prepare('SELECT recommended_style_id FROM characters WHERE id = ?')
			.bind(params.id)
			.first<{ recommended_style_id: string | null }>();
		if (row?.recommended_style_id) {
			recommendedStyle = await getStyle(db, row.recommended_style_id, locals.user?.id ?? null);
		}
	}

	return {
		character,
		user: locals.user,
		openingIndex,
		sessionId,
		resumed,
		oldestSeq,
		hasMore,
		recommendedStyle
	};
}
