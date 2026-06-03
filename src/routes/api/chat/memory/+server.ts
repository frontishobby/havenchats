import { json, type RequestHandler } from '@sveltejs/kit';
import { getSession, setMemoryText } from '$lib/server/db/chats';

interface MemoryBody {
	sessionId: string;
	memory: string;
}

/** 유저가 직접 넣은 "상시 기억" 저장. 빈 값이면 제거. (최대 길이는 서버에서 강제) */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json()) as MemoryBody;
	if (!body.sessionId) return json({ error: 'missing sessionId' }, { status: 400 });

	const session = await getSession(db, body.sessionId, locals.user.id);
	if (!session) return json({ error: 'session not found' }, { status: 404 });

	const saved = await setMemoryText(db, body.sessionId, body.memory ?? '');
	return json({ memory: saved });
};
