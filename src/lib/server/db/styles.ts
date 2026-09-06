import type { ArtStyle } from '$lib/types';
import { imgSrc } from '$lib/imageBase';

/**
 * 그림체(아트 스타일) 영속화 — Hub 공유·즐겨찾기.
 * 썸네일 바이트는 R2(style/<id>.<ext>)에, 메타·프롬프트는 D1(art_styles)에 저장한다.
 */

interface StyleRow {
	id: string;
	creator_id: string;
	creator_name: string | null;
	title: string;
	memo: string | null;
	prompt: string;
	model: string;
	negative: string | null;
	quality: string | null;
	thumbnail_key: string | null;
	shared: number;
	created_at: number;
	updated_at: number;
	favorited: number;
}

const COLS = `s.id, s.creator_id, s.title, s.memo, s.prompt, s.model, s.negative, s.quality, s.thumbnail_key, s.shared, s.created_at, s.updated_at,
	u.display_name AS creator_name`;

function rowToStyle(r: StyleRow): ArtStyle {
	return {
		id: r.id,
		creatorId: r.creator_id,
		creatorName: r.creator_name,
		title: r.title,
		memo: r.memo,
		prompt: r.prompt,
		model: r.model,
		negative: r.negative || null,
		quality: r.quality || null,
		thumbnailUrl: r.thumbnail_key ? `${imgSrc(r.thumbnail_key)}?v=${r.updated_at}` : null,
		shared: r.shared === 1,
		favorited: r.favorited === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

/** Hub 목록(공유=shared 1 만, 최신순). userId 가 있으면 즐겨찾기 여부를 함께 표시. */
export async function listStyles(
	db: D1Database,
	userId: string | null,
	limit = 100
): Promise<ArtStyle[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM art_style_favorites f WHERE f.style_id = s.id AND f.user_id = ?) AS favorited
			 FROM art_styles s JOIN users u ON u.id = s.creator_id
			 WHERE s.shared = 1
			 ORDER BY s.created_at DESC LIMIT ?`
		)
		.bind(userId ?? '', limit)
		.all<StyleRow>();
	return (results ?? []).map(rowToStyle);
}

/** 가장 먼저 공유된 그림체(채팅에서 아무 그림체도 없을 때 기본값). 없으면 null. */
export async function getOldestSharedStyle(
	db: D1Database,
	userId: string | null
): Promise<ArtStyle | null> {
	const row = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM art_style_favorites f WHERE f.style_id = s.id AND f.user_id = ?) AS favorited
			 FROM art_styles s JOIN users u ON u.id = s.creator_id
			 WHERE s.shared = 1
			 ORDER BY s.created_at ASC LIMIT 1`
		)
		.bind(userId ?? '')
		.first<StyleRow>();
	return row ? rowToStyle(row) : null;
}

/** 내가 만든 그림체(공유/저장 모두, 최신순) — 채팅 picker '저장' 그룹. */
export async function listMyCreated(db: D1Database, userId: string): Promise<ArtStyle[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM art_style_favorites f WHERE f.style_id = s.id AND f.user_id = ?) AS favorited
			 FROM art_styles s JOIN users u ON u.id = s.creator_id
			 WHERE s.creator_id = ?
			 ORDER BY s.created_at DESC`
		)
		.bind(userId, userId)
		.all<StyleRow>();
	return (results ?? []).map(rowToStyle);
}

/** 한 그림체 조회(즐겨찾기 여부 포함). */
export async function getStyle(
	db: D1Database,
	id: string,
	userId: string | null
): Promise<ArtStyle | null> {
	const row = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM art_style_favorites f WHERE f.style_id = s.id AND f.user_id = ?) AS favorited
			 FROM art_styles s JOIN users u ON u.id = s.creator_id
			 WHERE s.id = ?`
		)
		.bind(userId ?? '', id)
		.first<StyleRow>();
	return row ? rowToStyle(row) : null;
}

