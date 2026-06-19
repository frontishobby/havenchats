import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteCharacter,
	getCharacterById,
	getCharacterDefaultVars,
	getCharacterOwnership,
	updateCharacter
} from '$lib/server/db/characters';
import { styleExists } from '$lib/server/db/styles';
import { ALLOWED_IMAGE, parseCharacterForm } from '$lib/server/characterForm';
import { commitSceneImages, deleteAllSceneImages, deleteKeys } from '$lib/server/imageStore';
import { isAdmin } from '$lib/server/auth';

/** 유저 캐릭터 id 는 uuid. 그 외 형식은 편집 대상이 아님. */
function isUserCharacterId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export const PUT: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const db = getDB(platform);
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

	// 기존 캐릭터(장면 세트 diff + charx import 여부 확인).
	const existing = await getCharacterById(db, id);
	// charx import 캐릭터는 수정 불가(프롬프트 숨김·영구 비공개). 단, 관리자는 프롬프트 편집 허용.
	if (existing?.imported && !isAdmin(locals.user.email)) {
		return json({ error: '가져온 캐릭터는 수정할 수 없어요.' }, { status: 403 });
	}

	// imported 캐릭터의 기본 변수(scriptData)는 폼에서 다루지 않으므로 관리자 편집 시 기존 값을 보존.
	const existingVars = existing?.imported ? await getCharacterDefaultVars(db, id) : null;

	const form = await request.formData();
	const parsed = parseCharacterForm(form);
	if (!parsed.ok) {
		return json({ error: parsed.error }, { status: 400 });
	}
	const c = parsed.data;

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

	// 장면 이미지(grid|named) 업로드/keep. 실패 시 방금 올린 썸네일 정리.
	const committed = await commitSceneImages(form, bucket, id, oldSet);
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
			visibility: c.visibility,
			tags: c.tags,
			greetings: c.greetings,
			imageSet,
			lorebook: c.lorebook,
			// 폼이 scriptData 를 실어 보냈으면(관리자 import 편집) 그 값을 쓰고,
			// 아니면 기존 기본 변수를 보존(폼에서 다루지 않는 일반 수정).
			scriptData: form.has('scriptData')
				? c.scriptData
				: existingVars
					? { defaultVariables: existingVars }
					: null,
			recommendedStyleId:
				c.recommendedStyleId && (await styleExists(db, c.recommendedStyleId))
					? c.recommendedStyleId
					: null,
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

	const db = getDB(platform);
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
