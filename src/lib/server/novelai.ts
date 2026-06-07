/**
 * NovelAI 이미지 생성 연동(서버 전용).
 *
 *  - 구독 검증: GET https://api.novelai.net/user/subscription (Bearer) → Opus(tier 3) 확인.
 *  - 이미지 생성: POST https://image.novelai.net/ai/generate-image (Bearer) → ZIP(보통 PNG 1장).
 *    응답 ZIP 에서 이미지 바이트를 꺼내 매직바이트로 실제 포맷(webp/png/jpeg)을 판별한다.
 *    (NovelAI 는 per-request webp 파라미터가 없고, 계정 'Image Format' 설정을 따른다 →
 *     계정이 webp 면 webp, 아니면 png 로 저장. 사용자 지시: webp 옵션 없으면 PNG 로 저장.)
 *
 * Workers 런타임 = Web 표준만. ZIP 해제는 DecompressionStream('deflate-raw') 로 처리.
 */

const SUBSCRIPTION_URL = 'https://api.novelai.net/user/subscription';
const GENERATE_URL = 'https://image.novelai.net/ai/generate-image';
const UPSCALE_URL = 'https://api.novelai.net/ai/upscale';

/** NovelAI 구독 등급. 3 = Opus. */
export const OPUS_TIER = 3;

export interface SubscriptionInfo {
	active: boolean;
	tier: number;
	/** Opus 등급이면서 활성 구독인지. */
	isOpus: boolean;
}

export type VerifyResult =
	| { ok: true; info: SubscriptionInfo }
	| { ok: false; reason: 'invalid_key' | 'not_opus' | 'network'; info?: SubscriptionInfo };

/** 키로 구독 정보를 조회해 Opus 등급 여부를 판별. */
export async function verifySubscription(token: string): Promise<VerifyResult> {
	let res: Response;
	try {
		res = await fetch(SUBSCRIPTION_URL, {
			headers: { authorization: `Bearer ${token}` }
		});
	} catch {
		return { ok: false, reason: 'network' };
	}
	if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_key' };
	if (!res.ok) return { ok: false, reason: 'network' };

	let body: { active?: boolean; tier?: number };
	try {
		body = (await res.json()) as { active?: boolean; tier?: number };
	} catch {
		return { ok: false, reason: 'network' };
	}
	const tier = typeof body.tier === 'number' ? body.tier : -1;
	const active = body.active === true;
	const info: SubscriptionInfo = { active, tier, isOpus: active && tier >= OPUS_TIER };
	if (!info.isOpus) return { ok: false, reason: 'not_opus', info };
	return { ok: true, info };
}

// ─────────────────────────────────────────────────────────────
// 고정 프롬프트/파라미터 (docs/realtime-image.md)
// ─────────────────────────────────────────────────────────────

/** 상황 프롬프트 뒤에 항상 붙는 퀄리티 꼬리(앞 콤마 포함). */
export const QUALITY_TAIL =
	', -4::artist collaboration, year 2025, year 2024, -3::spoken bubble, text, cross-section::, rating:explicit, {{{-3::censored, photo inset, stomach deformation}}}, {{{-3::small lines::}}}, 1.5::balanced contrast::, -2::simple illustration::, -1::censored::, best quality, amazing quality, very aesthetic, intricate detail, highres, incredibly absurdres';

/** 고정 네거티브 프롬프트. */
export const NEGATIVE_PROMPT =
	'text, logo, signature, watermark, too many watermarks, chili inset, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, very displeasing, undetailed eyes, multiple views, negative space, blank page, variant set, large variant set, 4koma, 2koma, oekaki, halftone, screentone, artistic error, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors, lowres, worst quality, bad quality, cheesy, sloppiness, unfinished, Incomplete, ai-generated';

export const MODEL = 'nai-diffusion-4-5-full';

/**
 * 그림체 Hub 썸네일용 고정 표준 장면(SFW). 모든 그림체를 같은 장면으로 렌더해 카드 비교가 일관되게.
 * 채팅의 자동 상황 프롬프트 대신 이 값을 상황으로 써서 그림체만 비교되도록 한다.
 */
export const THUMBNAIL_SITUATION =
	'1girl, white_background, black_hair, red_eyes, white_shirt, black_skirt, standing, upper_body, slight_smile, braided_bangs, straight_hair';

