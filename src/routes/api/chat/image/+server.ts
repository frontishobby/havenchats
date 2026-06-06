import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import {
	getSession,
	appendMessage,
	getOwnedMessage,
	updateMessageContentCost
} from '$lib/server/db/chats';
import { findCharacter } from '$lib/server/characters';
import { getCharacterPrompt } from '$lib/server/db/characters';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import {
	buildPositivePrompt,
	generateImage,
	generateImageStream,
	b64ToImage,
	isResolutionKey,
	DEFAULT_RESOLUTION,
	NEGATIVE_PROMPT,
	MODEL,
	IMAGE_PARAMS,
	type ResolutionKey
} from '$lib/server/novelai';
import { buildProviderOptions, reasoningHeadroom } from '$lib/server/chatAssembly';
import { notifyServerError } from '$lib/server/notify';
import { MODEL_IDS } from '$lib/data/models';
import type { ImageDebug } from '$lib/chatDebug';

/**
 * 실시간 이미지 생성(로그인 필수). 채팅에서 "실시간 이미지"가 켜져 있을 때 매 assistant 턴
 * 직후 클라이언트가 호출한다.
 *
 * 흐름:
 *  1) 세션 소유권 확인 + 유저 NovelAI 키 복호화.
 *  2) 선택된 LLM(기본 google/gemini-3.5-flash)으로 마지막 assistant 응답 → "상황 프롬프트"
 *     (best-effort danbooru 태그 + 필요 시 자연어). 이 비용(USD)은 메시지 cost 로 표시된다.
 *  3) 그림체 + 상황 + 퀄리티 → NovelAI 생성(고정 네거티브/파라미터). ZIP→이미지 바이트.
 *  4) R2(chatimg/<sessionId>/<msgId>.<ext>) 저장 + role=image_generation 메시지 영속.
 */

/** 상황 프롬프트 생성 기본 모델(설정에서 바꿀 수 있음). */
const DEFAULT_PROMPT_MODEL = 'google/gemini-3.5-flash';
const MAX_ASSISTANT_CHARS = 6000;
const MAX_STYLE_CHARS = 1000;
/** 외형 레퍼런스로 넣을 캐릭터 description 최대 길이(자). 토큰·지연 보호용. */
const MAX_DESC_CHARS = 6000;

/** 요청의 상황 프롬프트 모델 검증(허용목록). 없거나 미허용이면 기본 모델. */
function pickPromptModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_PROMPT_MODEL;
}

const SITUATION_SYSTEM = [
	`You convert the latest moment of a Korean roleplay scene into an image-generation prompt for NovelAI Diffusion V4.5 (anime illustration).`,
	`You are given a [Character] reference sheet and the [Latest scene]. ALWAYS reflect the character's fixed physical appearance from the reference (hair color/length/style, eye color, body type, skin, distinctive features) so the character looks consistent across images. But depict ONLY the [Latest scene]'s current moment — pose, expression, action, current clothing or state of undress, and setting. Ignore the reference's non-visual text (personality, backstory, rules, command/keyword lists).`,
	`Describe ONLY what is visually depictable in a single still image of the most recent moment: the character(s) present, appearance (hair, eyes, body), clothing or state of undress, facial expression, pose, action, camera angle/framing, composition, setting/background, lighting and mood.`,
	`Output format: a single comma-separated prompt. Prefer Danbooru-style tags (e.g. "1girl, long hair, blush, sitting, indoors, night"); use short natural-language phrases only when a situation is hard to express as tags.`,
	`Rules:`,
	`- English only. Lowercase tags.`,
	`- Focus on the single most recent visual beat, not the whole history.`,
	`- Do NOT include quality boosters, artist names, "masterpiece", resolution tags, or negative terms — those are added separately.`,
	`- No preamble, no explanation, no quotes, no line breaks. Output the prompt only.`,
	`- NSFW content is allowed and should be described plainly when present.`,
	`- Keep it under ~60 tags.`
].join('\n');

