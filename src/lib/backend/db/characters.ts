import type {
	Audience,
	Character,
	CharacterImageSet,
	CharacterLorebook,
	CharacterScriptData,
	ContentRating,
	DisplayScript,
	LoreEntry,
	Opening,
	Visibility
} from '$lib/types';
import { withVersion } from '$lib/imageCodes';
import { imgSrc } from '$lib/imageBase';

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
	/** 상세용 고해상도 키(선택). */
	fullImageKey?: string | null;
	audience: Audience;
	contentRating: ContentRating;
	/** 공개 범위. 'private'면 제작자 본인 프로필에서만 노출. */
	visibility: Visibility;
	tags: string[];
	/** 첫 상황(오프닝) 목록. 최소 1개. */
	greetings: Opening[];
	/** 장면 이미지 세트. 없으면 null. */
	imageSet: CharacterImageSet | null;
	/** 로어북(키워드 동적 설정). 없으면 null. */
	lorebook: CharacterLorebook | null;
	/** 스크립트 설정(기본 변수 등, 서버 전용). 없으면 null. */
	scriptData: CharacterScriptData | null;
	/** 표시용 정규식(editdisplay) — imported 카드 감정 스프라이트 HTML. 없으면 null. */
	displayScripts: DisplayScript[] | null;
	/** charx import 캐릭터 여부(프롬프트 숨김·비공개·수정 불가). 기본 false. */
	imported?: boolean;
	/** 제작자 추천 그림체 id(선택). 없으면 null. */
	recommendedStyleId?: string | null;
}

interface CharacterRow {
	id: string;
	name: string;
	tagline: string;
	intro: string;
	description: string;
	thumbnail_key: string | null;
	full_image_key: string | null;
	audience: string;
	content_rating: string;
	visibility: string;
	tags: string;
	greetings: string;
	image_set: string | null;
	lorebook: string | null;
	display_scripts: string | null;
	imported: number;
	recommended_style_id: string | null;
	chats: number;
	updated_at: number;
	creator_id: string;
	creator_name: string | null;
	creator_avatar_key: string | null;
	creator_updated_at: number | null;
}

/** avatar_url 컬럼(R2 키)을 servable URL 로 변환. 없으면 null. version 은 캐시 버스팅. */
function avatarUrlFromKey(key: string | null, version?: number | null): string | null {
	return key ? withVersion(imgSrc(key), version) : null;
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
		const obj = parsed as { kind?: unknown };
		return obj.kind === 'named'
			? parseNamedSet(obj as { images?: unknown; storage?: unknown })
			: parseGridSet(obj as { axes?: unknown; entries?: unknown; storage?: unknown });
	} catch {
		return null;
	}
}

/** image_set JSON 의 storage 필드 해석. 'local' 만 인정, 그 외는 미지정(클라우드). */
function parseStorage(v: unknown): 'local' | undefined {
	return v === 'local' ? 'local' : undefined;
}

/** 그리드 세트 파싱. 축 개수와 각 combo 길이가 안 맞는 엔트리는 버린다(방어적). */
function parseGridSet(obj: { axes?: unknown; entries?: unknown; storage?: unknown }): CharacterImageSet | null {
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

	const storage = parseStorage(obj.storage);
	return { kind: 'grid', axes, entries, ...(storage ? { storage } : {}) };
}

/** 플랫 네임드 세트 파싱. id·name·ext 가 온전한 이미지만 남긴다. */
function parseNamedSet(obj: { images?: unknown; storage?: unknown }): CharacterImageSet | null {
	if (!Array.isArray(obj.images)) return null;
	const images = obj.images
		.map((i) => {
			const o = (i ?? {}) as { id?: unknown; name?: unknown; ext?: unknown };
			const id = typeof o.id === 'string' ? o.id : '';
			const name = typeof o.name === 'string' ? o.name : '';
			const ext = typeof o.ext === 'string' ? o.ext : '';
			return { id, name, ext };
		})
		.filter((i) => i.id && i.name && i.ext);
	if (images.length === 0) return null;
	const storage = parseStorage(obj.storage);
	return { kind: 'named', images, ...(storage ? { storage } : {}) };
}

