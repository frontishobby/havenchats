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

import { DEFAULT_NAI_MODEL, getNaiModel } from '$lib/naiModels';

const SUBSCRIPTION_URL = 'https://api.novelai.net/user/subscription';
const GENERATE_URL = 'https://image.novelai.net/ai/generate-image';
const UPSCALE_URL = 'https://image.novelai.net/ai/upscale'; // api.novelai.net/ai/upscale 은 404(이미지 API 는 image.novelai.net 으로 이전)
/**
 * 업스케일 요청의 필수 `model`. image.novelai.net 은 model 없으면 400("model doesn't exist"),
 * V4.5 id 는 400("doesn't support standalone upscaling"). V5 Full 만 통과(2026-09-05 실측) — 업스케일러 자체는
 * 모델 무관하므로 원본을 만든 그림체 모델과 상관없이 항상 이 값을 보낸다.
 */
const UPSCALE_MODEL = 'nai-diffusion-5-full';

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

/** 상황 프롬프트 뒤에 항상 붙는 퀄리티 꼬리(앞 콤마 포함) — V4.5 용(손튜닝). */
export const QUALITY_TAIL =
	', -4::artist collaboration, year 2025, year 2024, -3::spoken bubble, text, cross-section::, rating:explicit, {{{-3::censored, photo inset, stomach deformation}}}, {{{-3::small lines::}}}, 1.5::balanced contrast::, -2::simple illustration::, -1::censored::, best quality, amazing quality, very aesthetic, intricate detail, highres, incredibly absurdres';

/**
 * V5 용 퀄리티 꼬리(아카 "NAI V5 기초 가이드" + 공식 문서 기준, 2026-09).
 * 가이드 순서: (인원수) > (작가) > (연도) > (배경/장면) > (퀄리티) > (작법) > (마이너스) > nsfw.
 * 이 꼬리는 그 중 **퀄리티 > 마이너스** 구간. V5 는 퀄리티 태그에 가중치를 적극 쓰는 것이 권장(0~3).
 *  - complexity(V5 신규): 일반 이미지엔 high 를 메인(1.5~3), ultra 를 서브(0.2~0.8). flat color 그림체는
 *    low/medium 이 맞으므로 **그림체 프롬프트에 complexity 가 있으면 여기 것은 생략**(buildPositivePrompt).
 *  - 마이너스: 가이드 기본 3종(multiple views·simple illustration·artist collaboration) + 말풍선/텍스트·검열.
 *  - `no text` 는 V5 공식 프리셋 항목.
 */
export const QUALITY_TAIL_V5 =
	', 1.3::very aesthetic, masterpiece, amazing quality, absurdres::, no text, -2::spoken bubble, text::, -1::multiple views::, -1::simple illustration::, -1::artist collaboration::, -1::censored::';

/** V5 complexity 태그(가이드 저자 설정: high 3 / ultra 0.5 → 여기선 high 2 로 완화). 그림체에 complexity 있으면 생략. */
export const COMPLEXITY_V5 = '2::high complexity::, 0.5::ultra complexity::';

/**
 * V5 연도 태그. 그림체에 year 태그가 이미 있으면 생략.
 * **가중치 금지**: `1.5::year 2025::, 1.5::year 2026::` 로 주입하면 작가 가중치가 높은 그림체(1.6~2.5 ×
 * 여러 명)에서 이미지가 통째로 노이즈로 무너진다(2026-09-05 실측 — 선 강함·윤기말랑. complexity 가중치는
 * 무해, cfg_rescale·nsfw 무관, 무가중 연도로 바꾸면 정상). year 는 무가중으로만 넣는다.
 */
export const YEAR_TAGS_V5 = 'year 2025, year 2026';

/** 모델별 퀄리티 꼬리. */
export function qualityTailFor(model: string): string {
	return getNaiModel(model).version === 'v5' ? QUALITY_TAIL_V5 : QUALITY_TAIL;
}

/** 고정 네거티브 프롬프트(V4.5). 맨 앞 아동 코드 차단 태그는 미성년 묘사 억제(하드 차단과 병행). */
export const NEGATIVE_PROMPT =
	'child, loli, shota, toddler, infant, baby, young child, age regression, ' +
	'text, logo, signature, watermark, too many watermarks, chili inset, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, very displeasing, undetailed eyes, multiple views, negative space, blank page, variant set, large variant set, 4koma, 2koma, oekaki, halftone, screentone, artistic error, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors, lowres, worst quality, bad quality, cheesy, sloppiness, unfinished, Incomplete, ai-generated';

