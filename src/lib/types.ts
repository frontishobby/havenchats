export type ContentRating = 'sfw' | 'nsfw';

export interface Character {
	id: string;
	name: string;
	avatarUrl: string;
	tagline: string;
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
