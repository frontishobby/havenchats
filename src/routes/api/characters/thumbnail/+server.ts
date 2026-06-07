import { json, type RequestHandler } from '@sveltejs/kit';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { isAdmin } from '$lib/server/auth';
import { notifyServerError } from '$lib/server/notify';
import { buildProviderOptions, reasoningHeadroom } from '$lib/server/chatAssembly';
import { isOverDailyBudget, addDailySpend, DAILY_BUDGET_USD } from '$lib/server/budget';
import { MODEL_IDS } from '$lib/data/models';
import {
	buildPositivePrompt,
	generateImage,
	generateImageStream,
	type ResolutionKey
} from '$lib/server/novelai';

/**
 * 캐릭터 썸네일 생성(로그인 필수, 유저 본인 NovelAI 키·Anlas 사용).
 *
 * 제작 폼의 설정(프롬프트/이름)을 근거로:
 *  1) (situation 미지정 또는 regenSituation 시) LLM 이 외형을 danbooru 태그 + 인물 포트레이트
 *     상황 프롬프트로 변환 → NDJSON 첫 줄 t:'situation' 으로 돌려줌(클라가 편집 input 채움).
 *  2) 그림체(style) + 상황 + 고정 퀄리티/네거티브로 NovelAI 생성(세로 832×1216). 프레임 스트리밍.
 * 영속화하지 않는다 — 클라가 마음에 드는 컷을 webp 로 변환해 폼 썸네일로 등록한다.
 *
 * 비용: LLM 상황 변환 비용만 유저 일일 카운터에 가산(NovelAI 는 유저 Anlas).
 */

const THUMB_RESOLUTION: ResolutionKey = '832x1216';
const DEFAULT_PROMPT_MODEL = 'google/gemini-3.5-flash';
const MAX_DESC_CHARS = 6000;
const MAX_STYLE_CHARS = 1500;
const MAX_SITU_CHARS = 1000;
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/;

/** 요청 모델 허용목록 검증. 없거나 미허용이면 기본(flash). */
function pickPromptModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_PROMPT_MODEL;
}

const SITUATION_SYSTEM = [
	`You convert a Korean character setup sheet into an image-generation prompt for a CHARACTER THUMBNAIL/PORTRAIT (NovelAI Diffusion V4.5, anime illustration).`,
	`You are given the [Character] setup text. Extract the character's fixed physical appearance (count e.g. 1girl/1boy, hair color/length/style, eye color, body type, skin, distinctive features) and a representative outfit. Ignore non-visual text (personality, backstory, rules, command/keyword lists, output-format instructions).`,
	`Compose a flattering, character-focused portrait: a clear single-subject shot (upper body or cowboy shot), looking at viewer, expression that fits the character, simple or fitting background.`,
	`Output format: two parts joined by a comma.`,
	`  PART 1 — Danbooru-style appearance/outfit tags. Lowercase, comma-separated (count tag, hair, eyes, body, outfit, plus "looking at viewer" and a fitting expression).`,
	`  PART 2 — one short English phrase for the composition/background (e.g. "upper body portrait, soft studio lighting, plain background").`,
	`Example: "1girl, long black hair, red eyes, slim, large breasts, school uniform, looking at viewer, gentle smile, upper body, soft lighting, simple background"`,
	`Rules:`,
	`- English only. No Korean.`,
	`- Do NOT include quality boosters, artist names, "masterpiece", resolution tags, or negative terms — those are added separately.`,
	`- No preamble, no explanation, no quotes, no line breaks, no labels like "PART 1". Output the prompt only.`,
	`- Keep it concise: under ~40 tags total.`
].join('\n');

