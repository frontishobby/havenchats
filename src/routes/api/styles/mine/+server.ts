import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { listMine } from '$lib/server/db/styles';

/** 내가 만들거나 즐겨찾기한 그림체(캐릭터 추천 그림체 선택지). 로그인 필수. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ styles: [] });
	const db = getDB(platform);
	if (!db) return json({ styles: [] });
	const styles = await listMine(db, locals.user.id);
	return json({ styles });
};