/** 고정 생성 파라미터(docs/realtime-image.md). 디버그 표시·요청 바디 공용. */
export const IMAGE_PARAMS = {
	sampler: 'k_euler_ancestral',
	scheduler: 'karras',
	steps: 28,
	cfgScale: 5.8,
	cfgRescale: 0.28
} as const;

/** 허용 해상도(가로×세로). 임의 값 주입 방지. */
export const RESOLUTIONS = {
	'832x1216': { width: 832, height: 1216 },
	'1024x1024': { width: 1024, height: 1024 }
} as const;
export type ResolutionKey = keyof typeof RESOLUTIONS;
export const DEFAULT_RESOLUTION: ResolutionKey = '832x1216';

export function isResolutionKey(v: unknown): v is ResolutionKey {
	return typeof v === 'string' && v in RESOLUTIONS;
}

/**
 * 최종 positive 프롬프트 조립: (NSFW면) rating:nsfw + 그림체 + 상황 + 퀄리티 꼬리.
 * 그림체/상황의 끝 콤마를 정리한 뒤 ', ' 로 잇고, 퀄리티 꼬리(앞 콤마 포함)를 붙인다.
 * 그림체가 비면 스타일 태그 없이 상황+퀄리티만(하드코딩 기본값 없음). nsfw=true 면 맨 앞에 rating:nsfw.
 */
export function buildPositivePrompt(
	stylePrompt: string,
	situation: string,
	nsfw = false
): string {
	const style = stylePrompt.trim().replace(/,\s*$/, '').trim();
	const sit = situation.trim().replace(/,\s*$/, '').trim();
	const head = [style, sit].filter(Boolean).join(', ');
	const body = head + QUALITY_TAIL;
	return nsfw ? `rating:nsfw, uncensored, ${body}` : body;
}

export interface GeneratedImage {
	bytes: Uint8Array;
	ext: 'webp' | 'png' | 'jpg';
	contentType: string;
}

export type GenerateResult =
	| { ok: true; image: GeneratedImage }
	| { ok: false; status: number; message: string };

/** NovelAI 이미지 생성 요청 → ZIP 해제 → 이미지 바이트. */
/** generate / generate-stream 공용 요청 바디. */
function buildPayload(positive: string, resolution: ResolutionKey) {
	const { width, height } = RESOLUTIONS[resolution];
	// 0 ~ 2^32-1 시드(Workers: crypto.getRandomValues).
	const seed = crypto.getRandomValues(new Uint32Array(1))[0];
	return {
		input: positive,
		model: MODEL,
		action: 'generate',
		parameters: {
			params_version: 3,
			width,
			height,
			scale: IMAGE_PARAMS.cfgScale,
			sampler: IMAGE_PARAMS.sampler,
			steps: IMAGE_PARAMS.steps,
			n_samples: 1,
			ucPreset: 0,
			qualityToggle: false, // 퀄리티 태그를 프롬프트에 직접 포함하므로 자동 토글 끔
			autoSmea: false,
			dynamic_thresholding: false,
			controlnet_strength: 1,
			legacy: false,
			add_original_image: true,
			cfg_rescale: IMAGE_PARAMS.cfgRescale,
			noise_schedule: IMAGE_PARAMS.scheduler,
			legacy_v3_extend: false,
			skip_cfg_above_sigma: null,
			seed,
			negative_prompt: NEGATIVE_PROMPT,
			v4_prompt: {
				caption: { base_caption: positive, char_captions: [] },
				use_coords: false,
				use_order: true
			},
			v4_negative_prompt: {
				caption: { base_caption: NEGATIVE_PROMPT, char_captions: [] },
				legacy_uc: false
			}
		}
	};
}

