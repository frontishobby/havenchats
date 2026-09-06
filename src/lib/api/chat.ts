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
	/**
	 * 이어가기(자동 진행): 유저 메시지 없이 캐릭터가 직전 장면을 이어서 서술한다.
	 * true 면 text 는 무시(저장 X)되고, 모델엔 마지막 assistant 응답 뒤에 이어가기 지시만 붙는다.
	 * (입력창이 빈 상태로 전송 버튼을 누르면 클라가 보낸다)
	 */
	continue?: boolean;
	/**
	 * 켜진 모듈 id 목록(순서 유지). 서버가 접근 가능한 것(공유 or 본인 소유)만 골라
	 * 프롬프트 가장 마지막([응답 지침] 뒤)에 첨부한다. 상한 MAX_ACTIVE_MODULES.
	 */
	moduleIds?: string[];
}

// ── 입력 제안(말풍선 버튼): 다음에 유저가 할 법한 행동·대사 3개 ─────────────

/** POST /api/chat/suggest 요청 본문. 현재 장면(요약+최근 대화) 기준으로 유저 입력 후보를 만든다. */
export interface SuggestRequestBody {
	characterId: string;
	sessionId?: string;
	openingIndex?: number;
}

/** POST /api/chat/suggest 응답. */
export interface SuggestResponse {
	/** 유저 입력 후보(보통 3개, 각 1~3문장). 그대로 입력창에 넣어 보낼 수 있는 형태. */
	suggestions: string[];
	/** 제안 LLM 비용(USD). 다음 전송의 inputCost 에 합산해 user 행에 기록. */
	cost: number | null;
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
