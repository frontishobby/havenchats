import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { listFavorites, listMyCreated, getOldestSharedStyle } from '$lib/server/db/styles';

/**
 * 채팅 이미지 모달 그림체 선택지(로그인 필수).
 *  - saved     : 내가 만든 그림체(공유/저장 모두).
 *  - favorites : 내가 즐겨찾기한 그림체(내가 만든 건 saved 에 있으므로 제외).
 *  - fallback  : 추천/즐겨찾기/저장이 하나도 없을 때 쓸 기본값(가장 먼저 공유된 그림체).
 * 추천(캐릭터)은 페이지 로더가 별도로 내려준다.
 */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ saved: [], favorites: [], fallback: null });
	const db = getDB(platform);
	if (!db) return json({ saved: [], favorites: [], fallback: null });
	const uid = locals.user.id;
	const [saved, favs, fallback] = await Promise.all([
		listMyCreated(db, uid),
		listFavorites(db, uid),
		getOldestSharedStyle(db, uid)
	]);
	const favorites = favs.filter((s) => s.creatorId !== uid);
	return json({ saved, favorites, fallback });
};
