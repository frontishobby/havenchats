import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { loadRecentChats, parseRecentCursor, RECENT_PAGE_SIZE } from '$lib/server/recentChats';

/** 사이드바 무한스크롤 — 최근 채팅 다음 페이지(커서 기반). 로그인 필수. */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ chats: [], nextCursor: null, hasMore: false });

	const cursor = parseRecentCursor(url.searchParams.get('cursor'));
	const page = await loadRecentChats(db, locals.user.id, RECENT_PAGE_SIZE, cursor);
	return json(page);
};
