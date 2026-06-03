import { json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteCharacter,
	getCharacterById,
	getCharacterOwnership,
	updateCharacter
} from '$lib/server/db/characters';
import { ALLOWED_IMAGE, parseCharacterForm, parseImageSet } from '$lib/server/characterForm';
import { commitImageSet, deleteAllSceneImages, deleteKeys } from '$lib/server/imageStore';

/** 유저 캐릭터 id 는 uuid. 그 외 형식은 편집 대상이 아님. */
function isUserCharacterId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export const PUT: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) {
		return json({ error: 'storage unavailable' }, { status: 500 });
	}

	const id = params.id!;
	if (!isUserCharacterId(id)) {
		return json({ error: '수정할 수 없는 캐릭터예요.' }, { status: 400 });
	}

	const owner = await getCharacterOwnership(db, id);
	if (!owner) {
		return json({ error: 'not found' }, { status: 404 });
	}
	if (owner.creatorId !== locals.user.id) {
		return json({ error: 'forbidden' }, { status: 403 });
	}

	const form = await request.formData();
	const parsed = parseCharacterForm(form);
	if (!parsed.ok) {
		return json({ error: parsed.error }, { status: 400 });
	}
	const c = parsed.data;

	const imgParsed = parseImageSet(form);
	if (!imgParsed.ok) {
		return json({ error: imgParsed.error }, { status: 400 });
	}

	// 기존 장면 세트(키 diff·정리에 필요).
	const existing = await getCharacterById(db, id);
	const oldSet = existing?.imageSet ?? null;

	// 새 이미지가 있으면 교체, 없으면 기존 썸네일 유지.
	let newKey: string | undefined;
	if (c.image) {
		const ext = ALLOWED_IMAGE[c.image.type];
		newKey = `char/${id}.${ext}`;
		await bucket.put(newKey, await c.image.arrayBuffer(), {
			httpMetadata: { contentType: c.image.type }
		});
	}

	// 장면 이미지 업로드/keep. 실패 시 방금 올린 썸네일 정리.
	const committed = await commitImageSet(bucket, id, imgParsed.data, oldSet);
	if (!committed.ok) {
		if (newKey) await bucket.delete(newKey).catch(() => {});
		return json({ error: committed.error }, { status: 400 });
	}
	const { imageSet, uploadedKeys, staleKeys } = committed.result;

	try {
		await updateCharacter(db, id, {
			name: c.name,
			tagline: c.tagline,
			intro: c.intro,
			description: c.description,
			audience: c.audience,
			contentRating: c.contentRating,
			tags: c.tags,
			greetings: c.greetings,
			imageSet,
			thumbnailKey: newKey
		});
	} catch (e) {
		// DB 실패 시 새로 올린 이미지(썸네일·장면)는 정리.
		if (newKey) await bucket.delete(newKey).catch(() => {});
		await deleteKeys(bucket, uploadedKeys);
		console.error('[update] character update failed:', e);
		return json({ error: '캐릭터 저장에 실패했어요. 잠시 후 다시 시도해 주세요.' }, { status: 500 });
	}

	// 확장자가 바뀌어 키가 달라진 경우 옛 이미지 정리(같은 키면 덮어쓰여 정리 불필요).
	if (newKey && owner.thumbnailKey && owner.thumbnailKey !== newKey) {
		await bucket.delete(owner.thumbnailKey).catch(() => {});
	}
	// DB 성공 후 더 이상 참조되지 않는 옛 장면 이미지 정리.
	await deleteKeys(bucket, staleKeys);

	return json({ id });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db) {
		return json({ error: 'storage unavailable' }, { status: 500 });
	}

	const id = params.id!;
	const owner = await getCharacterOwnership(db, id);
	if (!owner) {
		return json({ error: 'not found' }, { status: 404 });
	}
	if (owner.creatorId !== locals.user.id) {
		return json({ error: 'forbidden' }, { status: 403 });
	}

	await deleteCharacter(db, id);
	if (owner.thumbnailKey) await bucket?.delete(owner.thumbnailKey).catch(() => {});
	// 장면 이미지(charimg/<id>/*) 전부 정리.
	if (bucket) await deleteAllSceneImages(bucket, id);

	return json({ ok: true });
};
