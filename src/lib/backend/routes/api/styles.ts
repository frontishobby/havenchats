import { Hono } from 'hono';
import type { AppEnv } from '$lib/backend/context';
import { requireUser } from '$lib/backend/context';
import {
	listStyles,
	createStyle,
	getStyle,
	getStyleOwner,
	deleteStyle,
	setShared,
	updateStyle,
	addFavorite,
	removeFavorite,
	styleExists,
	listFavorites,
	listMine,
	listMyCreated,
	getOldestSharedStyle
} from '$lib/backend/db/styles';
import { getDecryptedKey } from '$lib/backend/db/userKeys';
import {
	buildPositivePrompt,
	generateImage,
	generateImageStream,
	isResolutionKey,
	THUMBNAIL_SITUATION,
	type ResolutionKey
} from '$lib/backend/novelai';
import { pickNaiModel } from '$lib/naiModels';
import type {
	StylesPageData,
	StylesForChatData,
	StyleGenerateRequest,
	StyleGenerateFrame
} from '$lib/api/styles';

/**
 * 그림체(아트 스타일) Hub API — SvelteKit `+server.ts` 들을 하나의 Hono 라우터로 이식.
 * `/api/styles` 에 마운트되므로 경로는 상대(예: GET '/' = GET /api/styles).
 * 정적 경로를 파라미터 경로(:id)보다 먼저 정의한다(Hono 라우팅 우선순위).
 */

const MAX_TITLE = 60;
const MAX_MEMO = 500;
const MAX_PROMPT = 3000;
/** 선택 네거티브/퀄리티 프롬프트 상한(그림체 프롬프트와 동일). */
const MAX_EXTRA_PROMPT = 3000;
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
	'image/webp': 'webp',
	'image/png': 'png',
	'image/jpeg': 'jpg'
};

const MAX_STYLE_CHARS = 3000;
const MAX_SITU_CHARS = 1000;
const THUMB_RESOLUTION: ResolutionKey = '832x1216';

export const stylesRouter = new Hono<AppEnv>();

// ── GET / — Hub 목록(공유, 최신순) + (로그인 시) 즐겨찾기 여부 ──────
stylesRouter.get('/', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	if (!db) return c.json({ styles: [] });
	const styles = await listStyles(db, user?.id ?? null);
	return c.json({ styles });
});

// ── POST / — 공유=생성(multipart) ─────────────────────────────────
stylesRouter.post('/', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const bucket = c.env.IMAGES;
	if (!db || !bucket) return c.json({ error: 'storage unavailable' }, 500);

	const form = await c.req.formData();
	const title = String(form.get('title') ?? '').trim().slice(0, MAX_TITLE);
	const memoRaw = String(form.get('memo') ?? '').trim().slice(0, MAX_MEMO);
	const prompt = String(form.get('prompt') ?? '').trim().slice(0, MAX_PROMPT);
	// shared: '0'=저장(비공개), 그 외=공유(Hub). 기본 공유.
	const shared = String(form.get('shared') ?? '1') !== '0';
	// 그림체가 깎인 NovelAI 모델(허용목록 검증, 미허용이면 기본 V5).
	const model = pickNaiModel(form.get('model'));
	// 선택 네거티브/퀄리티(빈값 → null = 모델별 고정값 사용).
	const negative = String(form.get('negative') ?? '').trim().slice(0, MAX_EXTRA_PROMPT) || null;
	const quality = String(form.get('quality') ?? '').trim().slice(0, MAX_EXTRA_PROMPT) || null;
	const thumb = form.get('thumbnail');

	if (!title) return c.json({ error: 'title required' }, 400);
	if (!prompt) return c.json({ error: 'prompt required' }, 400);
	if (!(thumb instanceof Blob) || thumb.size === 0) {
		return c.json({ error: 'thumbnail required' }, 400);
	}
	if (thumb.size > MAX_THUMB_BYTES) {
		return c.json({ error: 'thumbnail too large' }, 413);
	}
	const ext = EXT_BY_TYPE[thumb.type] ?? 'webp';
	const contentType = thumb.type || 'image/webp';

	const id = crypto.randomUUID();
	const key = `style/${id}.${ext}`;
	try {
		await bucket.put(key, await thumb.arrayBuffer(), { httpMetadata: { contentType } });
	} catch (e) {
		console.error('[styles] R2 put 실패:', e);
		return c.json({ error: 'storage', message: '썸네일 저장 실패' }, 500);
	}

	// R2 키와 동일 id 로 행 생성(키 ↔ 행 일치).
	await createStyle(db, {
		id,
		creatorId: user.id,
		title,
		memo: memoRaw || null,
		prompt,
		model,
		negative,
		quality,
		thumbnailKey: key,
		shared
	});

	return c.json({ id, shared });
});

