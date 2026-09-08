import { Hono } from 'hono';
import { getVisibleCharacters } from '$lib/backend/characters';
import { canSeeNsfw } from '$lib/nsfw';
import { loadRecentChats } from '$lib/backend/recentChats';
import { fetchGatewayCredits } from '$lib/backend/credits';
import { getDecryptedKey } from '$lib/backend/db/userKeys';
import type { RecentChat } from '$lib/types';
import type { MeData, HomeData } from '$lib/api/pages';
import type { AppEnv } from '$lib/backend/context';

export const pagesRouter = new Hono<AppEnv>();

// ── GET /api/me — 레이아웃 데이터(유저 + 사이드바 첫 페이지 + 크레딧 뱃지) ──
pagesRouter.get('/me', async (c) => {
	const user = c.get('user');
	const db = c.env.DB;

	let recentChats: RecentChat[] = [];
	let recentChatsCursor: string | null = null;
	let recentChatsHasMore = false;
	if (user && db) {
		const page = await loadRecentChats(db, user.id);
		recentChats = page.chats;
		recentChatsCursor = page.nextCursor;
		recentChatsHasMore = page.hasMore;
	}

	// 네비 중앙 뱃지 — 유저 본인 Gateway 키의 크레딧 잔량(키 없으면 null).
	const gatewayKey = user && db ? await getDecryptedKey(db, user.id, 'gateway') : null;
	const data: MeData = {
		user,
		recentChats,
		recentChatsCursor,
		recentChatsHasMore,
		credits: await fetchGatewayCredits(gatewayKey)
	};
	return c.json(data);
});

// ── GET /api/home — 메인 캐릭터 그리드 ──
pagesRouter.get('/home', async (c) => {
	const user = c.get('user');
	const visible = await getVisibleCharacters(c.env.DB, canSeeNsfw(user));
	const tags = [...new Set(visible.flatMap((ch) => ch.tags))];
	const data: HomeData = { characters: visible, tags };
	return c.json(data);
});

