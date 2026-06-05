import { json, type RequestHandler } from '@sveltejs/kit';
import { createCharacter } from '$lib/server/db/characters';
import { ALLOWED_IMAGE, parseCharacterForm } from '$lib/server/characterForm';
import { commitSceneImages, deleteKeys } from '$lib/server/imageStore';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	// 캐릭터 만들기는 로그인 필수
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) {
		return json({ error: 'storage unavailable' }, { status: 500 });
	}

	const form = await request.formData();
	const parsed = parseCharacterForm(form);
	if (!parsed.ok) {
		return json({ error: parsed.error }, { status: 400 });
	}
	const c = parsed.data;

	// 생성 시 썸네일은 필수.
	if (!c.image) {
		return json({ error: '썸네일 이미지를 추가해 주세요.' }, { status: 400 });
	}

	// ── 저장 ──
	const id = crypto.randomUUID();
	const ext = ALLOWED_IMAGE[c.image.type];
	const key = `char/${id}.${ext}`;

	await bucket.put(key, await c.image.arrayBuffer(), {
		httpMetadata: { contentType: c.image.type }
	});

	// 장면 이미지(grid|named) 업로드. 생성이므로 기존 세트 없음. 실패 시 썸네일 정리.
	const committed = await commitSceneImages(form, bucket, id, null);
	if (!committed.ok) {
		await bucket.delete(key).catch(() => {});
		return json({ error: committed.error }, { status: 400 });
	}
	const { imageSet, uploadedKeys } = committed.result;

	try {
		await createCharacter(db, {
			id,
			creatorId: locals.user.id,
			name: c.name,
			tagline: c.tagline,
			intro: c.intro,
			description: c.description,
			thumbnailKey: key,
			audience: c.audience,
			contentRating: c.contentRating,
			visibility: c.visibility,
			tags: c.tags,
			greetings: c.greetings,
			imageSet,
			lorebook: c.lorebook
		});
	} catch (e) {
		// DB 실패 시 업로드한 이미지는 모두 정리 (고아 오브젝트 방지)
		await bucket.delete(key).catch(() => {});
		await deleteKeys(bucket, uploadedKeys);
		console.error('[create] character insert failed:', e);
		return json({ error: '캐릭터 저장에 실패했어요. 잠시 후 다시 시도해 주세요.' }, { status: 500 });
	}

	return json({ id });
};
