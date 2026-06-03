export type ContentRating = 'sfw' | 'nsfw';

export interface Character {
	id: string;
	name: string;
	avatarUrl: string;
	tagline: string;
	/**
	 * 제작자가 작성하는 시스템 프롬프트 본문 — 사실상 전체 프롬프트.
	 * 역할 선언(캐릭터 연기/내레이터/시뮬레이션/어시스턴트 등), 세계관·말투·설정,
	 * 출력 형식(소설 형식·대사 형식 등)까지 모두 제작자가 기호에 맞게 자유롭게 기입한다.
	 * 서버는 여기에 "상대(사용자) 정보"와 "가드레일"이라는 공통 부분만 덧붙인다.
	 * 조립 로직: src/routes/api/chat/+server.ts 의 buildSystemPrompt()
	 */
	description: string;
	greeting: string;
	tags: string[];
	contentRating: ContentRating;
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
