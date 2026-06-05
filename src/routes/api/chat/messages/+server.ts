import { json, type RequestHandler } from '@sveltejs/kit';
import { getSession, getMessagePage, deleteMessage } from '$lib/server/db/chats';

/** 한 번에 가져올 과거 메시지 수(서버 로드 PAGE_SIZE 와 동일). */
const PAGE_SIZE = 20;

/**
 * 위로 스크롤 시 과거 메시지 페이징 조회.
 * ?sessionId=<id>&before=<seq> → seq 미만에서 최신 PAGE_SIZE 개를 seq 오름차순으로.
 */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) return json({ error: 'missing sessionId' }, { status: 400 });

	// 소유권 확인.
	const session = await getSession(db, sessionId, locals.user.id);
	if (!session) return json({ error: 'session not found' }, { status: 404 });

	const before = Number(url.searchParams.get('before'));
	const page = await getMessagePage(
		db,
		sessionId,
		PAGE_SIZE,
		Number.isInteger(before) && before > 0 ? before : undefined
	);

	return json({
		messages: page.messages.map((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			cost: m.cost
		})),
		oldestSeq: page.oldestSeq,
		hasMore: page.hasMore
	});
};

interface DeleteBody {
	messageId: string;
}

/** 대화 로그에서 메시지 1건 삭제(소유자만, user/assistant 무관). 실제 DB 행을 제거. */
export const DELETE: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json()) as DeleteBody;
	if (!body.messageId) return json({ error: 'missing messageId' }, { status: 400 });

	const ok = await deleteMessage(db, body.messageId, locals.user.id);
	if (!ok) return json({ error: 'message not found' }, { status: 404 });

	return json({ ok: true });
};
