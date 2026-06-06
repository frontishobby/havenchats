import { json, type RequestHandler } from '@sveltejs/kit';
import { listFavorites } from '$lib/server/db/styles';

/** 내가 즐겨찾기한 그림체 목록(채팅 이미지 모달 선택지). 로그인 필수. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ styles: [] });
	const db = platform?.env?.DB;
	if (!db) return json({ styles: [] });
	const styles = await listFavorites(db, locals.user.id);
	return json({ styles });
};
