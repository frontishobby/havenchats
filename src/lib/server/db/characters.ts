import type { Audience, Character, ContentRating, Opening } from '$lib/types';

/** /create 에서 등록되는 새 캐릭터 입력. */
export interface NewCharacter {
	id: string;
	creatorId: string;
	name: string;
	tagline: string;
	/** 설명 — 상세 모달 표시 전용(프롬프트 미반영). */
	intro: string;
	description: string;
	/** R2 오브젝트 키 (char/<id>.<ext>). 이미지 없으면 null. */
	thumbnailKey: string | null;
	audience: Audience;
	contentRating: ContentRating;
	tags: string[];
	/** 첫 상황(오프닝) 목록. 최소 1개. */
	greetings: Opening[];
}

interface CharacterRow {
	id: string;
	name: string;
	tagline: string;
	intro: string;
	description: string;
	thumbnail_key: string | null;
	audience: string;
	content_rating: string;
	tags: string;
	greetings: string;
	chats: number;
}

/** dicebear 폴백 아바타 (이미지 미등록 시). */
function fallbackAvatar(seed: string): string {
	return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(seed)}&backgroundColor=7c5cff,ff5c8a,4cc9f0,b5179e&backgroundType=gradientLinear`;
}

function toAudience(v: string): Audience {
	return v === 'male' || v === 'female' ? v : 'all';
}

/** JSON 문자열을 string[] 로 안전 파싱 (손상 시 빈 배열). */
function parseStringArray(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
	} catch {
		// 무시
	}
	return [];
}

/** JSON 문자열을 Opening[] 로 안전 파싱. 구버전(string[]) 도 호환. */
function parseOpenings(json: string): Opening[] {
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((o): Opening | null => {
				if (typeof o === 'string') return { name: '', content: o };
				if (o && typeof o.content === 'string') {
					return { name: typeof o.name === 'string' ? o.name : '', content: o.content };
				}
				return null;
			})
			.filter((o): o is Opening => o !== null);
	} catch {
		return [];
	}
}

function rowToCharacter(row: CharacterRow): Character {
	return {
		id: row.id,
		name: row.name,
		avatarUrl: row.thumbnail_key ? `/img/${row.thumbnail_key}` : fallbackAvatar(row.id),
		tagline: row.tagline,
		intro: row.intro,
		description: row.description,
		greetings: parseOpenings(row.greetings),
		tags: parseStringArray(row.tags),
		contentRating: row.content_rating === 'nsfw' ? 'nsfw' : 'sfw',
		audience: toAudience(row.audience),
		creator: '@user',
		chats: row.chats
	};
}

const SELECT_COLS =
	'id, name, tagline, intro, description, thumbnail_key, audience, content_rating, tags, greetings, chats';

/** 등록된 모든 유저 캐릭터 (최신순). */
export async function listCharacters(db: D1Database): Promise<Character[]> {
	const { results } = await db
		.prepare(`SELECT ${SELECT_COLS} FROM characters ORDER BY created_at DESC`)
		.all<CharacterRow>();
	return (results ?? []).map(rowToCharacter);
}

/** 특정 유저가 만든 캐릭터 목록 (최신순). */
export async function listCharactersByCreator(
	db: D1Database,
	creatorId: string
): Promise<Character[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLS} FROM characters WHERE creator_id = ? ORDER BY created_at DESC`
		)
		.bind(creatorId)
		.all<CharacterRow>();
	return (results ?? []).map(rowToCharacter);
}

/** 소유권·이미지 키 확인용 메타. 캐릭터 없으면 null. */
export async function getCharacterOwnership(
	db: D1Database,
	id: string
): Promise<{ creatorId: string; thumbnailKey: string | null } | null> {
	const row = await db
		.prepare(`SELECT creator_id, thumbnail_key FROM characters WHERE id = ?`)
		.bind(id)
		.first<{ creator_id: string; thumbnail_key: string | null }>();
	return row ? { creatorId: row.creator_id, thumbnailKey: row.thumbnail_key } : null;
}

/** 단일 유저 캐릭터 조회. */
export async function getCharacterById(db: D1Database, id: string): Promise<Character | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLS} FROM characters WHERE id = ?`)
		.bind(id)
		.first<CharacterRow>();
	return row ? rowToCharacter(row) : null;
}

/** 캐릭터 수정 가능한 필드. thumbnailKey 가 주어지면 교체, undefined 면 기존 유지. */
export interface CharacterUpdate {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	audience: Audience;
	contentRating: ContentRating;
	tags: string[];
	greetings: Opening[];
	/** 새 이미지 키. undefined 면 썸네일 변경 없음. */
	thumbnailKey?: string;
}

/** 기존 캐릭터 수정. */
export async function updateCharacter(
	db: D1Database,
	id: string,
	c: CharacterUpdate
): Promise<void> {
	const now = Date.now();
	const setThumb = c.thumbnailKey !== undefined;
	await db
		.prepare(
			`UPDATE characters SET
			   name = ?, tagline = ?, intro = ?, description = ?,
			   audience = ?, content_rating = ?, tags = ?, greetings = ?,
			   ${setThumb ? 'thumbnail_key = ?,' : ''}
			   updated_at = ?
			 WHERE id = ?`
		)
		.bind(
			...[
				c.name,
				c.tagline,
				c.intro,
				c.description,
				c.audience,
				c.contentRating,
				JSON.stringify(c.tags),
				JSON.stringify(c.greetings),
				...(setThumb ? [c.thumbnailKey] : []),
				now,
				id
			]
		)
		.run();
}

/** 캐릭터 삭제. */
export async function deleteCharacter(db: D1Database, id: string): Promise<void> {
	await db.prepare(`DELETE FROM characters WHERE id = ?`).bind(id).run();
}

/** 새 캐릭터 저장. */
export async function createCharacter(db: D1Database, c: NewCharacter): Promise<void> {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO characters
			   (id, creator_id, name, tagline, intro, description, thumbnail_key, audience, content_rating, tags, greetings, chats, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
		)
		.bind(
			c.id,
			c.creatorId,
			c.name,
			c.tagline,
			c.intro,
			c.description,
			c.thumbnailKey,
			c.audience,
			c.contentRating,
			JSON.stringify(c.tags),
			JSON.stringify(c.greetings),
			now,
			now
		)
		.run();
}
