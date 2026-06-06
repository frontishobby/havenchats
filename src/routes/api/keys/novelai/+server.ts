import { json, type RequestHandler } from '@sveltejs/kit';
import { getKeyStatus, setKey, deleteKey } from '$lib/server/db/userKeys';
import { verifySubscription } from '$lib/server/novelai';

/**
 * NovelAI API 키 관리(로그인 필수).
 *  - GET    : 등록 여부 + 등급 상태(평문 미노출).
 *  - POST    {key} : Opus 구독 검증 후 암호화 저장(검증 실패 시 거부).
 *  - DELETE  : 키 삭제.
 */

const PROVIDER = 'novelai';

interface NovelaiKeyMeta {
	tier: number;
	active: boolean;
	isOpus: boolean;
	verifiedAt: number;
}

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const status = await getKeyStatus(db, locals.user.id, PROVIDER);
	const meta = status.meta as NovelaiKeyMeta | null;
	return json({
		registered: status.registered,
		isOpus: meta?.isOpus ?? false,
		tier: meta?.tier ?? null,
		updatedAt: status.updatedAt
	});
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
	const key = typeof body?.key === 'string' ? body.key.trim() : '';
	if (!key) return json({ error: 'empty key' }, { status: 400 });

	const result = await verifySubscription(key);
	if (!result.ok) {
		if (result.reason === 'invalid_key') {
			return json({ error: 'invalid_key', message: 'NovelAI 키가 유효하지 않습니다.' }, { status: 400 });
		}
		if (result.reason === 'not_opus') {
			return json(
				{
					error: 'not_opus',
					message: 'NovelAI Opus 등급 구독이 필요합니다.',
					tier: result.info?.tier ?? null
				},
				{ status: 403 }
			);
		}
		return json(
			{ error: 'network', message: 'NovelAI 구독 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.' },
			{ status: 502 }
		);
	}

	const meta: NovelaiKeyMeta = {
		tier: result.info.tier,
		active: result.info.active,
		isOpus: result.info.isOpus,
		verifiedAt: Date.now()
	};
	await setKey(db, locals.user.id, PROVIDER, key, meta);
	return json({ registered: true, isOpus: true, tier: result.info.tier });
};

export const DELETE: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	await deleteKey(db, locals.user.id, PROVIDER);
	return json({ registered: false });
};