/** 유저가 즐겨찾기한 그림체 목록(채팅 선택지). 최근 즐겨찾기순. */
export async function listFavorites(db: D1Database, userId: string): Promise<ArtStyle[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS}, 1 AS favorited
			 FROM art_style_favorites f
			 JOIN art_styles s ON s.id = f.style_id
			 JOIN users u ON u.id = s.creator_id
			 WHERE f.user_id = ?
			 ORDER BY f.created_at DESC`
		)
		.bind(userId)
		.all<StyleRow>();
	return (results ?? []).map(rowToStyle);
}

/** 내가 만들었거나 즐겨찾기한 그림체(캐릭터 추천 그림체 선택지). 최신순. */
export async function listMine(db: D1Database, userId: string): Promise<ArtStyle[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM art_style_favorites f WHERE f.style_id = s.id AND f.user_id = ?) AS favorited
			 FROM art_styles s JOIN users u ON u.id = s.creator_id
			 WHERE s.creator_id = ?
			    OR EXISTS(SELECT 1 FROM art_style_favorites f2 WHERE f2.style_id = s.id AND f2.user_id = ?)
			 ORDER BY s.created_at DESC`
		)
		.bind(userId, userId, userId)
		.all<StyleRow>();
	return (results ?? []).map(rowToStyle);
}

/** 그림체 생성(공유). id 를 넘기면 그 값을 PK 로 사용(R2 키와 일치시키기 위함). 반환: id. */
export async function createStyle(
	db: D1Database,
	input: {
		creatorId: string;
		title: string;
		memo: string | null;
		prompt: string;
		/** NovelAI 모델 id(호출부에서 허용목록 검증). */
		model: string;
		/** 선택 네거티브/퀄리티 프롬프트(빈값은 null 로 저장). */
		negative: string | null;
		quality: string | null;
		thumbnailKey: string | null;
		shared: boolean;
		id?: string;
	}
): Promise<string> {
	const id = input.id ?? crypto.randomUUID();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO art_styles (id, creator_id, title, memo, prompt, model, negative, quality, thumbnail_key, shared, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			input.creatorId,
			input.title,
			input.memo,
			input.prompt,
			input.model,
			input.negative,
			input.quality,
			input.thumbnailKey,
			input.shared ? 1 : 0,
			now,
			now
		)
		.run();
	return id;
}

/** 공개 여부 변경(저장↔공유). 소유권은 호출부에서 확인. */
export async function setShared(db: D1Database, id: string, shared: boolean): Promise<void> {
	await db
		.prepare('UPDATE art_styles SET shared = ?, updated_at = ? WHERE id = ?')
		.bind(shared ? 1 : 0, Date.now(), id)
		.run();
}

/** 소유자 확인. */
export async function getStyleOwner(
	db: D1Database,
	id: string
): Promise<{ creatorId: string; thumbnailKey: string | null } | null> {
	const row = await db
		.prepare('SELECT creator_id, thumbnail_key FROM art_styles WHERE id = ?')
		.bind(id)
		.first<{ creator_id: string; thumbnail_key: string | null }>();
	return row ? { creatorId: row.creator_id, thumbnailKey: row.thumbnail_key } : null;
}

/** 그림체 삭제(소유권은 호출부에서 확인). 즐겨찾기·캐릭터 추천 참조도 정리. */
export async function deleteStyle(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM art_style_favorites WHERE style_id = ?').bind(id),
		db.prepare('UPDATE characters SET recommended_style_id = NULL WHERE recommended_style_id = ?').bind(id),
		db.prepare('DELETE FROM art_styles WHERE id = ?').bind(id)
	]);
}

/** 즐겨찾기 추가(멱등). */
export async function addFavorite(db: D1Database, userId: string, styleId: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO art_style_favorites (user_id, style_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, style_id) DO NOTHING`
		)
		.bind(userId, styleId, Date.now())
		.run();
}

/** 즐겨찾기 해제. */
export async function removeFavorite(db: D1Database, userId: string, styleId: string): Promise<void> {
	await db
		.prepare('DELETE FROM art_style_favorites WHERE user_id = ? AND style_id = ?')
		.bind(userId, styleId)
		.run();
}

/** 존재 여부(캐릭터 추천 그림체 검증용). */
export async function styleExists(db: D1Database, id: string): Promise<boolean> {
	const row = await db.prepare('SELECT 1 AS x FROM art_styles WHERE id = ?').bind(id).first<{ x: number }>();
	return !!row;
}
