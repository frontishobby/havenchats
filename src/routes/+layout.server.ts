import { getDB } from '$lib/server/db/remote';
import { loadRecentChats } from '$lib/server/recentChats';
import { fetchGatewayCredits } from '$lib/server/credits';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import type { RecentChat } from '$lib/types';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, platform, depends }) => {
	// 채팅 전송·세션 삭제 후 invalidate('app:recentChats') 로 사이드바만 새로고침.
	depends('app:recentChats');
	const db = getDB(platform);

	let recentChats: RecentChat[] = [];
	let recentChatsCursor: string | null = null;
	let recentChatsHasMore = false;
	if (locals.user && db) {
		const page = await loadRecentChats(db, locals.user.id);
		recentChats = page.chats;
		recentChatsCursor = page.nextCursor;
		recentChatsHasMore = page.hasMore;
	}

	// 네비 중앙 뱃지 — 유저 본인 Gateway 키의 크레딧 잔량(키 없으면 null → 미표시).
	const gatewayKey = locals.user && db ? await getDecryptedKey(db, locals.user.id, 'gateway') : null;
	return {
		user: locals.user,
		recentChats,
		recentChatsCursor,
		recentChatsHasMore,
		credits: await fetchGatewayCredits(gatewayKey)
	};
};
