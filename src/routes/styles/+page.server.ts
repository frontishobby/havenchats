import { getDB } from '$lib/server/db/remote';
import { listStyles, listFavorites, listMyCreated } from '$lib/server/db/styles';
import type { PageServerLoad } from './$types';

/**
 * 그림체 Hub — 세 탭.
 *  - shared    : 공유된 전체 그림체(Hub 피드).
 *  - favorites : 내가 즐겨찾기한 그림체(로그인 시).
 *  - saved     : 내가 만든 그림체(공유/저장 모두, 로그인 시).
 */
export const load: PageServerLoad = async ({ locals, platform, depends }) => {
	depends('app:styles');
	const db = getDB(platform);
	const uid = locals.user?.id ?? null;
	if (!db) return { shared: [], favorites: [], saved: [] };

	const shared = await listStyles(db, uid);
	const favorites = uid ? await listFavorites(db, uid) : [];
	const saved = uid ? await listMyCreated(db, uid) : [];
	return { shared, favorites, saved };
};
