import { getDB } from '$lib/server/db/remote';
import { listRecentSessions } from '$lib/server/db/chats';
import { findCharacter } from '$lib/server/characters';
import { fetchGatewayCredits } from '$lib/server/credits';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import type { Character, RecentChat } from '$lib/types';
import type { LayoutServerLoad } from './$types';

/** 마지막 메시지를 사이드바 미리보기용 평문으로 — 지문/화자prefix/따옴표/장면토큰 제거. */
function previewText(raw: string): string {
	return raw
		.replace(/```+[^\n]*/g, ' ') // ```{제목} 등 펜스 마커 제거
		.replace(/\{#?[A-Za-z0-9_-]+\}/g, ' ') // 장면 이미지 토큰({#id}/{AAB}) 제거
		.replace(/\([^)]*\)/g, ' ') // (행동/심리 지문) 제거
		.replace(/\*[^*]*\*/g, ' ') // *지문* 제거
		.replace(/^\s*[^|\n]{1,20}\|\s*/gm, '') // "이름 | " 화자 prefix 제거
		.replace(/["'“”‘’]/g, '') // 따옴표 제거
		.replace(/\s+/g, ' ')
		.trim();
}

export const load: LayoutServerLoad = async ({ locals, platform, depends }) => {
	// 채팅 전송·세션 삭제 후 invalidate('app:recentChats') 로 사이드바만 새로고침.
	depends('app:recentChats');
	const db = getDB(platform);

	let recentChats: RecentChat[] = [];
	if (locals.user && db) {
		const sessions = await listRecentSessions(db, locals.user.id, 30);
		const charCache = new Map<string, Character | undefined>();
		for (const s of sessions) {
			if (!s.lastContent) continue; // 메시지 없는 빈 세션 제외
			if (!charCache.has(s.characterId)) {
				charCache.set(s.characterId, await findCharacter(db, s.characterId));
			}
			const char = charCache.get(s.characterId);
			if (!char) continue; // 삭제된 캐릭터 등
			recentChats.push({
				sessionId: s.sessionId,
				characterId: s.characterId,
				characterName: char.name,
				avatarUrl: char.avatarUrl,
				preview: previewText(s.lastContent),
				lastMessageAt: s.lastMessageAt
			});
		}
	}

	// 네비 중앙 뱃지 — 유저 본인 Gateway 키의 크레딧 잔량(키 없으면 null → 미표시).
	const gatewayKey = locals.user && db ? await getDecryptedKey(db, locals.user.id, 'gateway') : null;
	return { user: locals.user, recentChats, credits: await fetchGatewayCredits(gatewayKey) };
};
