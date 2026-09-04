import { Hono } from 'hono';
import { createGateway } from '@ai-sdk/gateway';
import { getKeyStatus, getDecryptedKey, setKey, deleteKey } from '$lib/server/db/userKeys';
import { verifySubscription } from '$lib/server/novelai';
import type { AppEnv } from '../../context';
import { requireUser } from '../../context';

/**
 * 외부 API 키 관리(로그인 필수).
 *  - /gateway : Vercel AI Gateway 키(챗·상황프롬프트 LLM 호출에 쓰는 유저 본인 키).
 *  - /novelai : NovelAI 키(이미지 생성, Opus 등급 구독 검증).
 * GET=등록 여부(평문 미노출), POST {key}=유효성 검증 후 암호화 저장, DELETE=삭제.
 */

export const keysRouter = new Hono<AppEnv>();

// ── Vercel AI Gateway ─────────────────────────────────────────
const GATEWAY_PROVIDER = 'gateway';

keysRouter.get('/gateway', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const status = await getKeyStatus(db, user.id, GATEWAY_PROVIDER);
	return c.json({ registered: status.registered, updatedAt: status.updatedAt });
});

keysRouter.post('/gateway', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
	const key = typeof body?.key === 'string' ? body.key.trim() : '';
	if (!key) return c.json({ error: 'empty key' }, 400);

	// getCredits 로 키 유효성 확인 — 잘못된 키면 throw → 거부.
	try {
		await createGateway({ apiKey: key }).getCredits();
	} catch {
		return c.json(
			{ error: 'invalid_key', message: 'Vercel AI Gateway 키가 유효하지 않습니다.' },
			400
		);
	}

	await setKey(db, user.id, GATEWAY_PROVIDER, key, { verifiedAt: Date.now() });
	return c.json({ registered: true });
});

keysRouter.delete('/gateway', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	await deleteKey(db, user.id, GATEWAY_PROVIDER);
	return c.json({ registered: false });
});

// ── NovelAI ───────────────────────────────────────────────────
const NOVELAI_PROVIDER = 'novelai';

interface NovelaiKeyMeta {
	tier: number;
	active: boolean;
	isOpus: boolean;
	verifiedAt: number;
}

keysRouter.get('/novelai', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const status = await getKeyStatus(db, user.id, NOVELAI_PROVIDER);
	const meta = status.meta as NovelaiKeyMeta | null;
	return c.json({
		registered: status.registered,
		isOpus: meta?.isOpus ?? false,
		tier: meta?.tier ?? null,
		updatedAt: status.updatedAt
	});
});

keysRouter.post('/novelai', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
	const key = typeof body?.key === 'string' ? body.key.trim() : '';
	if (!key) return c.json({ error: 'empty key' }, 400);

	const result = await verifySubscription(key);
	if (!result.ok) {
		if (result.reason === 'invalid_key') {
			return c.json({ error: 'invalid_key', message: 'NovelAI 키가 유효하지 않습니다.' }, 400);
		}
		if (result.reason === 'not_opus') {
			return c.json(
				{
					error: 'not_opus',
					message: 'NovelAI Opus 등급 구독이 필요합니다.',
					tier: result.info?.tier ?? null
				},
				403
			);
		}
		return c.json(
			{ error: 'network', message: 'NovelAI 구독 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.' },
			502
		);
	}

	const meta: NovelaiKeyMeta = {
		tier: result.info.tier,
		active: result.info.active,
		isOpus: result.info.isOpus,
		verifiedAt: Date.now()
	};
	await setKey(db, user.id, NOVELAI_PROVIDER, key, meta);
	return c.json({ registered: true, isOpus: true, tier: result.info.tier });
});

/**
 * 평문 토큰 수령 — 브라우저가 NovelAI(image.novelai.net)를 직접 호출하기 위해 사용한다.
 * 본인 키(BYOK)만 돌려주며 캐시 금지. 클라는 메모리에만 들고 있는다(localStorage 저장 금지).
 */
keysRouter.get('/novelai/token', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const token = await getDecryptedKey(db, user.id, NOVELAI_PROVIDER);
	if (!token) return c.json({ error: 'no_key', message: 'NovelAI 키가 없습니다.' }, 404);
	c.header('cache-control', 'no-store');
	return c.json({ token });
});

keysRouter.delete('/novelai', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	await deleteKey(db, user.id, NOVELAI_PROVIDER);
	return c.json({ registered: false });
});
