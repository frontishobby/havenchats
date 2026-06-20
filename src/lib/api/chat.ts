import type { ArtStyle, Character, ChatMessage } from '$lib/types';

/**
 * 채팅 API 공용 타입 — Worker(생산)와 SPA(소비)가 함께 쓴다.
 * (서버 전용 모듈을 클라 번들로 끌어오지 않도록 여기엔 순수 형태만 둔다.)
 */

/** 채팅 페이지 진입 데이터 (구 chatPageLoad). ChatView 가 받는 형태. */
export interface ChatPageLoadData {
	character: Character;
	user: App.Locals['user'];
	openingIndex: number;
	sessionId: string | null;
	resumed: ChatMessage[] | null;
	oldestSeq: number;
	hasMore: boolean;
	/** 캐릭터 제작자가 지정한 추천 그림체(없으면 null). */
	recommendedStyle: ArtStyle | null;
}

/** POST /api/chat 요청 본문. */
export interface ChatRequestBody {
	characterId: string;
	sessionId?: string;
	text: string;
	openingIndex?: number;
	model?: string;
	maxSentences?: number;
	userActs?: number;
	memory?: string;
	userMsgId?: string;
	assistantMsgId?: string;
	debug?: boolean;
}