export async function generateImage(
	token: string,
	opts: { positive: string; resolution: ResolutionKey }
): Promise<GenerateResult> {
	const payload = buildPayload(opts.positive, opts.resolution);

	let res: Response;
	try {
		res = await fetch(GENERATE_URL, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
	} catch (e) {
		return { ok: false, status: 502, message: `NovelAI 요청 실패: ${String(e)}` };
	}

	if (!res.ok) {
		let detail = '';
		try {
			detail = (await res.text()).slice(0, 300);
		} catch {
			/* ignore */
		}
		const message =
			res.status === 401 || res.status === 403
				? 'NovelAI 키가 유효하지 않습니다.'
				: res.status === 402
					? 'NovelAI Anlas(크레딧)가 부족합니다.'
					: `NovelAI 생성 실패 (${res.status}). ${detail}`;
		return { ok: false, status: res.status, message };
	}

	const zip = new Uint8Array(await res.arrayBuffer());
	let imgBytes: Uint8Array;
	try {
		imgBytes = await extractFirstFileFromZip(zip);
	} catch (e) {
		return { ok: false, status: 502, message: `NovelAI 응답(zip) 해석 실패: ${String(e)}` };
	}

	const { ext, contentType } = sniffImage(imgBytes);
	return { ok: true, image: { bytes: imgBytes, ext, contentType } };
}

/**
 * NovelAI 업스케일(2배). NAIA2.0 의 upscale_NAI 와 동일 동작:
 *   POST /ai/upscale  body { image: base64, width, height, scale } → 응답 ZIP(이미지 1장).
 * 이미 인코딩된 base64(클라가 보낸 원본)를 그대로 전달해 재인코딩을 피한다.
 */
export async function upscaleImage(
	token: string,
	opts: { imageBase64: string; width: number; height: number; scale?: number }
): Promise<GenerateResult> {
	const scale = opts.scale ?? 2;
	let res: Response;
	try {
		res = await fetch(UPSCALE_URL, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				image: opts.imageBase64,
				width: opts.width,
				height: opts.height,
				scale
			})
		});
	} catch (e) {
		return { ok: false, status: 502, message: `NovelAI 업스케일 요청 실패: ${String(e)}` };
	}

	if (!res.ok) {
		let detail = '';
		try {
			detail = (await res.text()).slice(0, 300);
		} catch {
			/* ignore */
		}
		const message =
			res.status === 401 || res.status === 403
				? 'NovelAI 키가 유효하지 않습니다.'
				: res.status === 402
					? 'NovelAI Anlas(크레딧)가 부족합니다.'
					: `NovelAI 업스케일 실패 (${res.status}). ${detail}`;
		return { ok: false, status: res.status, message };
	}

	const zip = new Uint8Array(await res.arrayBuffer());
	let imgBytes: Uint8Array;
	try {
		imgBytes = await extractFirstFileFromZip(zip);
	} catch (e) {
		return { ok: false, status: 502, message: `NovelAI 업스케일 응답(zip) 해석 실패: ${String(e)}` };
	}

	const { ext, contentType } = sniffImage(imgBytes);
	return { ok: true, image: { bytes: imgBytes, ext, contentType } };
}

const STREAM_URL = 'https://image.novelai.net/ai/generate-image-stream';

/** base64(또는 data URL) → 이미지 바이트 + 포맷 판별. */
export function b64ToImage(b64: string): GeneratedImage {
	const bytes = base64ToBytes(b64);
	const { ext, contentType } = sniffImage(bytes);
	return { bytes, ext, contentType };
}

function base64ToBytes(b64: string): Uint8Array {
	const clean = (b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64).replace(/\s/g, '');
	const bin = atob(clean);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * NovelAI 스트리밍 생성(SSE). 각 이벤트의 base64 이미지(중간 프리뷰 → 최종)를 순서대로 yield.
 * **마지막 yield 가 최종 이미지**. 엔드포인트/포맷 미지원·무프레임이면 throw → 호출부가 비스트리밍 폴백.
 */
export async function* generateImageStream(
	token: string,
	opts: { positive: string; resolution: ResolutionKey }
): AsyncGenerator<string, void, unknown> {
	const payload = buildPayload(opts.positive, opts.resolution);
	const res = await fetch(STREAM_URL, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			accept: 'text/event-stream'
		},
		body: JSON.stringify(payload)
	});
	const ctype = res.headers.get('content-type') ?? '';
	if (!res.ok || !res.body || !ctype.includes('event-stream')) {
		throw new Error(`stream unavailable (${res.status} ${ctype})`);
	}
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	let yielded = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
		let sep: number;
		while ((sep = buf.indexOf('\n\n')) >= 0) {
			const evt = buf.slice(0, sep);
			buf = buf.slice(sep + 2);
			const b64 = parseEventImage(evt);
			if (b64) {
				yielded++;
				yield b64;
			}
		}
	}
	const tail = parseEventImage(buf);
	if (tail) {
		yielded++;
		yield tail;
	}
	if (yielded === 0) throw new Error('stream had no image frames');
}

