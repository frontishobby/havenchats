import type {
	Audience,
	Character,
	CharacterImageSet,
	ContentRating,
	Opening,
	Visibility
} from '$lib/types';

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
	/** 공개 범위. 'private'면 제작자 본인 프로필에서만 노출. */
	visibility: Visibility;
	tags: string[];
	/** 첫 상황(오프닝) 목록. 최소 1개. */
	greetings: Opening[];
	/** 장면 이미지 세트. 없으면 null. */
	imageSet: CharacterImageSet | null;
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
	visibility: string;
	tags: string;
	greetings: string;
	image_set: string | null;
	chats: number;
	creator_id: string;
	creator_name: string | null;
	creator_avatar_key: string | null;
}

/** avatar_url 컬럼(R2 키)을 servable URL 로 변환. 없으면 null. */
function avatarUrlFromKey(key: string | null): string | null {
	return key ? `/img/${key}` : null;
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

/**
 * DB 의 image_set JSON 을 CharacterImageSet 로 안전 파싱. 손상/빈 값이면 null.
 * 축 개수와 각 combo 길이가 안 맞는 엔트리는 버린다(방어적).
 */
function parseImageSet(json: string | null): CharacterImageSet | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const obj = parsed as { axes?: unknown; entries?: unknown };
		if (!Array.isArray(obj.axes) || !Array.isArray(obj.entries)) return null;

		const axes = obj.axes
			.map((a) => {
				const o = (a ?? {}) as { label?: unknown; values?: unknown };
				const label = typeof o.label === 'string' ? o.label : '';
				const values = Array.isArray(o.values)
					? o.values.filter((v): v is string => typeof v === 'string')
					: [];
				return { label, values };
			})
			.filter((a) => a.label && a.values.length > 0);
		if (axes.length === 0) return null;

		const entries = obj.entries
			.map((e) => {
				const o = (e ?? {}) as { id?: unknown; combo?: unknown; ext?: unknown };
				const id = typeof o.id === 'string' ? o.id : '';
				const combo = Array.isArray(o.combo)
					? o.combo.filter((n): n is number => typeof n === 'number')
					: [];
				const ext = typeof o.ext === 'string' ? o.ext : '';
				return { id, combo, ext };
			})
			.filter(
				(e) =>
					e.id &&
					e.ext &&
					e.combo.length === axes.length &&
					e.combo.every((vi, ai) => vi >= 0 && vi < axes[ai].values.length)
			);
		if (entries.length === 0) return null;

		return { axes, entries };
	} catch {
		return null;
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
		visibility: row.visibility === 'private' ? 'private' : 'public',
		creator: {
			id: row.creator_id,
			name: row.creator_name,
			avatarUrl: avatarUrlFromKey(row.creator_avatar_key)
		},
		chats: row.chats,
		imageSet: parseImageSet(row.image_set)
	};
}

// 제작자(users) 를 LEFT JOIN 해 프로필 사진·이름을 함께 읽는다. id 가 양쪽에 있어 컬럼은 모두 c./u. 로 한정.
const SELECT_COLS =
	'c.id, c.name, c.tagline, c.intro, c.description, c.thumbnail_key, c.audience, c.content_rating, c.visibility, c.tags, c.greetings, c.image_set, c.chats, c.creator_id, u.display_name AS creator_name, u.avatar_url AS creator_avatar_key';
const FROM_JOIN = 'FROM characters c LEFT JOIN users u ON u.id = c.creator_id';

/** 공개(public) 유저 캐릭터 전체 (최신순). 비공개는 제외. */
export async function listCharacters(db: D1Database): Promise<Character[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE c.visibility = 'public' ORDER BY c.created_at DESC`
		)
		.all<CharacterRow>();
	return (results ?? []).map(rowToCharacter);
}

/**
 * 특정 유저가 만든 캐릭터 목록 (최신순).
 * includePrivate=false 면 공개 캐릭터만(외부 방문자용), true 면 비공개 포함(본인용).
 */
export async function listCharactersByCreator(
	db: D1Database,
	creatorId: string,
	includePrivate: boolean
): Promise<Character[]> {
	const where = includePrivate
		? 'c.creator_id = ?'
		: "c.creator_id = ? AND c.visibility = 'public'";
	const { results } = await db
		.prepare(`SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE ${where} ORDER BY c.created_at DESC`)
		.bind(creatorId)
		.all<CharacterRow>();
	return (results ?? []).map(rowToCharacter);
}

/** 소유권·이미지 키·공개 범위 확인용 메타. 캐릭터 없으면 null. */
export async function getCharacterOwnership(
	db: D1Database,
	id: string
): Promise<{ creatorId: string; thumbnailKey: string | null; visibility: Visibility } | null> {
	const row = await db
		.prepare(`SELECT creator_id, thumbnail_key, visibility FROM characters WHERE id = ?`)
		.bind(id)
		.first<{ creator_id: string; thumbnail_key: string | null; visibility: string }>();
	return row
		? {
				creatorId: row.creator_id,
				thumbnailKey: row.thumbnail_key,
				visibility: row.visibility === 'private' ? 'private' : 'public'
			}
		: null;
}

/** 단일 유저 캐릭터 조회. */
export async function getCharacterById(db: D1Database, id: string): Promise<Character | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE c.id = ?`)
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
	/** 공개 범위. 'private'면 제작자 본인 프로필에서만 노출. */
	visibility: Visibility;
	tags: string[];
	greetings: Opening[];
	/** 장면 이미지 세트(현재 상태 전체). 없으면 null. */
	imageSet: CharacterImageSet | null;
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
			   audience = ?, content_rating = ?, visibility = ?, tags = ?, greetings = ?, image_set = ?,
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
				c.visibility,
				JSON.stringify(c.tags),
				JSON.stringify(c.greetings),
				c.imageSet ? JSON.stringify(c.imageSet) : null,
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
			   (id, creator_id, name, tagline, intro, description, thumbnail_key, audience, content_rating, visibility, tags, greetings, image_set, chats, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
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
			c.visibility,
			JSON.stringify(c.tags),
			JSON.stringify(c.greetings),
			c.imageSet ? JSON.stringify(c.imageSet) : null,
			now,
			now
		)
		.run();
}