/**
 * DB 의 lorebook JSON 을 CharacterLorebook 로 안전 파싱. 손상/빈 값이면 null.
 * keys 가 비고 constant 도 아니면(영영 안 켜지는 항목) 버린다(방어적).
 */
function parseLorebook(json: string | null): CharacterLorebook | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const arr = (parsed as { entries?: unknown }).entries;
		if (!Array.isArray(arr)) return null;
		const entries = arr
			.map((e): LoreEntry | null => {
				const o = (e ?? {}) as {
					id?: unknown;
					keys?: unknown;
					content?: unknown;
					constant?: unknown;
					order?: unknown;
				};
				const id = typeof o.id === 'string' ? o.id : '';
				const keys = Array.isArray(o.keys)
					? o.keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
					: [];
				const content = typeof o.content === 'string' ? o.content : '';
				const constant = o.constant === true;
				const order = typeof o.order === 'number' ? o.order : 0;
				if (!id || !content.trim() || (!constant && keys.length === 0)) return null;
				return { id, keys, content, constant, order };
			})
			.filter((e): e is LoreEntry => e !== null);
		return entries.length > 0 ? { entries } : null;
	} catch {
		return null;
	}
}

/** DB 의 display_scripts JSON → DisplayScript[]. 손상/빈 값이면 null. */
function parseDisplayScripts(json: string | null): DisplayScript[] | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return null;
		const out: DisplayScript[] = [];
		for (const s of parsed) {
			if (s && typeof s.in === 'string' && typeof s.out === 'string') {
				out.push({ in: s.in, out: s.out, flags: typeof s.flags === 'string' ? s.flags : 'g' });
			}
		}
		return out.length ? out : null;
	} catch {
		return null;
	}
}

function rowToCharacter(row: CharacterRow): Character {
	const imported = row.imported === 1;
	return {
		id: row.id,
		name: row.name,
		avatarUrl: row.thumbnail_key
			? withVersion(imgSrc(row.thumbnail_key), row.updated_at)
			: fallbackAvatar(row.id),
		fullImageUrl: row.full_image_key ? withVersion(imgSrc(row.full_image_key), row.updated_at) : null,
		tagline: row.tagline,
		intro: row.intro,
		// charx import 캐릭터의 프롬프트는 클라이언트에 절대 노출하지 않는다(빈 문자열).
		// 채팅 조립용 원본은 getCharacterPrompt() 로만 서버에서 읽는다.
		description: imported ? '' : row.description,
		imported,
		greetings: parseOpenings(row.greetings),
		tags: parseStringArray(row.tags),
		contentRating: row.content_rating === 'nsfw' ? 'nsfw' : 'sfw',
		audience: toAudience(row.audience),
		visibility: row.visibility === 'private' ? 'private' : 'public',
		creator: {
			id: row.creator_id,
			name: row.creator_name,
			avatarUrl: avatarUrlFromKey(row.creator_avatar_key, row.creator_updated_at)
		},
		chats: row.chats,
		updatedAt: row.updated_at,
		imageSet: parseImageSet(row.image_set),
		// imported 캐릭터의 로어북도 숨김 프롬프트 → 클라엔 null. 채팅 조립은 getCharacterLorebook() 으로.
		lorebook: imported ? null : parseLorebook(row.lorebook),
		// 표시용 정규식은 숨김 프롬프트가 아니라 렌더용 → imported 여도 클라로 내려간다.
		displayScripts: parseDisplayScripts(row.display_scripts),
		recommendedStyleId: row.recommended_style_id ?? null
	};
}