/**
 * V5 네거티브. 가이드 순서: (기본 오류) > (세밀한 오류) > (작법 배제 + official style/official art) > (작가 배제) > (원하지 않는 요소).
 * `official style, official art` 는 V5 에서 그림체에 과도하게 영향을 줘 배제가 권장됨. 아동 차단 태그는 항상 맨 앞.
 */
export const NEGATIVE_PROMPT_V5 =
	'child, loli, shota, toddler, infant, baby, young child, age regression, ' +
	// 기본 오류
	'bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, lowres, worst quality, bad quality, blurry, very displeasing, undetailed eyes, chibi, ' +
	// 세밀한 오류(글자·레이아웃)
	'text, logo, signature, watermark, too many watermarks, artist name, chili inset, multiple views, negative space, blank page, variant set, large variant set, 4koma, 2koma, oekaki, artistic error, unfinished, incomplete, sloppiness, ' +
	// 작법 배제(노이즈 유발) + official style/art
	'halftone, screentone, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors, 1990s (style), official style, official art, ' +
	// 작가 배제
	'0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, ' +
	// 원하지 않는 요소
	'cheesy, ai-generated';

/** 모델별 네거티브 프롬프트. */
export function negativeFor(model: string): string {
	return getNaiModel(model).version === 'v5' ? NEGATIVE_PROMPT_V5 : NEGATIVE_PROMPT;
}

/**
 * 그림체 Hub 썸네일용 고정 표준 장면(SFW). 모든 그림체를 같은 장면으로 렌더해 카드 비교가 일관되게.
 * 채팅의 자동 상황 프롬프트 대신 이 값을 상황으로 써서 그림체만 비교되도록 한다.
 */
export const THUMBNAIL_SITUATION =
	'1girl, white_background, black_hair, red_eyes, white_shirt, black_skirt, standing, upper_body, slight_smile, braided_bangs, straight_hair';

export interface ImageParams {
	sampler: string;
	scheduler: string;
	steps: number;
	cfgScale: number;
	cfgRescale: number;
}

/** V4.5 고정 생성 파라미터(docs/realtime-image.md, 손튜닝). */
export const IMAGE_PARAMS: ImageParams = {
	sampler: 'k_euler_ancestral',
	scheduler: 'karras',
	steps: 28,
	cfgScale: 5.8,
	cfgRescale: 0.28
};

/**
 * V5 생성 파라미터(아카 V5 기초 가이드 저자 설정과 동일). euler_a + karras(V5 는 karras 만 받음),
 * CFG 5(권장 4~7), rescale 0.4(권장 0.2~0.5 — 높을수록 채도↓·번짐), steps 28(Opus 무료 상한).
 */
export const IMAGE_PARAMS_V5: ImageParams = {
	sampler: 'k_euler_ancestral',
	scheduler: 'karras',
	steps: 28,
	cfgScale: 5,
	cfgRescale: 0.4
};

/** 모델별 생성 파라미터(디버그 표시·요청 바디 공용). */
export function imageParamsFor(model: string): ImageParams {
	return getNaiModel(model).version === 'v5' ? IMAGE_PARAMS_V5 : IMAGE_PARAMS;
}

/** 허용 해상도(가로×세로). 임의 값 주입 방지. */
export const RESOLUTIONS = {
	'832x1216': { width: 832, height: 1216 },
	'1024x1024': { width: 1024, height: 1024 },
	'1216x832': { width: 1216, height: 832 }
} as const;
export type ResolutionKey = keyof typeof RESOLUTIONS;
export const DEFAULT_RESOLUTION: ResolutionKey = '832x1216';

export function isResolutionKey(v: unknown): v is ResolutionKey {
	return typeof v === 'string' && v in RESOLUTIONS;
}

