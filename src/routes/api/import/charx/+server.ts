import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { createCharacter } from '$lib/server/db/characters';
import { parseImportMeta, assignImageIds } from '$lib/server/importCharx';
import { IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';

/**
 * charx import — ① 생성 단계.
 * 클라가 zip 을 풀어 매핑한 메타 + 썸네일 + 이미지 manifest(name/ext) 를 받는다.
 * 캐릭터 행을 **비공개·image_set=null** 로 만들고, 각 이미지에 불변 id 를 할당해 돌려준다.
 * 이후 클라는 /assets 로 배치 업로드 → /finalize 로 image_set 확정.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	requireAdmin(locals.user.email); // charx import 는 관리자 전용

	const db = getDB(platform);
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) return json({ error: 'storage unavailable' }, { status: 500 });

	const form = await request.formData();

	let metaRaw: unknown;
	let manifestRaw: unknown;
	try {
		metaRaw = JSON.parse(String(form.get('meta') ?? '{}'));
		manifestRaw = JSON.parse(String(form.get('manifest') ?? '[]'));
	} catch {
		return json({ error: '요청 형식이 올바르지 않아요.' }, { status: 400 });
	}

	const meta = parseImportMeta(metaRaw);
	if (!meta.ok) return json({ error: meta.error }, { status: 400 });

	const images = assignImageIds(manifestRaw);

	// 썸네일(필수).
	const thumb = form.get('thumbnail');
	if (!(thumb instanceof File) || thumb.size === 0)
		return json({ error: '썸네일 이미지가 필요해요.' }, { status: 400 });
	const thumbExt =
		IMPORT_IMAGE_EXT[(thumb.type.split('/')[1] ?? '').toLowerCase()] ??
		IMPORT_IMAGE_EXT[(thumb.name.split('.').pop() ?? '').toLowerCase()];
	if (!thumbExt) return json({ error: '지원하지 않는 썸네일 형식이에요.' }, { status: 400 });

	const id = crypto.randomUUID();
	const thumbKey = `char/${id}.${thumbExt}`;
	await bucket.put(thumbKey, await thumb.arrayBuffer(), {
		httpMetadata: { contentType: thumb.type || `image/${thumbExt}` }
	});

	try {
		await createCharacter(db, {
			id,
			creatorId: locals.user.id,
			name: meta.data.name,
			tagline: meta.data.tagline,
			intro: meta.data.intro,
			description: meta.data.description,
			thumbnailKey: thumbKey,
			audience: meta.data.audience,
			contentRating: meta.data.contentRating,
			visibility: 'private', // charx 캐릭터는 영구 비공개(공개 불가)
			tags: meta.data.tags,
			greetings: meta.data.greetings,
			imageSet: null, // 이미지 업로드 후 /finalize 에서 확정
			lorebook: meta.data.lorebook,
			scriptData: meta.data.scriptData,
			displayScripts: meta.data.displayScripts,
			imported: true // 프롬프트 숨김·비공개·수정 불가
		});
	} catch (e) {
		await bucket.delete(thumbKey).catch(() => {});
		console.error('[import] create failed:', e);
		return json({ error: '캐릭터 생성에 실패했어요.' }, { status: 500 });
	}

	return json({ id, images });
};
