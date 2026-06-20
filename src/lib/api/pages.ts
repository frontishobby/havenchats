import type { Character, RecentChat } from '$lib/types';

/**
 * 페이지 진입 데이터 공용 타입 — Worker(생산)와 SPA(소비) 공유.
 * (구 +layout.server.ts / +page.server.ts / user/[id] 로더의 반환 형태)
 */

export interface GatewayCredits {
	balance: number;
	totalUsed: number;
}

/** GET /api/me — 레이아웃 데이터(유저 + 사이드바 첫 페이지 + 크레딧 뱃지). */
export interface MeData {
	user: App.Locals['user'];
	recentChats: RecentChat[];
	recentChatsCursor: string | null;
	recentChatsHasMore: boolean;
	credits: GatewayCredits | null;
}

/** GET /api/home — 메인 캐릭터 그리드. */
export interface HomeData {
	characters: Character[];
	tags: string[];
	loggedIn: boolean;
	authError: string | null;
}

/** GET /api/user/:id — 공개 프로필 + 제작 캐릭터 목록. */
export interface UserPageData {
	profile: { id: string; name: string | null; avatarUrl: string | null };
	characters: Character[];
	isOwner: boolean;
	isAdmin: boolean;
}
