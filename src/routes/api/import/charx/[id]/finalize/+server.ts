import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { getCharacterOwnership, updateImageSet } from '$lib/server/db/characters';
import { IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';
import { NAMED_LIMITS } from '$lib/imageCodes';
import type { NamedImage } from '$lib/types';

/**
 * charx import — ③ 마무리.
 * 실제로 저장(로컬 IndexedDB)에 성공한 이미지 목록만 받아 image_set(kind:'named') 으로 확정한다.
 * (실패분은 제외 → 깨진 참조 방지.) storage:'local' 이면 바이트가 브라우저에만 있다는 표시.
 * 소유자 본인만.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	requireAdmin(locals.user.email); // charx import 는 관리자 전용

	const db = getDB(platform);
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
	// 바이트가 브라우저 IndexedDB 에만 있는 경우(charx import) storage:'local'.
	const storage = (body as { storage?: unknown })?.storage === 'local' ? 'local' : undefined;

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

	await updateImageSet(
		db,
		cid,
		images.length > 0 ? { kind: 'named', images, ...(storage ? { storage } : {}) } : null
	);

	return json({ ok: true, count: images.length });
};
