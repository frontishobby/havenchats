import { Hono } from 'hono';
import { getVisibleCharacters } from '$lib/server/characters';
import { canSeeNsfw } from '$lib/nsfw';
import { loadRecentChats } from '$lib/server/recentChats';
import { fetchGatewayCredits } from '$lib/server/credits';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { getPublicProfile } from '$lib/server/db/users';
import { listCharactersByCreator } from '$lib/server/db/characters';
import { isAdmin } from '$lib/server/auth';
import { HttpError } from '$lib/server/httpError';
import type { RecentChat } from '$lib/types';
import type { MeData, HomeData, UserPageData } from '$lib/api/pages';
import type { AppEnv } from '../../context';

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

// ── GET /api/home — 메인 캐릭터 그리드(비로그인=NSFW 숨김) ──
pagesRouter.get('/home', async (c) => {
	const user = c.get('user');
	const visible = await getVisibleCharacters(c.env.DB, canSeeNsfw(user));
	const tags = [...new Set(visible.flatMap((ch) => ch.tags))];
	const data: HomeData = {
		characters: visible,
		tags,
		loggedIn: !!user,
		authError: c.req.query('auth') ?? null
	};
	return c.json(data);
});

// ── GET /api/user/:id — 공개 프로필 + 제작 캐릭터 목록 ──
pagesRouter.get('/user/:id', async (c) => {
	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');
	const id = c.req.param('id');
	const user = c.get('user');

	const profile = await getPublicProfile(db, id);
	// display_name 미설정(프로필 미완성) 유저는 공개 페이지가 없는 것으로 취급.
	if (!profile || !profile.name) throw new HttpError(404, '사용자를 찾을 수 없어요.');

	const isOwner = user?.id === id;
	const all = await listCharactersByCreator(db, id, isOwner);
	// NSFW 캐릭터는 본인 또는 파라과이(PY) 방문자에게만 노출(그 외엔 SFW 만).
	const characters =
		isOwner || canSeeNsfw(user) ? all : all.filter((ch) => ch.contentRating === 'sfw');

	const data: UserPageData = { profile, characters, isOwner, isAdmin: isAdmin(user?.email) };
	return c.json(data);
});
