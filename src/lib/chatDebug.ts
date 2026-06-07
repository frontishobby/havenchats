/**
 * 채팅 디버그 스냅샷 타입 — 클라/서버 공용(순수 타입, 부수효과·서버 의존 없음).
 *
 * 서버(`$lib/server/chatAssembly`)가 이 형태로 만들어 응답 메타/inspect 로 내려보내고,
 * 클라(디버그 패널)가 이 타입으로 받아 렌더한다. `$lib/server/*` 는 클라에서 import 할 수
 * 없으므로 형태 정의만 여기 둔다.
 */

/** 디버그 패널에 내려보내는 한 턴의 전체 내부 상태. */
export interface ChatDebugSnapshot {
	/** 'live' = 실제 전송으로 생성, 'preview' = inspect 드라이런. */
	source: 'live' | 'preview';
	model: string;
	userName: string | null;
	userPersona: string | null;
	/** 조립된 최종 system 프롬프트 전문. */
	systemPrompt: string;
	/** 제작자 description 원본(서버 전용 원문 포함). */
	rawDescription: string;
	/** CBS 평가 후 description(치환 전). */
	evaluatedDescription: string;
	/** 평가 못 해 제거한 매크로가 있었나. */
	usedScripting: boolean;
	/** 장면 이미지 카탈로그(없으면 ''). */
	imageCatalog: string;
	/** 이번 턴 주입된 로어 블록(없으면 null). */
	loreBlock: string | null;
	lorebookEntryCount: number;
	/** 모델에 실제로 보낸 메시지 배열(지침·로어 포함). */
	messages: Array<{ role: string; content: string; tokens: number }>;
	/** 입력 가드 적용 후 window(메시지 단위 seq·토큰). */
	window: Array<{ seq: number; role: string; content: string; tokens: number }>;
	fullWindowLen: number;
	windowTrimmed: boolean;
	tokens: {
		system: number;
		inputEst: number;
		inputLimit: number;
		outputReserve: number;
		contextLimit: number;
		windowBudget: number;
		keepRecent: number;
	};
	/** CBS 세션 변수 상태(시딩/이전/평가후). */
	vars: {
		default: Record<string, string>;
		before: Record<string, string>;
		after: Record<string, string>;
	};
	summary: string | null;
	summaryUptoSeq: number;
	memory: string | null;
	settings: { maxSentences: number; userActs: number };
	session: {
		id: string | null;
		characterId: string;
		messageCount: number;
		createdAt: number | null;
		lastMessageAt: number | null;
		imported: boolean;
	};
}

/**
 * 실시간 이미지 생성 디버그 정보 — 디버그 모드에서 `/api/chat/image` 가 응답에 동봉.
 * 디버그 패널이 "어떤 프롬프트/파라미터로 NovelAI 에 요청했는지" 표시하는 데 쓴다.
 */
export interface ImageDebug {
	/** 상황 프롬프트 생성에 사용한 LLM 모델 id. */
	promptModel: string;
	/** 외형 일관성용으로 LLM 에 함께 넣은 캐릭터 description(통짜, 길이 제한 적용). 없으면 ''. */
	characterRef: string;
	/** 정리(trim/공백 압축) 후 상황 프롬프트 — base 와 인물 캡션을 ' | ' 로 합친 표시용(비면 생성 실패). */
	situation: string;
	/** 상황 프롬프트 모델의 원문 응답(구조화 객체를 JSON 문자열로). 빈 응답 진단용. */
	rawSituation: string;
	/** 정리 후 base 장면 캡션(배경·인원수·상호작용 태그). 인물 외형은 characters 에. */
	baseScene?: string;
	/** 정리 후 인물별 char_caption(분리). NAI V4.5 캐릭터 기능으로 외형 누출 방지. */
	characters?: string[];
	/** 상황 프롬프트 호출의 종료 사유(예: stop / length / content-filter). 없으면 null. */
	finishReason: string | null;
	/** 상황 프롬프트 호출 경고(AI SDK warnings). 없으면 빈 배열. */
	warnings: unknown[];
	/** 상황 프롬프트 생성이 예외로 실패한 경우의 에러 메시지. 정상이면 null. */
	llmError: string | null;
	/** 그림체 프롬프트(설정값, 비었으면 기본값 사용됨을 의미). */
	stylePrompt: string;
	/** NovelAI 에 보낸 최종 positive(그림체+상황+퀄리티). 상황 생성 실패 시 null. */
	positive: string | null;
	/** 고정 네거티브 프롬프트. */
	negative: string;
	model: string;
	resolution: string;
	/** 고정 생성 파라미터(표시용). */
	params: {
		sampler: string;
		scheduler: string;
		steps: number;
		cfgScale: number;
		cfgRescale: number;
	};
}
