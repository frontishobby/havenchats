import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/db/chats';

interface DeleteBody {
	sessionId: string;
}

/** 사이드바에서 세션 삭제(소유자만). 세션 + 그 메시지를 함께 제거. */
export const DELETE: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json()) as DeleteBody;
	if (!body.sessionId) return json({ error: 'missing sessionId' }, { status: 400 });

	const ok = await deleteSession(db, body.sessionId, locals.user.id);
	if (!ok) return json({ error: 'session not found' }, { status: 404 });

	return json({ ok: true });
};
