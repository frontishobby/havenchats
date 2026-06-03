import { json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteCharacter,
	getCharacterOwnership,
	updateCharacter
} from '$lib/server/db/characters';
import { ALLOWED_IMAGE, parseCharacterForm } from '$lib/server/characterForm';

/** 빌트인(목) 캐릭터는 슬러그 id → uuid 가 아니면 편집 대상이 아님. */
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

	// 새 이미지가 있으면 교체, 없으면 기존 썸네일 유지.
	let newKey: string | undefined;
	if (c.image) {
		const ext = ALLOWED_IMAGE[c.image.type];
		newKey = `char/${id}.${ext}`;
		await bucket.put(newKey, await c.image.arrayBuffer(), {
			httpMetadata: { contentType: c.image.type }
		});
	}

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
			thumbnailKey: newKey
		});
	} catch (e) {
		// DB 실패 시 새로 올린 이미지는 정리.
		if (newKey) await bucket.delete(newKey).catch(() => {});
		console.error('[update] character update failed:', e);
		return json({ error: '캐릭터 저장에 실패했어요. 잠시 후 다시 시도해 주세요.' }, { status: 500 });
	}

	// 확장자가 바뀌어 키가 달라진 경우 옛 이미지 정리(같은 키면 덮어쓰여 정리 불필요).
	if (newKey && owner.thumbnailKey && owner.thumbnailKey !== newKey) {
		await bucket.delete(owner.thumbnailKey).catch(() => {});
	}

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

	return json({ ok: true });
};
