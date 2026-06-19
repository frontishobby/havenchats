import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { addFavorite, removeFavorite, styleExists } from '$lib/server/db/styles';

/** 그림체 즐겨찾기 추가(POST) · 해제(DELETE). 로그인 필수. */

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });
	if (!(await styleExists(db, params.id!))) return json({ error: 'not found' }, { status: 404 });
	await addFavorite(db, locals.user.id, params.id!);
	return json({ favorited: true });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });
	await removeFavorite(db, locals.user.id, params.id!);
	return json({ favorited: false });
};
