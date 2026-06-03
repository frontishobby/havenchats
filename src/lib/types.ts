export type ContentRating = 'sfw' | 'nsfw';

/** 타깃 독자층. 'all'=공통, 'male'=남성향, 'female'=여성향. */
export type Audience = 'all' | 'male' | 'female';

/** 첫 상황(오프닝) 하나. name=선택용 이름(라벨), content=실제 첫 메시지 본문. */
export interface Opening {
	name: string;
	content: string;
}

export interface Character {
	id: string;
	name: string;
	avatarUrl: string;
	tagline: string;
	/**
	 * 설명 — 캐릭터를 눌렀을 때 상세 모달에 보이는 소개글.
	 * 표시 전용이며 시스템 프롬프트(description)에는 포함되지 않는다. 비어있을 수 있다.
	 */
	intro: string;
	/**
	 * 제작자가 작성하는 시스템 프롬프트 본문 — 사실상 전체 프롬프트.
	 * 역할 선언(캐릭터 연기/내레이터/시뮬레이션/어시스턴트 등), 세계관·말투·설정,
	 * 출력 형식(소설 형식·대사 형식 등)까지 모두 제작자가 기호에 맞게 자유롭게 기입한다.
	 * 서버는 여기에 "상대(사용자) 정보"와 "가드레일"이라는 공통 부분만 덧붙인다.
	 * 조립 로직: src/routes/api/chat/+server.ts 의 buildSystemPrompt()
	 */
	description: string;
	/**
	 * 첫 상황(오프닝) 목록 — 각 항목이 채팅 시작 시 assistant 의 첫 메시지가 된다.
	 * 최소 1개(기본 상황) 필수. 2개 이상이면 상세 모달에서 이름(name)으로 골라 시작한다.
	 */
	greetings: Opening[];
	tags: string[];
	contentRating: ContentRating;
	/** 타깃 독자층(공통/남성향/여성향). */
	audience: Audience;
	creator: string;
	/** 인기도(누적 대화 수) */
	chats: number;
}

export type Role = 'user' | 'assistant';

export interface ChatMessage {
	id: string;
	role: Role;
	content: string;
}

/** DB 영속 메시지 — ChatMessage + 세션 내 순번(seq). */
export interface StoredMessage extends ChatMessage {
	seq: number;
}

/** 대화 세션. summary/summary_upto_seq 가 토큰 전략(요약+window)의 상태. */
export interface ChatSession {
	id: string;
	userId: string;
	characterId: string;
	model: string | null;
	summary: string | null;
	summaryUptoSeq: number;
	messageCount: number;
	createdAt: number;
	updatedAt: number;
	lastMessageAt: number | null;
}

/** 사이드바(최근 채팅) 한 줄. 세션 + 캐릭터 메타 + 마지막 대사 미리보기. */
export interface RecentChat {
	sessionId: string;
	characterId: string;
	characterName: string;
	avatarUrl: string;
	preview: string;
	lastMessageAt: number | null;
}