// 제작자(users) 를 LEFT JOIN 해 프로필 사진·이름을 함께 읽는다. id 가 양쪽에 있어 컬럼은 모두 c./u. 로 한정.
// chats = 이 캐릭터의 모든 세션에 실제로 남아있는 메시지 행 수 합(개별 삭제 반영).
// characters.chats 컬럼은 더 이상 증가시키지 않으므로 실측 서브쿼리로 대체.
const SELECT_COLS =
	"c.id, c.name, c.tagline, c.intro, c.description, c.thumbnail_key, c.full_image_key, c.audience, c.content_rating, c.visibility, c.tags, c.greetings, c.image_set, c.lorebook, c.display_scripts, c.imported, c.recommended_style_id, c.updated_at, (SELECT COUNT(*) FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.character_id = c.id) AS chats, c.creator_id, u.display_name AS creator_name, u.avatar_url AS creator_avatar_key, u.updated_at AS creator_updated_at";
const FROM_JOIN = 'FROM characters c LEFT JOIN users u ON u.id = c.creator_id';

/** 캐릭터 전체 (최신순). 1인 모드라 공개/비공개 구분 없이 전부. */
export async function listCharacters(db: D1Database): Promise<Character[]> {
	const { results } = await db
		.prepare(`SELECT ${SELECT_COLS} ${FROM_JOIN} ORDER BY c.created_at DESC`)
		.all<CharacterRow>();
	return (results ?? []).map(rowToCharacter);
}

/** 소유권·이미지 키·공개 범위 확인용 메타. 캐릭터 없으면 null. */
export async function getCharacterOwnership(
	db: D1Database,
	id: string
): Promise<{ creatorId: string; thumbnailKey: string | null; fullImageKey: string | null; visibility: Visibility } | null> {
	const row = await db
		.prepare(`SELECT creator_id, thumbnail_key, full_image_key, visibility FROM characters WHERE id = ?`)
		.bind(id)
		.first<{ creator_id: string; thumbnail_key: string | null; full_image_key: string | null; visibility: string }>();
	return row
		? {
				creatorId: row.creator_id,
				thumbnailKey: row.thumbnail_key,
				fullImageKey: row.full_image_key,
				visibility: row.visibility === 'private' ? 'private' : 'public'
			}
		: null;
}

/**
 * 시스템 프롬프트 조립용 원본 description(서버 전용).
 * getCharacterById 는 imported 캐릭터의 description 을 빈 문자열로 가리므로, 채팅 조립 시
 * 이 함수로만 원본을 읽는다. 캐릭터 없으면 null.
 */
