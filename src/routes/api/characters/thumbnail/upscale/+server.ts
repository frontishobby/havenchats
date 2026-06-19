import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { upscaleImage } from '$lib/server/novelai';

/**
 * 캐릭터 썸네일 2배 업스케일(로그인 필수, 유저 본인 NovelAI 키·Anlas 사용).
 * NAIA2.0 의 NAI 2x 업스케일과 동일하게 POST /ai/upscale(scale=2)을 호출한다.
 *
 * 흐름: 클라가 생성한 썸네일(base64) + 원본 치수 → NAI 업스케일 → 업스케일 이미지 바이트 반환.
 * 클라는 이걸 webp 로 변환해 폼 썸네일로 등록한다(서버 영속화 없음).
 */

/** 입력 한도 — 폭주 방지. 썸네일은 보통 832×1216(~1MP). */
const MAX_PIXELS = 3_000_000;
const MAX_DIM = 4096;

interface Body {
	/** 원본 이미지 base64(data URL 접두 없이). */
	image?: string;
	/** 원본 폭/높이(px) — NAI 업스케일 요청에 필요. */
	width?: number;
	height?: number;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json().catch(() => null)) as Body | null;
	const image = typeof body?.image === 'string' ? body.image.trim() : '';
	const width = Number(body?.width);
	const height = Number(body?.height);
	if (!image) return json({ error: 'empty', message: '업스케일할 이미지가 없습니다.' }, { status: 400 });
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_DIM ||
		height > MAX_DIM ||
		width * height > MAX_PIXELS
	) {
		return json({ error: 'bad_size', message: '이미지 크기가 올바르지 않습니다.' }, { status: 400 });
	}

	// NovelAI 키 — 없으면 안내(클라가 등록 유도).
	const naiKey = await getDecryptedKey(db, locals.user.id, 'novelai');
	if (!naiKey) {
		return json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			{ status: 400 }
		);
	}

	const result = await upscaleImage(naiKey, {
		imageBase64: image,
		width: Math.round(width),
		height: Math.round(height),
		scale: 2
	});
	if (!result.ok) {
		return json({ error: 'upscale', message: result.message }, { status: result.status || 502 });
	}

	// 업스케일 이미지 바이트를 그대로 반환(클라가 webp 변환).
	return new Response(result.image.bytes as BlobPart, {
		headers: { 'content-type': result.image.contentType, 'cache-control': 'no-store' }
	});
};