// ── GET /favorites — 내가 즐겨찾기한 그림체 목록(로그인 필수) ────────
stylesRouter.get('/favorites', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ styles: [] });
	const db = c.env.DB;
	if (!db) return c.json({ styles: [] });
	const styles = await listFavorites(db, user.id);
	return c.json({ styles });
});

// ── GET /mine — 내가 만들거나 즐겨찾기한 그림체(로그인 필수) ─────────
stylesRouter.get('/mine', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ styles: [] });
	const db = c.env.DB;
	if (!db) return c.json({ styles: [] });
	const styles = await listMine(db, user.id);
	return c.json({ styles });
});

// ── GET /forchat — 채팅 이미지 모달 그림체 선택지(로그인 필수) ───────
stylesRouter.get('/forchat', async (c) => {
	const user = c.get('user');
	if (!user) return c.json<StylesForChatData>({ saved: [], favorites: [], fallback: null });
	const db = c.env.DB;
	if (!db) return c.json<StylesForChatData>({ saved: [], favorites: [], fallback: null });
	const uid = user.id;
	const [saved, favs, fallback] = await Promise.all([
		listMyCreated(db, uid),
		listFavorites(db, uid),
		getOldestSharedStyle(db, uid)
	]);
	const favorites = favs.filter((s) => s.creatorId !== uid);
	return c.json<StylesForChatData>({ saved, favorites, fallback });
});

// ── POST /generate — 워크숍/썸네일 미리보기 생성(NDJSON 스트림) ──────
stylesRouter.post('/generate', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json().catch(() => null)) as StyleGenerateRequest | null;
	const style = (body?.style ?? '').slice(0, MAX_STYLE_CHARS);
	const isThumb = body?.thumbnail === true;
	const situation = isThumb
		? THUMBNAIL_SITUATION
		: (body?.situation ?? '').slice(0, MAX_SITU_CHARS);
	const resolution: ResolutionKey = isThumb
		? THUMB_RESOLUTION
		: isResolutionKey(body?.resolution)
			? body.resolution
			: THUMB_RESOLUTION;
	const model = pickNaiModel(body?.model);
	const negative = (body?.negative ?? '').slice(0, MAX_EXTRA_PROMPT);
	const quality = (body?.quality ?? '').slice(0, MAX_EXTRA_PROMPT);

	const naiKey = await getDecryptedKey(db, user.id, 'novelai');
	if (!naiKey) {
		return c.json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			400
		);
	}

	// 그림체 미리보기/썸네일은 항상 SFW(rating:nsfw 미적용). 사용자 퀄리티/네거티브가 있으면 고정값 대체.
	const positive = buildPositivePrompt(style, situation, false, model, '', quality);

	// NDJSON 스트림: 중간 프레임(t:frame) → 최종(t:final, base64). 스트리밍 실패 시 비스트리밍 폴백.
	const enc = new TextEncoder();
	const ln = (o: StyleGenerateFrame) => enc.encode(JSON.stringify(o) + '\n');
	const stream = new ReadableStream({
		async start(controller) {
			let finalB64: string | null = null;
			try {
				for await (const b64 of generateImageStream(naiKey, { positive, resolution, model, negative })) {
					finalB64 = b64;
					controller.enqueue(ln({ t: 'frame', img: b64 }));
				}
			} catch (e) {
				console.warn('[styles/generate] 스트리밍 실패 → 폴백:', String(e));
				finalB64 = null;
			}
			if (finalB64) {
				controller.enqueue(ln({ t: 'final', img: finalB64 }));
				controller.close();
				return;
			}
			// 폴백: 비스트리밍 생성 → 최종 1장.
			const gen = await generateImage(naiKey, { positive, resolution, model, negative });
			if (!gen.ok) {
				controller.enqueue(ln({ t: 'error', message: gen.message }));
				controller.close();
				return;
			}
			controller.enqueue(ln({ t: 'final', img: bytesToBase64(gen.image.bytes) }));
			controller.close();
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }
	});
});

// ── GET /page — 그림체 Hub 페이지(세 탭) 로더 (구 +page.server.ts) ──
stylesRouter.get('/page', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	const uid = user?.id ?? null;
	if (!db) return c.json<StylesPageData>({ shared: [], favorites: [], saved: [] });

	const shared = await listStyles(db, uid);
	const favorites = uid ? await listFavorites(db, uid) : [];
	const saved = uid ? await listMyCreated(db, uid) : [];
	return c.json<StylesPageData>({ shared, favorites, saved });
});

