import { Hono } from 'hono';
import type { AppEnv } from '$lib/backend/context';
import { requireUser } from '$lib/backend/context';
import {
	listModules,
	listMyModules,
	listModuleFavorites,
	getModule,
	getModuleOwner,
	createModule,
	updateModule,
	setModuleShared,
	deleteModule,
	addModuleFavorite,
	removeModuleFavorite,
	moduleExists
} from '$lib/backend/db/modules';
import type { ModulesPageData, ModulesForChatData, ModuleUpsertBody } from '$lib/api/modules';

/**
 * 모듈 Hub API — 재사용 프롬프트(출력 규칙 추가 등)를 만들고 공유·즐겨찾기한다.
 * `/api/modules` 에 마운트. 정적 경로를 `:id` 보다 먼저 정의한다(Hono 라우팅 우선순위).
 * 채팅 적용은 `/api/chat` 이 `moduleIds` 로 받아 `getModulesForChat` 으로 해석한다.
 */

const MAX_TITLE = 60;
const MAX_MEMO = 500;
/** 모듈 본문 상한 — 여러 개가 매 턴 붙으므로 그림체보다 넉넉하되 폭주는 막는다. */
export const MAX_MODULE_PROMPT = 4000;

export const modulesRouter = new Hono<AppEnv>();

/** 생성/수정 JSON 본문 검증. 실패 시 에러 메시지. */
function parseUpsert(
	raw: unknown
): { ok: true; value: { title: string; memo: string | null; prompt: string; shared: boolean } } | { ok: false; error: string } {
	const b = (raw ?? {}) as Partial<ModuleUpsertBody>;
	const title = String(b.title ?? '').trim().slice(0, MAX_TITLE);
	const memo = String(b.memo ?? '').trim().slice(0, MAX_MEMO) || null;
	const prompt = String(b.prompt ?? '').trim().slice(0, MAX_MODULE_PROMPT);
	const shared = b.shared !== false;
	if (!title) return { ok: false, error: 'title required' };
	if (!prompt) return { ok: false, error: 'prompt required' };
	return { ok: true, value: { title, memo, prompt, shared } };
}

// ── GET / — Hub 목록(공유, 최신순) ─────────────────────────────────
modulesRouter.get('/', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	if (!db) return c.json({ modules: [] });
	const modules = await listModules(db, user?.id ?? null);
	return c.json({ modules });
});

// ── POST / — 생성(JSON) ───────────────────────────────────────────
modulesRouter.post('/', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const parsed = parseUpsert(await c.req.json().catch(() => null));
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);
	const id = await createModule(db, { creatorId: user.id, ...parsed.value });
	return c.json({ id, shared: parsed.value.shared });
});

// ── GET /page — 모듈 Hub 페이지(세 탭) 로더 ─────────────────────────
modulesRouter.get('/page', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	const uid = user?.id ?? null;
	if (!db) return c.json<ModulesPageData>({ shared: [], favorites: [], saved: [] });
	const [shared, favorites, saved] = await Promise.all([
		listModules(db, uid),
		uid ? listModuleFavorites(db, uid) : Promise.resolve([]),
		uid ? listMyModules(db, uid) : Promise.resolve([])
	]);
	return c.json<ModulesPageData>({ shared, favorites, saved });
});

// ── GET /forchat — 채팅 모듈 모달 후보(내 것 + 즐겨찾기, 로그인 필수) ──
modulesRouter.get('/forchat', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	if (!user || !db) return c.json<ModulesForChatData>({ saved: [], favorites: [] });
	const [saved, favs] = await Promise.all([listMyModules(db, user.id), listModuleFavorites(db, user.id)]);
	const favorites = favs.filter((m) => m.creatorId !== user.id);
	return c.json<ModulesForChatData>({ saved, favorites });
});

// ── GET /:id — 상세 ────────────────────────────────────────────────
modulesRouter.get('/:id', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const mod = await getModule(db, c.req.param('id'), user?.id ?? null);
	if (!mod) return c.json({ error: 'not found' }, 404);
	// 비공개 모듈은 소유자만 열람.
	if (!mod.shared && mod.creatorId !== user?.id) return c.json({ error: 'not found' }, 404);
	return c.json({ module: mod });
});

// ── PATCH /:id — 소유자만. 전체 필드(JSON) 또는 {shared} 만 ─────────
modulesRouter.patch('/:id', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const id = c.req.param('id');
	const owner = await getModuleOwner(db, id);
	if (!owner) return c.json({ error: 'not found' }, 404);
	if (owner !== user.id) return c.json({ error: 'forbidden' }, 403);

	const body = (await c.req.json().catch(() => null)) as Partial<ModuleUpsertBody> | null;
	// {shared} 만 온 경우 = 공개 토글.
	if (body && typeof body.shared === 'boolean' && body.title === undefined && body.prompt === undefined) {
		await setModuleShared(db, id, body.shared);
		return c.json({ shared: body.shared });
	}
	const parsed = parseUpsert(body);
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);
	await updateModule(db, id, parsed.value);
	return c.json({ id });
});

// ── DELETE /:id — 소유자만 ────────────────────────────────────────
modulesRouter.delete('/:id', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const id = c.req.param('id');
	const owner = await getModuleOwner(db, id);
	if (!owner) return c.json({ error: 'not found' }, 404);
	if (owner !== user.id) return c.json({ error: 'forbidden' }, 403);
	await deleteModule(db, id);
	return c.json({ ok: true });
});

// ── POST /:id/favorite — 즐겨찾기 추가 ────────────────────────────
modulesRouter.post('/:id/favorite', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const id = c.req.param('id');
	if (!(await moduleExists(db, id))) return c.json({ error: 'not found' }, 404);
	await addModuleFavorite(db, user.id, id);
	return c.json({ favorited: true });
});

// ── DELETE /:id/favorite — 즐겨찾기 해제 ─────────────────────────
modulesRouter.delete('/:id/favorite', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	await removeModuleFavorite(db, user.id, c.req.param('id'));
	return c.json({ favorited: false });
});
