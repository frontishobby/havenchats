import { json, type RequestHandler } from '@sveltejs/kit';
import { getCharacterOwnership, updateImageSet } from '$lib/server/db/characters';
import { IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';
import { NAMED_LIMITS } from '$lib/imageCodes';
import type { NamedImage } from '$lib/types';

/**
 * charx import — ③ 마무리.
 * 실제로 업로드에 성공한 이미지 목록만 받아 image_set(kind:'named') 으로 확정한다.
 * (업로드 실패분은 제외 → 깨진 참조 방지.) 소유자 본인만.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

	const db = platform?.env?.DB;
	if (!db) return json({ error: 'storage unavailable' }, { status: 500 });

	const cid = params.id!;
	const own = await getCharacterOwnership(db, cid);
	if (!own) return json({ error: 'not found' }, { status: 404 });
	if (own.creatorId !== locals.user.id) return json({ error: 'forbidden' }, { status: 403 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: '요청 형식이 올바르지 않아요.' }, { status: 400 });
	}
	const rawImages = (body as { images?: unknown })?.images;
	const arr = Array.isArray(rawImages) ? rawImages : [];

	const images: NamedImage[] = [];
	const seen = new Set<string>();
	for (const item of arr) {
		const x = (item ?? {}) as { id?: unknown; name?: unknown; ext?: unknown };
		const id = String(x.id ?? '').trim();
		const name = String(x.name ?? '').trim();
		const ext = IMPORT_IMAGE_EXT[String(x.ext ?? '').toLowerCase()];
		if (!id || !name || !ext || seen.has(id)) continue;
		seen.add(id);
		images.push({ id, name, ext });
		if (images.length >= NAMED_LIMITS.MAX_IMAGES) break;
	}

	await updateImageSet(db, cid, images.length > 0 ? { kind: 'named', images } : null);

	return json({ ok: true, count: images.length });
};
