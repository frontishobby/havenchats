import type { PromptModule } from '$lib/types';

/**
 * 모듈(재사용 프롬프트) 영속화 — Hub 공유·즐겨찾기.
 * 그림체(styles.ts)와 같은 구조에서 썸네일/모델만 뺀 형태. 채팅은 `getModulesForChat` 로
 * 유저가 켠 id 목록을 접근 가능한 것(공유 or 본인 소유)만 골라 순서대로 받는다.
 */

interface ModuleRow {
	id: string;
	creator_id: string;
	creator_name: string | null;
	title: string;
	memo: string | null;
	prompt: string;
	shared: number;
	created_at: number;
	updated_at: number;
	favorited: number;
}

const COLS = `m.id, m.creator_id, m.title, m.memo, m.prompt, m.shared, m.created_at, m.updated_at,
	u.display_name AS creator_name`;

function rowToModule(r: ModuleRow): PromptModule {
	return {
		id: r.id,
		creatorId: r.creator_id,
		creatorName: r.creator_name,
		title: r.title,
		memo: r.memo,
		prompt: r.prompt,
		shared: r.shared === 1,
		favorited: r.favorited === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

/** Hub 목록(공유=shared 1 만, 최신순). userId 가 있으면 즐겨찾기 여부 포함. */
export async function listModules(
	db: D1Database,
	userId: string | null,
	limit = 200
): Promise<PromptModule[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM prompt_module_favorites f WHERE f.module_id = m.id AND f.user_id = ?) AS favorited
			 FROM prompt_modules m JOIN users u ON u.id = m.creator_id
			 WHERE m.shared = 1
			 ORDER BY m.created_at DESC LIMIT ?`
		)
		.bind(userId ?? '', limit)
		.all<ModuleRow>();
	return (results ?? []).map(rowToModule);
}

/** 내가 만든 모듈(공유/비공개 모두, 최신순). */
export async function listMyModules(db: D1Database, userId: string): Promise<PromptModule[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM prompt_module_favorites f WHERE f.module_id = m.id AND f.user_id = ?) AS favorited
			 FROM prompt_modules m JOIN users u ON u.id = m.creator_id
			 WHERE m.creator_id = ?
			 ORDER BY m.created_at DESC`
		)
		.bind(userId, userId)
		.all<ModuleRow>();
	return (results ?? []).map(rowToModule);
}

/** 유저가 즐겨찾기한 모듈 목록(최근 즐겨찾기순). */
export async function listModuleFavorites(db: D1Database, userId: string): Promise<PromptModule[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLS}, 1 AS favorited
			 FROM prompt_module_favorites f
			 JOIN prompt_modules m ON m.id = f.module_id
			 JOIN users u ON u.id = m.creator_id
			 WHERE f.user_id = ?
			 ORDER BY f.created_at DESC`
		)
		.bind(userId)
		.all<ModuleRow>();
	return (results ?? []).map(rowToModule);
}

/** 한 모듈 조회(즐겨찾기 여부 포함). */
export async function getModule(
	db: D1Database,
	id: string,
	userId: string | null
): Promise<PromptModule | null> {
	const row = await db
		.prepare(
			`SELECT ${COLS},
			        EXISTS(SELECT 1 FROM prompt_module_favorites f WHERE f.module_id = m.id AND f.user_id = ?) AS favorited
			 FROM prompt_modules m JOIN users u ON u.id = m.creator_id
			 WHERE m.id = ?`
		)
		.bind(userId ?? '', id)
		.first<ModuleRow>();
	return row ? rowToModule(row) : null;
}

/**
 * 채팅 조립용 — 유저가 켠 모듈 id 들을 **접근 가능한 것(공유 or 본인 소유)만** 골라
 * 클라가 보낸 순서 그대로 반환한다(비공개 타인 모듈·삭제된 id 는 조용히 제외).
 */
export async function getModulesForChat(
	db: D1Database,
	ids: string[],
	userId: string
): Promise<Array<Pick<PromptModule, 'id' | 'title' | 'prompt'>>> {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => '?').join(',');
	const { results } = await db
		.prepare(
			`SELECT id, title, prompt FROM prompt_modules
			 WHERE id IN (${placeholders}) AND (shared = 1 OR creator_id = ?)`
		)
		.bind(...ids, userId)
		.all<{ id: string; title: string; prompt: string }>();
	const byId = new Map((results ?? []).map((r) => [r.id, r]));
	const out: Array<Pick<PromptModule, 'id' | 'title' | 'prompt'>> = [];
	for (const id of ids) {
		const r = byId.get(id);
		if (r) out.push({ id: r.id, title: r.title, prompt: r.prompt });
	}
	return out;
}

/** 모듈 생성. 반환: id. */
export async function createModule(
	db: D1Database,
	input: { creatorId: string; title: string; memo: string | null; prompt: string; shared: boolean }
): Promise<string> {
	const id = crypto.randomUUID();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO prompt_modules (id, creator_id, title, memo, prompt, shared, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(id, input.creatorId, input.title, input.memo, input.prompt, input.shared ? 1 : 0, now, now)
		.run();
	return id;
}

/** 모듈 내용 수정(소유권은 호출부에서 확인). */
export async function updateModule(
	db: D1Database,
	id: string,
	input: { title: string; memo: string | null; prompt: string; shared: boolean }
): Promise<void> {
	await db
		.prepare(
			`UPDATE prompt_modules SET title = ?, memo = ?, prompt = ?, shared = ?, updated_at = ? WHERE id = ?`
		)
		.bind(input.title, input.memo, input.prompt, input.shared ? 1 : 0, Date.now(), id)
		.run();
}

/** 공개 여부만 변경(소유권은 호출부에서 확인). */
export async function setModuleShared(db: D1Database, id: string, shared: boolean): Promise<void> {
	await db
		.prepare('UPDATE prompt_modules SET shared = ?, updated_at = ? WHERE id = ?')
		.bind(shared ? 1 : 0, Date.now(), id)
		.run();
}

/** 소유자 id(없으면 null). */
export async function getModuleOwner(db: D1Database, id: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT creator_id FROM prompt_modules WHERE id = ?')
		.bind(id)
		.first<{ creator_id: string }>();
	return row ? row.creator_id : null;
}

/** 모듈 삭제(소유권은 호출부에서 확인). 즐겨찾기도 정리. */
export async function deleteModule(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM prompt_module_favorites WHERE module_id = ?').bind(id),
		db.prepare('DELETE FROM prompt_modules WHERE id = ?').bind(id)
	]);
}

/** 즐겨찾기 추가(멱등). */
export async function addModuleFavorite(db: D1Database, userId: string, moduleId: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO prompt_module_favorites (user_id, module_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, module_id) DO NOTHING`
		)
		.bind(userId, moduleId, Date.now())
		.run();
}

/** 즐겨찾기 해제. */
export async function removeModuleFavorite(db: D1Database, userId: string, moduleId: string): Promise<void> {
	await db
		.prepare('DELETE FROM prompt_module_favorites WHERE user_id = ? AND module_id = ?')
		.bind(userId, moduleId)
		.run();
}

/** 존재 여부(즐겨찾기 검증용). */
export async function moduleExists(db: D1Database, id: string): Promise<boolean> {
	const row = await db.prepare('SELECT 1 AS x FROM prompt_modules WHERE id = ?').bind(id).first<{ x: number }>();
	return !!row;
}
