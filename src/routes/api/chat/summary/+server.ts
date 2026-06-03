import { json, type RequestHandler } from '@sveltejs/kit';
import { getSession, setSummaryText } from '$lib/server/db/chats';

/** 현재 세션의 최신 요약 조회. (모달 열 때 fresh 값 확보) */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) return json({ error: 'missing sessionId' }, { status: 400 });

	const session = await getSession(db, sessionId, locals.user.id);
	if (!session) return json({ error: 'session not found' }, { status: 404 });

	// 모달 한 번 열 때 요약·상시 기억을 함께 내려준다(왕복 1회).
	return json({ summary: session.summary, memory: session.memory });
};

interface SummaryBody {
	sessionId: string;
	summary: string;
}

/** 유저가 직접 수정한 요약 저장. 빈 값이면 요약 제거(경계 리셋). */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json()) as SummaryBody;
	if (!body.sessionId) return json({ error: 'missing sessionId' }, { status: 400 });

	const session = await getSession(db, body.sessionId, locals.user.id);
	if (!session) return json({ error: 'session not found' }, { status: 404 });

	const saved = await setSummaryText(db, body.sessionId, body.summary ?? '');
	return json({ summary: saved });
};
