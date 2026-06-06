import { json, type RequestHandler } from '@sveltejs/kit';
import { getStyle, getStyleOwner, deleteStyle, setShared } from '$lib/server/db/styles';

/** 그림체 상세(GET) · 공개여부 변경(PATCH) · 삭제(DELETE). 변경·삭제는 소유자만. */

export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const owner = await getStyleOwner(db, params.id!);
	if (!owner) return json({ error: 'not found' }, { status: 404 });
	if (owner.creatorId !== locals.user.id) return json({ error: 'forbidden' }, { status: 403 });

	const body = (await request.json().catch(() => null)) as { shared?: boolean } | null;
	if (typeof body?.shared !== 'boolean') return json({ error: 'bad request' }, { status: 400 });
	await setShared(db, params.id!, body.shared);
	return json({ shared: body.shared });
};

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });
	const style = await getStyle(db, params.id!, locals.user?.id ?? null);
	if (!style) return json({ error: 'not found' }, { status: 404 });
	return json({ style });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const owner = await getStyleOwner(db, params.id!);
	if (!owner) return json({ error: 'not found' }, { status: 404 });
	if (owner.creatorId !== locals.user.id) return json({ error: 'forbidden' }, { status: 403 });

	await deleteStyle(db, params.id!);
	if (owner.thumbnailKey) {
		try {
			await platform?.env?.IMAGES?.delete(owner.thumbnailKey);
		} catch (e) {
			console.error('[styles] 썸네일 삭제 실패:', e);
		}
	}
	return json({ ok: true });
};
