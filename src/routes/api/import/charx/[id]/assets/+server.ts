import { getImages } from '$lib/server/images';
import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { getCharacterOwnership } from '$lib/server/db/characters';
import { IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';
import { IMPORT_IMAGE_MAX_BYTES } from '$lib/server/importCharx';

/**
 * 장면 이미지 배치 업로드 — `img:<imageId>.<ext>` 폼 필드를 charimg/<cid>/<imageId>.<ext> 로 적재.
 * '기기간 공유'(promote)에서 로컬(IndexedDB) 이미지를 R2 로 올릴 때 사용한다.
 * (charx 최초 import 는 더 이상 R2 에 올리지 않고 IndexedDB 에 저장한다.)
 * 클라가 메모리/서브리퀘스트 한계를 고려해 배치(수십 장)로 나눠 여러 번 호출한다.
 * 배치 안의 put 은 병렬로 처리한다. 소유자(creator) 본인만 가능.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	requireAdmin(locals.user.email); // charx import 는 관리자 전용

	const db = getDB(platform);
	const bucket = getImages(platform);
	if (!db || !bucket) return json({ error: 'storage unavailable' }, { status: 500 });

	const cid = params.id!;
	const own = await getCharacterOwnership(db, cid);
	if (!own) return json({ error: 'not found' }, { status: 404 });
	if (own.creatorId !== locals.user.id) return json({ error: 'forbidden' }, { status: 403 });

	const form = await request.formData();
	const uploaded: string[] = [];
	const failed: string[] = [];

	// 배치 안의 put 을 병렬로(직렬 await 제거 → 업로드 체감 속도 개선).
	const tasks: Promise<void>[] = [];
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
		tasks.push(
			(async () => {
				try {
					await bucket.put(`charimg/${cid}/${id}.${ext}`, await value.arrayBuffer(), {
						httpMetadata: { contentType: value.type || `image/${ext}` }
					});
					uploaded.push(id);
				} catch {
					failed.push(id);
				}
			})()
		);
	}
	await Promise.all(tasks);

	return json({ uploaded, failed });
};