/**
 * 최종 positive 프롬프트 조립(모델별).
 *
 * V4.5: (NSFW면) rating:nsfw + 그림체 + 상황 + 퀄리티 꼬리(기존 손튜닝 그대로).
 * V5(아카 V5 기초 가이드 순서): **인원수** > 그림체(작가) > 연도 > 장면 나머지 > complexity > 퀄리티/마이너스 > nsfw.
 *  - 인원수 태그(1girl/2boys/solo…)는 상황 프롬프트 어디에 있든 맨 앞으로 끌어올린다(V5 는 위치가 중요).
 *    단일 인물이면 `solo` 를 보강(가이드: 퀄리티에 영향).
 *  - 연도·complexity 는 그림체가 이미 지정했으면 생략(그림체 의도 우선).
 *  - nsfw 는 맨 뒤(가이드). uncensored 동반.
 *  - `scene`(V5 전용, 선택): 상황 프롬프트가 낸 **자연어 장면 문장**(관계·행위 흐름·시선·공간 배치).
 *    V5 는 자연어+태그 혼용을 공식 지원(journal "natural language prompting to the next level", 태그도 그대로).
 *    태그 장면 바로 뒤·complexity 앞에 넣는다("중요한 건 앞쪽 절반" 원칙 안). V4.5 경로에선 무시.
 * 그림체/상황의 끝 콤마를 정리한 뒤 ', ' 로 잇는다. 그림체가 비면 스타일 태그 없이(하드코딩 기본값 없음).
 */
export function buildPositivePrompt(
	stylePrompt: string,
	situation: string,
	nsfw = false,
	model: string = DEFAULT_NAI_MODEL,
	scene = ''
): string {
	const style = stylePrompt.trim().replace(/,\s*$/, '').trim();
	const sit = situation.trim().replace(/,\s*$/, '').trim();
	if (getNaiModel(model).version !== 'v5') {
		const head = [style, sit].filter(Boolean).join(', ');
		const body = head + QUALITY_TAIL;
		return nsfw ? `rating:nsfw, uncensored, ${body}` : body;
	}
	const { count, rest } = hoistCountTags(sit);
	const styleLower = style.toLowerCase();
	const year = /\byear\s*20\d\d\b/.test(styleLower) ? '' : YEAR_TAGS_V5;
	const complexity = /\bcomplexity\b/.test(styleLower) ? '' : COMPLEXITY_V5;
	const sceneText = scene.trim().replace(/[.,\s]+$/, '').trim();
	const head = [count, style, year, rest, sceneText, complexity].filter(Boolean).join(', ');
	const body = head + QUALITY_TAIL_V5;
	return nsfw ? `${body}, nsfw, uncensored` : body;
}

/** 인원수 태그(1girl, 2boys, 6+girls, multiple girls, solo, 1other …). */
const COUNT_TAG_RE = /^(?:solo|\d+\+?\s?(?:girls?|boys?|others?)|multiple (?:girls|boys|others))$/i;

/**
 * 상황 프롬프트에서 인원수 태그를 분리해 맨 앞 그룹으로 만든다(V5). 세그먼트 순서는 유지.
 * 인원수 태그가 정확히 하나이고 1명(1girl/1boy/1other)이면 `solo` 를 보강한다.
 */
function hoistCountTags(situation: string): { count: string; rest: string } {
	const segs = situation
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);
	const counts = segs.filter((x) => COUNT_TAG_RE.test(x));
	const rest = segs.filter((x) => !COUNT_TAG_RE.test(x));
	const nonSolo = counts.filter((x) => x.toLowerCase() !== 'solo');
	if (nonSolo.length === 1 && /^1(?:girl|boy|other)$/i.test(nonSolo[0]) && !counts.some((x) => x.toLowerCase() === 'solo')) {
		counts.push('solo');
	}
	return { count: counts.join(', '), rest: rest.join(', ') };
}

export interface GeneratedImage {
	bytes: Uint8Array;
	ext: 'webp' | 'png' | 'jpg';
	contentType: string;
}

export type GenerateResult =
	| { ok: true; image: GeneratedImage }
	| { ok: false; status: number; message: string };

/**
 * AUTO 위치(좌표 미지정) 센터. NAI 의 PositionMap.AUTO = (0,0). `use_coords:false` 면 무시되지만
 * char_caption 마다 centers 배열이 있어야 하므로 동일하게 채운다(NAI 가 알아서 배치).
 */
const AUTO_CENTER = [{ x: 0, y: 0 }];