/** SSE 이벤트 블록에서 base64 이미지 추출(data: 라인 합치기 → JSON.image|img|data 또는 raw base64). */
function parseEventImage(evt: string): string | null {
	const data = evt
		.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).trim())
		.join('');
	if (!data || data === '[DONE]') return null;
	if (data.startsWith('{')) {
		try {
			const obj = JSON.parse(data) as Record<string, unknown>;
			for (const k of ['image', 'img', 'b64', 'data', 'image_b64']) {
				const v = obj[k];
				if (typeof v === 'string' && v.length > 64) return v;
			}
			return null;
		} catch {
			return null;
		}
	}
	return data.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(data) ? data : null;
}

/** 이미지 매직바이트로 포맷 판별(webp/png/jpeg). 알 수 없으면 png 로 간주. */
function sniffImage(b: Uint8Array): { ext: 'webp' | 'png' | 'jpg'; contentType: string } {
	// RIFF....WEBP
	if (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return { ext: 'webp', contentType: 'image/webp' };
	}
	// FF D8 = JPEG
	if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) {
		return { ext: 'jpg', contentType: 'image/jpeg' };
	}
	// 89 50 4E 47 = PNG (기본)
	return { ext: 'png', contentType: 'image/png' };
}

// ─────────────────────────────────────────────────────────────
// 최소 ZIP 추출 — 단일 파일 가정. STORED(0)/DEFLATE(8) 처리.
// ─────────────────────────────────────────────────────────────

const LOCAL_SIG = 0x04034b50; // PK\x03\x04
const CENTRAL_SIG = 0x02014b50; // PK\x01\x02

function readU16(b: Uint8Array, o: number): number {
	return b[o] | (b[o + 1] << 8);
}
function readU32(b: Uint8Array, o: number): number {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** ZIP 의 첫 로컬 파일 항목을 해제해 바이트로 반환. */
async function extractFirstFileFromZip(zip: Uint8Array): Promise<Uint8Array> {
	if (zip.length < 30 || readU32(zip, 0) !== LOCAL_SIG) {
		throw new Error('ZIP 시그니처 불일치');
	}
	const method = readU16(zip, 8);
	const flags = readU16(zip, 6);
	let compSize = readU32(zip, 18);
	const fnameLen = readU16(zip, 26);
	const extraLen = readU16(zip, 28);
	const dataStart = 30 + fnameLen + extraLen;

	// data descriptor(flag bit 3) → 헤더의 compSize 가 0. 중앙 디렉터리 시그니처까지를 데이터로 본다.
	if (compSize === 0 || flags & 0x08) {
		let end = zip.length;
		for (let i = dataStart; i + 4 <= zip.length; i++) {
			if (readU32(zip, i) === CENTRAL_SIG) {
				end = i;
				break;
			}
		}
		// data descriptor 가 데이터 뒤에 붙는 경우(최대 16바이트) 보정.
		if (flags & 0x08) {
			// descriptor: [opt sig(4)] crc(4) compSize(4) uncompSize(4)
			const hasSig = end >= dataStart + 16 && readU32(zip, end - 16) === 0x08074b50;
			end -= hasSig ? 16 : 12;
		}
		compSize = end - dataStart;
	}

	const data = zip.subarray(dataStart, dataStart + compSize);
	if (method === 0) return data.slice(); // STORED — 그대로
	if (method === 8) return await inflateRaw(data); // DEFLATE
	throw new Error(`지원하지 않는 ZIP 압축 방식: ${method}`);
}

/** raw DEFLATE 해제(Web 표준 DecompressionStream). */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('deflate-raw');
	const writer = ds.writable.getWriter();
	// subarray 는 ArrayBufferLike 로 타입되어 write 가 거부 → 새 ArrayBuffer 로 복사.
	const chunk = new Uint8Array(data);
	// 백프레셔로 블로킹되지 않게 write/close 는 await 하지 않고, 읽기 쪽에서 드레인한다.
	void writer.write(chunk);
	void writer.close();
	return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
