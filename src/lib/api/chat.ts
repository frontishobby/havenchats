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
	/**
	 * 입력 필터(/api/chat/rewrite)로 이 유저 메시지를 변환하는 데 든 비용(USD). 있으면 user 행 cost 로 저장.
	 * (이미지 commit 의 ?cost= 와 같은 클라 보고 방식)
	 */
	inputCost?: number;
}

// ── 입력 필터(유저 입력을 지정 문체·뉘앙스로 변환) ─────────────────────────

/** POST /api/chat/rewrite 요청 본문. 전송 직전 유저 입력을 캐릭터·최근 대화 맥락에 맞춰 다시 쓴다. */
export interface RewriteRequestBody {
	characterId: string;
	/** 이어가는 세션이면 그 id(최근 대화를 맥락으로 씀). 없으면 오프닝만 맥락. */
	sessionId?: string;
	openingIndex?: number;
	/** 원문(유저가 입력창에 쓴 그대로). */
	text: string;
	/** 필터 지시 한 줄(예: "무협지 풍으로"). */
	filter: string;
	/** 변환에 쓸 모델 — 채팅 허용목록(MODEL_IDS) 전체 가능. */
	model?: string;
}

/** POST /api/chat/rewrite 응답. */
export interface RewriteResponse {
	/** 변환된 입력문. */
	text: string;
	/** 변환 LLM 비용(USD). /api/chat 의 inputCost 로 되돌려 보내 user 행에 저장. */
	cost: number | null;
}

// ── 실시간 이미지 생성(클라가 NovelAI 직접 호출) ──────────────────────────

/** POST /api/chat/image/prepare 응답. 클라는 payload 로 NovelAI 를 직접 호출한다. */
export interface ImagePrepareResponse {
	/** NovelAI /ai/generate-image(-stream) 요청 바디. 스트리밍 시 클라가 parameters.stream='msgpack' 을 추가. */
	payload: { input: string; model: string; action: string; parameters: Record<string, unknown> };
	/** 상황 프롬프트 LLM 비용(USD). commit 에 되돌려 보내 메시지 cost 로 저장. */
	cost: number | null;
	/** 디버그 모드일 때만 동봉. */
	debug?: import('$lib/chatDebug').ImageDebug;
}

/** POST /api/chat/image/commit 응답. */
export interface ImageCommitResponse {
	/** 클라가 매칭할 image_generation 메시지 행 id(재생성이면 기존 행). */
	id: string;
	/** R2 키(메시지 content). */
	key: string;
	cost: number | null;
}
