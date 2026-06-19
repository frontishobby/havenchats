import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { createGateway } from '@ai-sdk/gateway';
import { getKeyStatus, setKey, deleteKey } from '$lib/server/db/userKeys';

/**
 * Vercel AI Gateway 키 관리(로그인 필수). 챗·상황프롬프트 LLM 호출에 쓰는 유저 본인 키.
 *  - GET    : 등록 여부(평문 미노출).
 *  - POST {key} : getCredits 로 유효성 확인 후 암호화 저장(실패 시 거부).
 *  - DELETE : 키 삭제.
 */

const PROVIDER = 'gateway';

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const status = await getKeyStatus(db, locals.user.id, PROVIDER);
	return json({ registered: status.registered, updatedAt: status.updatedAt });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
	const key = typeof body?.key === 'string' ? body.key.trim() : '';
	if (!key) return json({ error: 'empty key' }, { status: 400 });

	// getCredits 로 키 유효성 확인 — 잘못된 키면 throw → 거부.
	try {
		await createGateway({ apiKey: key }).getCredits();
	} catch {
		return json(
			{ error: 'invalid_key', message: 'Vercel AI Gateway 키가 유효하지 않습니다.' },
			{ status: 400 }
		);
	}

	await setKey(db, locals.user.id, PROVIDER, key, { verifiedAt: Date.now() });
	return json({ registered: true });
};

export const DELETE: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	await deleteKey(db, locals.user.id, PROVIDER);
	return json({ registered: false });
};
