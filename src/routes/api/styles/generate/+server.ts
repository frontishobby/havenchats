import { json, type RequestHandler } from '@sveltejs/kit';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import {
	buildPositivePrompt,
	generateImage,
	generateImageStream,
	isResolutionKey,
	THUMBNAIL_SITUATION,
	type ResolutionKey
} from '$lib/server/novelai';

/**
 * 그림체 워크숍/썸네일 미리보기 생성(로그인 필수, 유저 본인 NovelAI 키·Anlas 사용).
 *  - body { style, situation, resolution? } → 화풍+상황+고정 퀄리티/네거티브로 NovelAI 생성.
 *  - thumbnail=true 면 상황을 고정 표준 장면(THUMBNAIL_SITUATION)·세로 해상도로 강제(일관 썸네일).
 * 응답은 생성 이미지 바이트(image/<ext>). 영속화는 하지 않는다(공유 시 클라가 업로드).
 */

const MAX_STYLE_CHARS = 1500;
const MAX_SITU_CHARS = 1000;
const THUMB_RESOLUTION: ResolutionKey = '832x1216';

interface Body {
	style?: string;
	situation?: string;
	resolution?: string;
	thumbnail?: boolean;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json().catch(() => null)) as Body | null;
	const style = (body?.style ?? '').slice(0, MAX_STYLE_CHARS);
	const isThumb = body?.thumbnail === true;
	const situation = isThumb
		? THUMBNAIL_SITUATION
		: (body?.situation ?? '').slice(0, MAX_SITU_CHARS);
	const resolution: ResolutionKey = isThumb
		? THUMB_RESOLUTION
		: isResolutionKey(body?.resolution)
			? body.resolution
			: THUMB_RESOLUTION;

	const naiKey = await getDecryptedKey(db, locals.user.id, 'novelai');
	if (!naiKey) {
		return json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			{ status: 400 }
		);
	}

	// 그림체 미리보기/썸네일은 항상 SFW(rating:nsfw 미적용).
	const positive = buildPositivePrompt(style, situation, false);

	// NDJSON 스트림: 중간 프레임(t:frame) → 최종(t:final, base64). 스트리밍 실패 시 비스트리밍 폴백.
	const enc = new TextEncoder();
	const ln = (o: unknown) => enc.encode(JSON.stringify(o) + '\n');
	const stream = new ReadableStream({
		async start(controller) {
			let finalB64: string | null = null;
			try {
				for await (const b64 of generateImageStream(naiKey, { positive, resolution })) {
					finalB64 = b64;
					controller.enqueue(ln({ t: 'frame', img: b64 }));
				}
			} catch (e) {
				console.warn('[styles/generate] 스트리밍 실패 → 폴백:', String(e));
				finalB64 = null;
			}
			if (finalB64) {
				controller.enqueue(ln({ t: 'final', img: finalB64 }));
				controller.close();
				return;
			}
			// 폴백: 비스트리밍 생성 → 최종 1장.
			const gen = await generateImage(naiKey, { positive, resolution });
			if (!gen.ok) {
				controller.enqueue(ln({ t: 'error', message: gen.message }));
				controller.close();
				return;
			}
			controller.enqueue(ln({ t: 'final', img: bytesToBase64(gen.image.bytes) }));
			controller.close();
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }
	});
};

/** Uint8Array → base64(폴백 최종 프레임 전송용). */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}