export async function getCharacterPrompt(db: D1Database, id: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT description FROM characters WHERE id = ?`)
		.bind(id)
		.first<{ description: string }>();
	return row ? row.description : null;
}

/**
 * 시스템 프롬프트 조립용 원본 로어북(서버 전용).
 * getCharacterById 는 imported 캐릭터의 lorebook 을 null 로 가리므로, 채팅 조립 시 이 함수로 원본을 읽는다.
 * 캐릭터 없거나 로어북 없으면 null.
 */
export async function getCharacterLorebook(
	db: D1Database,
	id: string
): Promise<CharacterLorebook | null> {
	const row = await db
		.prepare(`SELECT lorebook FROM characters WHERE id = ?`)
		.bind(id)
		.first<{ lorebook: string | null }>();
	return row ? parseLorebook(row.lorebook) : null;
}

/** script_data JSON → CharacterScriptData(defaultVariables 만 안전 파싱). 손상/빈 값이면 null. */
function parseScriptData(json: string | null): CharacterScriptData | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const dv = (parsed as { defaultVariables?: unknown }).defaultVariables;
		if (!dv || typeof dv !== 'object' || Array.isArray(dv)) return null;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(dv as Record<string, unknown>)) {
			if (typeof v === 'string') out[k.toLowerCase()] = v;
			else if (typeof v === 'number' || typeof v === 'boolean') out[k.toLowerCase()] = String(v);
		}
		return Object.keys(out).length > 0 ? { defaultVariables: out } : null;
	} catch {
		return null;
	}
}

/**
 * 세션 변수 시딩용 캐릭터 기본 변수(서버 전용). 채팅 조립·세션 생성 시에만 읽는다.
 * 캐릭터 없거나 기본 변수 없으면 null.
 */
export async function getCharacterDefaultVars(
	db: D1Database,
	id: string
): Promise<Record<string, string> | null> {
	const row = await db
		.prepare(`SELECT script_data FROM characters WHERE id = ?`)
		.bind(id)
		.first<{ script_data: string | null }>();
	return row ? (parseScriptData(row.script_data)?.defaultVariables ?? null) : null;
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
	/** 로어북(현재 상태 전체). 없으면 null. */
	lorebook: CharacterLorebook | null;
	/** 스크립트 설정(기본 변수 등). 없으면 null. */
	scriptData: CharacterScriptData | null;
	/** 제작자 추천 그림체 id(선택). 없으면 null. */
	recommendedStyleId: string | null;
	/** 새 이미지 키. undefined 면 썸네일 변경 없음. */
	thumbnailKey?: string;
	/** 상세용 고해상도 키. undefined 면 변경 없음, null 이면 제거. */
	fullImageKey?: string | null;
}

/** 기존 캐릭터 수정. */
export async function updateCharacter(
	db: D1Database,
	id: string,
	c: CharacterUpdate
): Promise<void> {
	const now = Date.now();
	const setThumb = c.thumbnailKey !== undefined;
	const setFull = c.fullImageKey !== undefined;
	await db
		.prepare(
			`UPDATE characters SET
			   name = ?, tagline = ?, intro = ?, description = ?,
			   audience = ?, content_rating = ?, visibility = ?, tags = ?, greetings = ?, image_set = ?, lorebook = ?, script_data = ?,
			   recommended_style_id = ?,
			   ${setThumb ? 'thumbnail_key = ?,' : ''}
			   ${setFull ? 'full_image_key = ?,' : ''}
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
				c.lorebook ? JSON.stringify(c.lorebook) : null,
				c.scriptData ? JSON.stringify(c.scriptData) : null,
				c.recommendedStyleId ?? null,
				...(setThumb ? [c.thumbnailKey] : []),
				...(setFull ? [c.fullImageKey ?? null] : []),
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

/** image_set 만 교체(charx import 의 단계적 업로드 → finalize 용). null 이면 장면 이미지 없음. */
export async function updateImageSet(
	db: D1Database,
	id: string,
	imageSet: CharacterImageSet | null
): Promise<void> {
	await db
		.prepare(`UPDATE characters SET image_set = ?, updated_at = ? WHERE id = ?`)
		.bind(imageSet ? JSON.stringify(imageSet) : null, Date.now(), id)
		.run();
}

/** 새 캐릭터 저장. */
export async function createCharacter(db: D1Database, c: NewCharacter): Promise<void> {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO characters
			   (id, creator_id, name, tagline, intro, description, thumbnail_key, full_image_key, audience, content_rating, visibility, tags, greetings, image_set, lorebook, script_data, display_scripts, imported, recommended_style_id, chats, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
		)
		.bind(
			c.id,
			c.creatorId,
			c.name,
			c.tagline,
			c.intro,
			c.description,
			c.thumbnailKey,
			c.fullImageKey ?? null,
			c.audience,
			c.contentRating,
			c.visibility,
			JSON.stringify(c.tags),
			JSON.stringify(c.greetings),
			c.imageSet ? JSON.stringify(c.imageSet) : null,
			c.lorebook ? JSON.stringify(c.lorebook) : null,
			c.scriptData ? JSON.stringify(c.scriptData) : null,
			c.displayScripts && c.displayScripts.length ? JSON.stringify(c.displayScripts) : null,
			c.imported ? 1 : 0,
			c.recommendedStyleId ?? null,
			now,
			now
		)
		.run();
}
