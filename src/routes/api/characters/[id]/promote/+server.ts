import { json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import {
	getCharacterById,
	getCharacterOwnership,
	updateImageSet
} from '$lib/server/db/characters';

/**
 * 로컬(IndexedDB) charx 캐릭터를 클라우드로 '기기간 공유' 전환.
 * 클라가 먼저 /api/import/charx/<id>/assets 로 로컬 이미지를 R2 에 모두 올린 뒤 호출한다.
 * 서버는 ① 소유자 확인 ② R2 에 모든 장면 이미지가 실제로 있는지 검증 ③ image_set 의 storage
 * 플래그를 떼어(클라우드) 일반 캐릭터처럼 동작하게 한다. 본인만.
 */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	requireAdmin(locals.user.email); // imported(charx) 캐릭터 전용 기능 → 관리자 전용

	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) return json({ error: 'storage unavailable' }, { status: 500 });

	const cid = params.id!;
	const own = await getCharacterOwnership(db, cid);
	if (!own) return json({ error: 'not found' }, { status: 404 });
	if (own.creatorId !== locals.user.id) return json({ error: 'forbidden' }, { status: 403 });

	const character = await getCharacterById(db, cid);
	const set = character?.imageSet;
	if (!set || set.kind !== 'named' || set.storage !== 'local') {
		return json({ error: '전환할 수 없는 캐릭터예요.' }, { status: 400 });
	}

	// R2 에 올라온 키 수집(charx 는 최대 1000장 → truncated 페이지네이션 처리).
	const present = new Set<string>();
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix: `charimg/${cid}/`, cursor });
		for (const o of listed.objects) present.add(o.key);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	// 모든 장면 이미지가 실제로 R2 에 있어야 전환(누락 시 깨진 클라우드 캐릭터 방지).
	const missing = set.images.filter((i) => !present.has(`charimg/${cid}/${i.id}.${i.ext}`));
	if (missing.length > 0) {
		return json(
			{ error: '아직 업로드되지 않은 이미지가 있어요. 다시 시도해 주세요.', missing: missing.length },
			{ status: 409 }
		);
	}

	// storage 플래그 제거 → 클라우드(일반) 캐릭터로 전환.
	await updateImageSet(db, cid, { kind: 'named', images: set.images });

	return json({ ok: true });
};