// ── GET /:id — 그림체 상세 ────────────────────────────────────────
stylesRouter.get('/:id', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const style = await getStyle(db, c.req.param('id'), user?.id ?? null);
	if (!style) return c.json({ error: 'not found' }, 404);
	return c.json({ style });
});

// ── PATCH /:id — 소유자만. multipart=내용 수정(제목·메모·프롬프트·모델·네거티브·퀄리티·썸네일 선택),
//    JSON={shared}=공개 여부 변경 ──────────────────────────────────
stylesRouter.patch('/:id', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const id = c.req.param('id');
	const owner = await getStyleOwner(db, id);
	if (!owner) return c.json({ error: 'not found' }, 404);
	if (owner.creatorId !== user.id) return c.json({ error: 'forbidden' }, 403);

	if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
		const form = await c.req.formData();
		const title = String(form.get('title') ?? '').trim().slice(0, MAX_TITLE);
		const memo = String(form.get('memo') ?? '').trim().slice(0, MAX_MEMO) || null;
		const prompt = String(form.get('prompt') ?? '').trim().slice(0, MAX_PROMPT);
		const model = pickNaiModel(form.get('model'));
		const negative = String(form.get('negative') ?? '').trim().slice(0, MAX_EXTRA_PROMPT) || null;
		const quality = String(form.get('quality') ?? '').trim().slice(0, MAX_EXTRA_PROMPT) || null;
		if (!title) return c.json({ error: 'title required' }, 400);
		if (!prompt) return c.json({ error: 'prompt required' }, 400);

		// 썸네일은 선택(없으면 기존 유지). 있으면 같은 id 키로 덮어쓰고, 확장자가 바뀌면 옛 키 삭제.
		let thumbnailKey: string | undefined;
		const thumb = form.get('thumbnail');
		if (thumb instanceof Blob && thumb.size > 0) {
			const bucket = c.env.IMAGES;
			if (!bucket) return c.json({ error: 'storage unavailable' }, 500);
			if (thumb.size > MAX_THUMB_BYTES) return c.json({ error: 'thumbnail too large' }, 413);
			const ext = EXT_BY_TYPE[thumb.type] ?? 'webp';
			thumbnailKey = `style/${id}.${ext}`;
			try {
				await bucket.put(thumbnailKey, await thumb.arrayBuffer(), {
					httpMetadata: { contentType: thumb.type || 'image/webp' }
				});
				if (owner.thumbnailKey && owner.thumbnailKey !== thumbnailKey) {
					await bucket.delete(owner.thumbnailKey).catch(() => {});
				}
			} catch (e) {
				console.error('[styles] R2 put 실패(수정):', e);
				return c.json({ error: 'storage', message: '썸네일 저장 실패' }, 500);
			}
		}
		await updateStyle(db, id, { title, memo, prompt, model, negative, quality, thumbnailKey });
		return c.json({ id });
	}

	const body = (await c.req.json().catch(() => null)) as { shared?: boolean } | null;
	if (typeof body?.shared !== 'boolean') return c.json({ error: 'bad request' }, 400);
	await setShared(db, id, body.shared);
	return c.json({ shared: body.shared });
});

// ── DELETE /:id — 그림체 삭제(소유자만) ────────────────────────────
stylesRouter.delete('/:id', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const id = c.req.param('id');
	const owner = await getStyleOwner(db, id);
	if (!owner) return c.json({ error: 'not found' }, 404);
	if (owner.creatorId !== user.id) return c.json({ error: 'forbidden' }, 403);

	await deleteStyle(db, id);
	if (owner.thumbnailKey) {
		try {
			await c.env.IMAGES?.delete(owner.thumbnailKey);
		} catch (e) {
			console.error('[styles] 썸네일 삭제 실패:', e);
		}
	}
	return c.json({ ok: true });
});

// ── POST /:id/favorite — 즐겨찾기 추가(로그인 필수) ─────────────────
stylesRouter.post('/:id/favorite', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const id = c.req.param('id');
	if (!(await styleExists(db, id))) return c.json({ error: 'not found' }, 404);
	await addFavorite(db, user.id, id);
	return c.json({ favorited: true });
});

// ── DELETE /:id/favorite — 즐겨찾기 해제(로그인 필수) ───────────────
stylesRouter.delete('/:id/favorite', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const id = c.req.param('id');
	await removeFavorite(db, user.id, id);
	return c.json({ favorited: false });
});

/** Uint8Array → base64(폴백 최종 프레임 전송용). */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}
