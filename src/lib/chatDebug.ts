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