/** NovelAI 이미지 생성 요청 → ZIP 해제 → 이미지 바이트. */
/**
 * generate / generate-stream 공용 요청 바디.
 *
 * `charCaptions` 가 비면(기본) 단일 base_caption 만 쓰는 기존 동작과 동일(char_captions:[]).
 * 인물별 캡션을 주면 NAI V4.5/V5 **캐릭터 기능**(char_captions 분리)으로 외형 누출(머리색·옷 bleeding)
 * 을 막는다. 모델(`model`)은 그림체에 박힌 id(lib/naiModels.ts 허용목록) — V5 는 params_version 4. 위치는 항상 AUTO(use_coords:false) — 순서(use_order)+상호작용 태그로만 제어한다.
 * 음수 프롬프트의 char_captions 는 양수와 **개수를 맞춰**(빈 캡션) 안정성을 확보한다.
 */
export function buildGeneratePayload(
	positive: string,
	charCaptions: string[],
	resolution: ResolutionKey,
	model: string = DEFAULT_NAI_MODEL
) {
	const { width, height } = RESOLUTIONS[resolution];
	const spec = getNaiModel(model);
	const params = imageParamsFor(spec.id);
	// 0 ~ 2^32-1 시드(Workers: crypto.getRandomValues).
	const seed = crypto.getRandomValues(new Uint32Array(1))[0];
	// 모델별 인물 상한(V4.5=6, V5=32). 초과분은 잘라낸다.
	const chars = charCaptions.map((c) => c.trim()).filter(Boolean).slice(0, spec.maxCharacters);
	const posCharCaptions = chars.map((c) => ({ char_caption: c, centers: AUTO_CENTER }));
	// 음수는 인물별 별도 UC 없이 개수만 맞춘 빈 캡션(전역 네거티브는 base_caption 에).
	const negCharCaptions = chars.map(() => ({ char_caption: '', centers: AUTO_CENTER }));
	return {
		input: positive,
		model: spec.id,
		action: 'generate',
		parameters: {
			// V5 는 프런트가 4 를 보낸다(3 도 수용). V4.5 는 기존 그대로 3.
			params_version: spec.version === 'v5' ? 4 : 3,
			width,
			height,
			scale: params.cfgScale,
			sampler: params.sampler,
			steps: params.steps,
			n_samples: 1,
			ucPreset: 0,
			qualityToggle: false, // 퀄리티 태그를 프롬프트에 직접 포함하므로 자동 토글 끔
			autoSmea: false,
			dynamic_thresholding: false,
			controlnet_strength: 1,
			legacy: false,
			add_original_image: true,
			cfg_rescale: params.cfgRescale,
			noise_schedule: params.scheduler, // V5 는 karras 만 허용(프런트도 강제)
			legacy_v3_extend: false,
			skip_cfg_above_sigma: null,
			seed,
			negative_prompt: negativeFor(spec.id),
			v4_prompt: {
				caption: { base_caption: positive, char_captions: posCharCaptions },
				use_coords: false,
				use_order: true
			},
			v4_negative_prompt: {
				caption: { base_caption: negativeFor(spec.id), char_captions: negCharCaptions },
				legacy_uc: false
			}
		}
	};
}

export async function generateImage(
	token: string,
	opts: { positive: string; charCaptions?: string[]; resolution: ResolutionKey; model?: string }
): Promise<GenerateResult> {
	const payload = buildGeneratePayload(opts.positive, opts.charCaptions ?? [], opts.resolution, opts.model);

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
 *   POST /ai/upscale  body { image: base64, width, height, scale, model } → 응답 ZIP(image_0.png 1장).
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
				scale,
				model: UPSCALE_MODEL
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
 * **마지막 yield 가 최종 이미지**. 이벤트에 `event_type` 이 있으면 `final` 을 받은 뒤에만 정상 종료하고,
 * 최종 없이 스트림이 끊기면(중간 JPEG 프리뷰 = 디노이즈 초기 노이즈만 남는 상태) throw → 호출부가
 * 비스트리밍(ZIP) 폴백으로 진짜 최종 이미지를 받는다. 엔드포인트/포맷 미지원·무프레임도 throw.
 */
export async function* generateImageStream(
	token: string,
	opts: { positive: string; charCaptions?: string[]; resolution: ResolutionKey; model?: string }
): AsyncGenerator<string, void, unknown> {
	const payload = buildGeneratePayload(opts.positive, opts.charCaptions ?? [], opts.resolution, opts.model);
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
	let typed = false; // event_type 을 가진 이벤트를 하나라도 봤는가
	let sawFinal = false;
	const consume = function* (evt: string) {
		const parsed = parseEventImage(evt);
		if (!parsed) return;
		if (parsed.type) typed = true;
		if (parsed.type === 'error') throw new Error(`NovelAI stream error: ${parsed.message ?? ''}`);
		if (!parsed.b64) return;
		if (parsed.type === 'final') sawFinal = true;
		yielded++;
		yield parsed.b64;
	};
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
		let sep: number;
		while ((sep = buf.indexOf('\n\n')) >= 0) {
			const evt = buf.slice(0, sep);
			buf = buf.slice(sep + 2);
			yield* consume(evt);
		}
	}
	yield* consume(buf);
	if (yielded === 0) throw new Error('stream had no image frames');
	if (typed && !sawFinal) throw new Error('stream ended without final frame');
}

