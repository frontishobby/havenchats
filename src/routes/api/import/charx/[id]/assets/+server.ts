import { json, type RequestHandler } from '@sveltejs/kit';
import { getCharacterOwnership } from '$lib/server/db/characters';
import { IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';
import { IMPORT_IMAGE_MAX_BYTES } from '$lib/server/importCharx';

/**
 * charx import — ② 에셋 배치 업로드.
 * 폼 필드명 `img:<imageId>.<ext>` 로 들어온 파일들을 charimg/<cid>/<imageId>.<ext> 로 적재.
 * 클라가 메모리/서브리퀘스트 한계를 고려해 배치(수십 장)로 나눠 여러 번 호출한다.
 * 소유자(creator) 본인만 가능.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) return json({ error: 'storage unavailable' }, { status: 500 });

	const cid = params.id!;
	const own = await getCharacterOwnership(db, cid);
	if (!own) return json({ error: 'not found' }, { status: 404 });
	if (own.creatorId !== locals.user.id) return json({ error: 'forbidden' }, { status: 403 });

	const form = await request.formData();
	const uploaded: string[] = [];
	const failed: string[] = [];

	for (const [field, value] of form.entries()) {
		if (!field.startsWith('img:') || !(value instanceof File)) continue;
		// field = "img:<id>.<ext>"
		const spec = field.slice(4);
		const dot = spec.lastIndexOf('.');
		const id = dot >= 0 ? spec.slice(0, dot) : spec;
		const ext = IMPORT_IMAGE_EXT[(dot >= 0 ? spec.slice(dot + 1) : '').toLowerCase()];
		if (!id || !ext) {
			failed.push(id || spec);
			continue;
		}
		if (value.size === 0 || value.size > IMPORT_IMAGE_MAX_BYTES) {
			failed.push(id);
			continue;
		}
		try {
			await bucket.put(`charimg/${cid}/${id}.${ext}`, await value.arrayBuffer(), {
				httpMetadata: { contentType: value.type || `image/${ext}` }
			});
			uploaded.push(id);
		} catch {
			failed.push(id);
		}
	}

	return json({ uploaded, failed });
};
