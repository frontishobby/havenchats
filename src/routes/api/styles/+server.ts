import { json, type RequestHandler } from '@sveltejs/kit';
import { listStyles, createStyle } from '$lib/server/db/styles';

/**
 * 그림체 Hub 목록(GET) · 공유=생성(POST, multipart).
 *  - GET  : 전체 목록(최신순) + (로그인 시) 즐겨찾기 여부.
 *  - POST : FormData { title, memo?, prompt(그림체), thumbnail(Blob) } → R2 저장 + 행 생성.
 */

const MAX_TITLE = 60;
const MAX_MEMO = 500;
const MAX_PROMPT = 1500;
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
	'image/webp': 'webp',
	'image/png': 'png',
	'image/jpeg': 'jpg'
};

export const GET: RequestHandler = async ({ locals, platform }) => {
	const db = platform?.env?.DB;
	if (!db) return json({ styles: [] });
	const styles = await listStyles(db, locals.user?.id ?? null);
	return json({ styles });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) return json({ error: 'storage unavailable' }, { status: 500 });

	const form = await request.formData();
	const title = String(form.get('title') ?? '').trim().slice(0, MAX_TITLE);
	const memoRaw = String(form.get('memo') ?? '').trim().slice(0, MAX_MEMO);
	const prompt = String(form.get('prompt') ?? '').trim().slice(0, MAX_PROMPT);
	// shared: '0'=저장(비공개), 그 외=공유(Hub). 기본 공유.
	const shared = String(form.get('shared') ?? '1') !== '0';
	const thumb = form.get('thumbnail');

	if (!title) return json({ error: 'title required' }, { status: 400 });
	if (!prompt) return json({ error: 'prompt required' }, { status: 400 });
	if (!(thumb instanceof Blob) || thumb.size === 0) {
		return json({ error: 'thumbnail required' }, { status: 400 });
	}
	if (thumb.size > MAX_THUMB_BYTES) {
		return json({ error: 'thumbnail too large' }, { status: 413 });
	}
	const ext = EXT_BY_TYPE[thumb.type] ?? 'webp';
	const contentType = thumb.type || 'image/webp';

	const id = crypto.randomUUID();
	const key = `style/${id}.${ext}`;
	try {
		await bucket.put(key, await thumb.arrayBuffer(), { httpMetadata: { contentType } });
	} catch (e) {
		console.error('[styles] R2 put 실패:', e);
		return json({ error: 'storage', message: '썸네일 저장 실패' }, { status: 500 });
	}

	// R2 키와 동일 id 로 행 생성(키 ↔ 행 일치).
	await createStyle(db, {
		id,
		creatorId: locals.user.id,
		title,
		memo: memoRaw || null,
		prompt,
		thumbnailKey: key,
		shared
	});

	return json({ id, shared });
};