/** 모델이 한글 상태창을 통짜로 베끼는 걸 막는다 — 한글 포함 세그먼트 제거 후 영어 태그만 재조립. */
function sanitizeSituation(raw: string): string {
	return raw
		.split(/[\r\n,]+/)
		.map((s) => s.trim())
		.filter((s) => s && !HANGUL_RE.test(s))
		.join(', ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** AI Gateway providerMetadata 에서 이번 호출 추론 비용(USD) 추출. */
function parseGatewayCost(providerMetadata: unknown): number | undefined {
	const meta = providerMetadata as { gateway?: { cost?: unknown } } | undefined;
	const raw = meta?.gateway?.cost;
	if (raw == null) return undefined;
	const n = typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

interface Body {
	/** 캐릭터 설정(프롬프트 본문) — 외형 추출용. situation 을 직접 줄 땐 없어도 됨. */
	description?: string;
	/** 그림체(스타일) 프롬프트. 없으면 그림체 미적용. */
	style?: string;
	/** 상황 프롬프트(danbooru). 비어 있으면 서버가 LLM 으로 생성해 돌려준다. */
	situation?: string;
	/** true 면 situation 이 있어도 설정 기반으로 다시 생성. */
	regenSituation?: boolean;
	/** NSFW 캐릭터면 positive 앞에 rating:nsfw. */
	nsfw?: boolean;
	/** 상황 변환 모델(허용목록). 없으면 기본 flash. */
	model?: string;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	// 일일 비용 상한 게이트 — 채팅·이미지와 같은 카운터.
	const kv = platform?.env?.SESSIONS;
	if (!isAdmin(locals.user.email) && (await isOverDailyBudget(kv, locals.user.id, Date.now()))) {
		return json({ error: 'daily_limit', limit: DAILY_BUDGET_USD }, { status: 429 });
	}

	const body = (await request.json().catch(() => null)) as Body | null;
	const description = (body?.description ?? '').trim().slice(0, MAX_DESC_CHARS);
	const style = (body?.style ?? '').slice(0, MAX_STYLE_CHARS);
	const givenSituation = (body?.situation ?? '').trim().slice(0, MAX_SITU_CHARS);
	const regen = body?.regenSituation === true;
	const isNsfw = body?.nsfw === true;
	const model = pickPromptModel(body?.model);

	// NovelAI 키 — 없으면 안내(클라가 등록 유도).
	const naiKey = await getDecryptedKey(db, locals.user.id, 'novelai');
	if (!naiKey) {
		return json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			{ status: 400 }
		);
	}

	// ── 1) 상황 프롬프트 결정: 주어졌고 regen 아니면 그대로, 아니면 LLM 생성 ──
	let situation = givenSituation;
	const needLlm = !situation || regen;
	if (needLlm) {
		const apiKey = await getDecryptedKey(db, locals.user.id, 'gateway');
		if (!apiKey) {
			return json(
				{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
				{ status: 400 }
			);
		}
		if (!description) {
			return json(
				{ error: 'no_desc', message: '프롬프트(설정)를 먼저 작성하거나 상황을 직접 입력해 주세요.' },
				{ status: 400 }
			);
		}
		try {
			const gateway = createGateway({ apiKey });
			const result = await generateText({
				model: gateway(model),
				system: SITUATION_SYSTEM,
				prompt: `[Character]\n${description}`,
				temperature: 0.8,
				maxOutputTokens: 1500 + reasoningHeadroom(model),
				providerOptions: buildProviderOptions(model, { noThinking: true })
			});
			situation = sanitizeSituation(result.text ?? '');
			const cost = parseGatewayCost(result.providerMetadata);
			platform?.context?.waitUntil?.(addDailySpend(kv, locals.user.id, cost, Date.now()));
		} catch (e) {
			console.error('[characters/thumbnail] situation prompt error:', e);
			notifyServerError({
				context: 'generateText /api/characters/thumbnail',
				error: e,
				extra: { user: locals.user.id, model },
				waitUntil: platform?.context?.waitUntil?.bind(platform.context)
			});
			return json(
				{ error: 'situation', message: '상황 프롬프트 생성에 실패했어요. 다시 시도해 주세요.' },
				{ status: 502 }
			);
		}
		if (!situation) {
			return json(
				{ error: 'situation', message: '상황 프롬프트가 비어 있어 생성하지 않았어요. 설정을 더 구체적으로 적어 주세요.' },
				{ status: 502 }
			);
		}
	}

	const positive = buildPositivePrompt(style, situation, isNsfw);

	// ── 2) NovelAI 스트리밍 생성 ──
	// NDJSON: 먼저 t:'situation'(편집 input 채움) → t:'frame'(중간) … → t:'final'(최종 base64).
	const sit = situation;
	const enc = new TextEncoder();
	const ln = (o: unknown) => enc.encode(JSON.stringify(o) + '\n');
	const stream = new ReadableStream({
		async start(controller) {
			controller.enqueue(ln({ t: 'situation', situation: sit }));

			let finalB64: string | null = null;
			try {
				for await (const b64 of generateImageStream(naiKey, {
					positive,
					resolution: THUMB_RESOLUTION
				})) {
					finalB64 = b64;
					controller.enqueue(ln({ t: 'frame', img: b64 }));
				}
			} catch (e) {
				console.warn('[characters/thumbnail] 스트리밍 실패 → 폴백:', String(e));
				finalB64 = null;
			}
			if (finalB64) {
				controller.enqueue(ln({ t: 'final', img: finalB64 }));
				controller.close();
				return;
			}
			// 폴백: 비스트리밍 생성 → 최종 1장.
			const gen = await generateImage(naiKey, { positive, resolution: THUMB_RESOLUTION });
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