/**
 * SSE 이벤트 블록 해석(data: 라인 합치기 → JSON 또는 raw base64).
 * JSON 이면 `event_type`(intermediate|final|error) 과 image|img|b64|data|image_b64 중 base64 를 꺼낸다.
 */
function parseEventImage(evt: string): { b64: string | null; type: string | null; message?: string } | null {
	const data = evt
		.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).trim())
		.join('');
	if (!data || data === '[DONE]') return null;
	if (data.startsWith('{')) {
		try {
			const obj = JSON.parse(data) as Record<string, unknown>;
			const type = typeof obj.event_type === 'string' ? obj.event_type : null;
			const message = typeof obj.message === 'string' ? obj.message : undefined;
			for (const k of ['image', 'img', 'b64', 'data', 'image_b64']) {
				const v = obj[k];
				if (typeof v === 'string' && v.length > 64) return { b64: v, type, message };
			}
			return { b64: null, type, message };
		} catch {
			return null;
		}
	}
	return data.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(data) ? { b64: data, type: null } : null;
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
const EOCD_SIG = 0x06054b50; // PK\x05\x06 — End Of Central Directory

function readU16(b: Uint8Array, o: number): number {
	return b[o] | (b[o + 1] << 8);
}
function readU32(b: Uint8Array, o: number): number {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * ZIP 의 첫 파일 항목을 해제해 바이트로 반환.
 *
 * NovelAI 는 ZIP 을 스트리밍 생성하므로 로컬 헤더에 data descriptor(flag bit 3)를 쓰고
 * compSize 를 0 으로 남긴다. 따라서 로컬 헤더만으로는 데이터 길이를 알 수 없다.
 * → 데이터를 전진 풀스캔(멀티-MB × readU32, ~400ms CPU)하는 대신,
 *   파일 끝의 EOCD → 중앙 디렉터리에서 압축 크기/방식/로컬 헤더 오프셋을 O(1) 로 읽는다.
 */
async function extractFirstFileFromZip(zip: Uint8Array): Promise<Uint8Array> {
	if (zip.length < 22 || readU32(zip, 0) !== LOCAL_SIG) {
		throw new Error('ZIP 시그니처 불일치');
	}
	// EOCD 는 보통 마지막 22바이트. 주석이 있으면 그 앞(최대 64KB)에서 역방향 탐색.
	const minEocd = Math.max(0, zip.length - 22 - 0xffff);
	let eocd = -1;
	for (let i = zip.length - 22; i >= minEocd; i--) {
		if (readU32(zip, i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('ZIP EOCD 불일치');

	const cdOffset = readU32(zip, eocd + 16);
	if (readU32(zip, cdOffset) !== CENTRAL_SIG) throw new Error('ZIP 중앙 디렉터리 불일치');
	const method = readU16(zip, cdOffset + 10);
	const compSize = readU32(zip, cdOffset + 20);
	const localOffset = readU32(zip, cdOffset + 42);

	// 데이터 시작은 로컬 헤더 기준(파일명/extra 길이는 중앙 디렉터리와 다를 수 있음).
	if (readU32(zip, localOffset) !== LOCAL_SIG) throw new Error('ZIP 로컬 헤더 불일치');
	const fnameLen = readU16(zip, localOffset + 26);
	const extraLen = readU16(zip, localOffset + 28);
	const dataStart = localOffset + 30 + fnameLen + extraLen;

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