interface ImageRequestBody {
	sessionId?: string;
	/** 방금 완료된 assistant 응답 본문(상황 프롬프트 입력). */
	assistantText?: string;
	resolution?: string;
	/** 항상 적용할 그림체 프롬프트(없으면 기본값). */
	stylePrompt?: string;
	/** 상황 프롬프트를 생성할 LLM 모델 id(허용목록 검증). 없으면 기본 모델. */
	promptModel?: string;
	/** 재생성: 이 image_generation 메시지를 제자리(같은 행/순서)에서 덮어쓴다. */
	replaceId?: string;
	/** 디버그 모드: 응답에 사용한 프롬프트/파라미터를 동봉. */
	debug?: boolean;
}

/**
 * 일시적(재시도 가능) 게이트웨이/공급자 에러인지. AI Gateway 는 Gemini 등의 503/500
 * ("Service temporarily unavailable")을 자동 재시도하지 않으므로 직접 판별해 재시도한다.
 */
function isTransientGatewayError(e: unknown): boolean {
	const err = e as { name?: string; statusCode?: number; message?: string; code?: string } | undefined;
	const code = err?.statusCode;
	if (typeof code === 'number' && [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(code))
		return true;
	const name = err?.name ?? '';
	if (/Gateway(Internal|Timeout|Response)|Overloaded|ServiceUnavailable/i.test(name)) return true;
	const msg = (err?.message ?? '').toLowerCase();
	return /temporarily unavailable|service unavailable|overloaded|try again|rate limit|timeout/.test(msg);
}

/** generateText 를 일시적 에러에 한해 백오프 재시도한다(기본 2회 추가 시도). */
async function generateTextWithRetry(
	opts: Parameters<typeof generateText>[0],
	retries = 2
): Promise<Awaited<ReturnType<typeof generateText>>> {
	let lastErr: unknown;
	for (let i = 0; i <= retries; i++) {
		try {
			return await generateText(opts);
		} catch (e) {
			lastErr = e;
			if (i < retries && isTransientGatewayError(e)) {
				console.warn(`[chat/image] 상황 프롬프트 일시적 에러 — 재시도 ${i + 1}/${retries}:`, String(e));
				await new Promise((r) => setTimeout(r, 500 * (i + 1)));
				continue;
			}
			throw e;
		}
	}
	throw lastErr;
}

/** AI Gateway providerMetadata 에서 이번 호출 추론 비용(USD) 추출. */
function parseGatewayCost(providerMetadata: unknown): number | undefined {
	const meta = providerMetadata as { gateway?: { cost?: unknown } } | undefined;
	const raw = meta?.gateway?.cost;
	if (raw == null) return undefined;
	const n = typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	const bucket = platform?.env?.IMAGES;
	if (!db || !bucket) return json({ error: 'storage unavailable' }, { status: 500 });

	const body = (await request.json().catch(() => null)) as ImageRequestBody | null;
	const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
	if (!sessionId) return json({ error: 'session required' }, { status: 400 });

	const session = await getSession(db, sessionId, locals.user.id);
	if (!session) return json({ error: 'session not found' }, { status: 404 });

	// 재생성 대상(있으면): 소유·세션·역할 검증. 통과 시 같은 행/R2 키를 덮어쓴다.
	let replaceMsgId: string | null = null;
	let oldImageKey: string | null = null;
	const replaceId = typeof body?.replaceId === 'string' ? body.replaceId : '';
	if (replaceId) {
		const target = await getOwnedMessage(db, replaceId, locals.user.id);
		if (!target || target.sessionId !== sessionId || target.role !== 'image_generation') {
			return json({ error: 'message not found' }, { status: 404 });
		}
		replaceMsgId = target.id;
		oldImageKey = target.content || null;
	}

	// 캐릭터가 NSFW 면 positive 프롬프트 맨 앞에 rating:nsfw 를 붙인다(서버에서 판별 — 클라 위조 방지).
	const character = await findCharacter(db, session.characterId);
	const isNsfw = character?.contentRating === 'nsfw';

	// 외형 일관성용 캐릭터 description(통짜). imported 카드는 클라 노출 차단으로 비어 있어 서버 원본을 읽는다.
	let characterRef = character?.description ?? '';
	if (character?.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw) characterRef = raw;
	}
	characterRef = characterRef.trim().slice(0, MAX_DESC_CHARS);

	const assistantText = (body?.assistantText ?? '').trim().slice(0, MAX_ASSISTANT_CHARS);
	if (!assistantText) return json({ error: 'empty assistant text' }, { status: 400 });

	const resolution: ResolutionKey = isResolutionKey(body?.resolution)
		? body.resolution
		: DEFAULT_RESOLUTION;
	const stylePrompt = (body?.stylePrompt ?? '').slice(0, MAX_STYLE_CHARS);
	const promptModel = pickPromptModel(body?.promptModel);

	// NovelAI 키 — 없으면 안내(클라가 등록 유도).
	const naiKey = await getDecryptedKey(db, locals.user.id, 'novelai');
	if (!naiKey) {
		return json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			{ status: 400 }
		);
	}

	// ── 1) Gemini 상황 프롬프트 (필수) ──
	// 상황 프롬프트 생성이 실패/빈값이면 NovelAI 요청을 보내지 않는다(Anlas·비용 낭비 방지).
	const apiKey = env.AI_GATEWAY_API_KEY;
	if (!apiKey) {
		return json(
			{ error: 'situation', message: '이미지 프롬프트 생성을 사용할 수 없습니다 (AI Gateway 미설정).' },
			{ status: 503 }
		);
	}

	// 디버그(요청자가 debug 모드일 때만)용 진단값 누적 — 성공·실패 양쪽에서 동봉한다.
	let situation = '';
	let rawSituation = '';
	let finishReason: string | null = null;
	let warnings: unknown[] = [];
	let llmError: string | null = null;
	let cost: number | undefined;

	/** 현재까지 모은 진단으로 ImageDebug 구성(positive 는 인자로). debug 모드 아니면 undefined. */
	const makeDebug = (positive: string | null): ImageDebug | undefined =>
		body?.debug
			? {
					promptModel,
					characterRef,
					situation,
					rawSituation,
					finishReason,
					warnings,
					llmError,
					stylePrompt,
					positive,
					negative: NEGATIVE_PROMPT,
					model: MODEL,
					resolution,
					params: {
						sampler: IMAGE_PARAMS.sampler,
						scheduler: IMAGE_PARAMS.scheduler,
						steps: IMAGE_PARAMS.steps,
						cfgScale: IMAGE_PARAMS.cfgScale,
						cfgRescale: IMAGE_PARAMS.cfgRescale
					}
				}
			: undefined;

	try {
		const gateway = createGateway({ apiKey });
		// 외형 일관성을 위해 캐릭터 description(통짜)을 레퍼런스로 함께 넣고, 그릴 대상은 최신 장면.
		const userPrompt = characterRef
			? `[Character]\n${characterRef}\n\n[Latest scene]\n${assistantText}`
			: assistantText;
		// 게이트웨이가 일시적 503/500 을 자동 재시도하지 않으므로 직접 백오프 재시도한다.
		const result = await generateTextWithRetry({
			model: gateway(promptModel),
			system: SITUATION_SYSTEM,
			prompt: userPrompt,
			temperature: 0.7,
			// 상황 프롬프트는 단순 태그 변환이라 thinking 을 끈다(지연·빈응답 감소). 그래도 thinking 을
			// 못 끄는 모델 대비 headroom 은 남겨 둔다(maxOutputTokens 는 상한이라 지연엔 영향 없음).
			maxOutputTokens: 2000 + reasoningHeadroom(promptModel),
			providerOptions: buildProviderOptions(promptModel, { noThinking: true })
		});
		rawSituation = result.text ?? '';
		situation = rawSituation.trim().replace(/\s+/g, ' ');
		finishReason = (result.finishReason as string | undefined) ?? null;
		warnings = result.warnings ?? [];
		cost = parseGatewayCost(result.providerMetadata);
	} catch (e) {
		console.error('[chat/image] situation prompt error:', e);
		llmError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		notifyServerError({
			context: 'generateText /api/chat/image',
			error: e,
			extra: { session: sessionId, user: locals.user.id, model: promptModel },
			waitUntil: platform?.context?.waitUntil?.bind(platform.context)
		});
		return json(
			{
				error: 'situation',
				message: '상황 프롬프트 생성에 실패해 이미지를 생성하지 않았습니다.',
				debug: makeDebug(null)
			},
			{ status: 502 }
		);
	}

	// 빈 상황 프롬프트(모델이 아무것도 못 냄·안전필터 차단 등) → NovelAI 호출하지 않음.
	if (!situation) {
		console.warn(
			`[chat/image] 상황 프롬프트가 비어 있음 (model=${promptModel}, finishReason=${finishReason}) — NovelAI 요청 생략`
		);
		return json(
			{
				error: 'situation',
				message: `상황 프롬프트가 비어 있어 이미지를 생성하지 않았습니다.${finishReason && finishReason !== 'stop' ? ` (finishReason=${finishReason})` : ''}`,
				debug: makeDebug(null)
			},
			{ status: 502 }
		);
	}

	const positive = buildPositivePrompt(stylePrompt, situation, isNsfw);

	// ── 2) NovelAI 생성(스트리밍) ──
	// NDJSON 스트림으로 중간 프레임(t:frame)을 흘려보내 진행 상황을 보여주고, 끝에 R2 저장 후
	// t:done(또는 t:error). 스트리밍 미지원/실패 시 비스트리밍 generateImage 로 폴백한다.
	const sid = sessionId; // 클로저에서 non-null 보장
	const enc = new TextEncoder();
	const line = (obj: unknown) => enc.encode(JSON.stringify(obj) + '\n');

	const stream = new ReadableStream({
		async start(controller) {
			// 2-1) 스트리밍 시도(프레임 emit, 마지막 프레임 = 최종 후보).
			let finalB64: string | null = null;
			try {
				for await (const b64 of generateImageStream(naiKey, { positive, resolution })) {
					finalB64 = b64;
					controller.enqueue(line({ t: 'frame', img: b64 }));
				}
			} catch (e) {
				console.warn('[chat/image] 스트리밍 실패 → 비스트리밍 폴백:', String(e));
				finalB64 = null;
			}

			// 2-2) 최종 이미지 확정(스트림 성공 시 마지막 프레임, 실패 시 비스트리밍 재생성).
			let image: { bytes: Uint8Array; ext: string; contentType: string } | null = null;
			if (finalB64) {
				try {
					image = b64ToImage(finalB64);
				} catch {
					image = null;
				}
			}
			if (!image) {
				const gen = await generateImage(naiKey, { positive, resolution });
				if (!gen.ok) {
					controller.enqueue(line({ t: 'error', error: 'novelai', message: gen.message, debug: makeDebug(positive) }));
					controller.close();
					return;
				}
				image = gen.image;
			}

			// 2-3) R2 저장 + 메시지 영속.
			// R2 키는 항상 새 무작위 id 로 만든다 — 재생성 때 같은 키를 덮어쓰면 /img 의 1일 캐시·엣지
			// 캐시가 옛 이미지를 계속 서빙하므로(URL 동일), 새 키로 만들어 캐시 충돌을 피한다.
			const keyId = crypto.randomUUID();
			const key = `chatimg/${sid}/${keyId}.${image.ext}`;
			try {
				await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
			} catch (e) {
				console.error('[chat/image] R2 put 실패:', e);
				controller.enqueue(line({ t: 'error', error: 'storage', message: '이미지 저장에 실패했습니다.' }));
				controller.close();
				return;
			}
			if (replaceMsgId) {
				// 같은 메시지 행(순서 유지)의 content 만 새 키로 갱신하고 이전 오브젝트는 정리.
				await updateMessageContentCost(db, replaceMsgId, key, cost);
				if (oldImageKey && oldImageKey !== key) {
					try {
						await bucket.delete(oldImageKey);
					} catch {
						/* 무시 — 정리 실패는 무해 */
					}
				}
			} else {
				await appendMessage(db, sid, 'image_generation', key, undefined, undefined, cost, keyId);
			}
			// done.id = 클라가 매칭할 메시지 행 id (재생성이면 기존 행, 신규면 키 id 와 동일).
			const rowId = replaceMsgId ?? keyId;
			controller.enqueue(line({ t: 'done', id: rowId, key, cost: cost ?? null, debug: makeDebug(positive) }));
			controller.close();
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }
	});
};
