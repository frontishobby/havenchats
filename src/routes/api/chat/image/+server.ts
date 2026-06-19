import { getWaitUntil } from '$lib/server/waitUntil';
import { getImages } from '$lib/server/images';
import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { generateObject, jsonSchema } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import {
	getSession,
	appendMessage,
	getOwnedMessage,
	messageExists,
	updateMessageContentCost,
	updateAppearances
} from '$lib/server/db/chats';
import type { AppearanceLedger } from '$lib/types';
import { findCharacter } from '$lib/server/characters';
import { getCharacterPrompt } from '$lib/server/db/characters';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { containsMinorTerms } from '$lib/server/minorSafety';
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
import { IMAGE_PROMPT_MODEL_IDS, DEFAULT_IMAGE_PROMPT_MODEL_ID } from '$lib/data/models';
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

const MAX_ASSISTANT_CHARS = 6000;
const MAX_STYLE_CHARS = 1000;
/** 외형 레퍼런스로 넣을 캐릭터 description 최대 길이(자). 토큰·지연 보호용. */
const MAX_DESC_CHARS = 6000;
/** 최근 대화 블록: 메시지 개수·메시지당 길이 상한(토큰·지연 보호용). */
const MAX_RECENT_MSGS = 6;
const MAX_RECENT_MSG_CHARS = 2000;
/** NAI V4.5 캐릭터 최대 인원(공식 상한 6). 초과분은 잘라낸다. */
const MAX_CHARACTERS = 6;
/** 외형 원장 최대 인원. 초과 시 가장 오래 안 나온 인물부터 evict. */
const MAX_LEDGER_ENTRIES = 16;
/** 원장에 박는 고정 외형 태그 최대 길이(자). */
const MAX_APPEARANCE_CHARS = 300;

/** 요청의 상황 프롬프트 모델 검증 — 구조화 출력 안정 모델(Gemini 계열+Opus)만. 미허용이면 기본 모델. */
function pickPromptModel(requested?: string): string {
	return requested && IMAGE_PROMPT_MODEL_IDS.has(requested)
		? requested
		: DEFAULT_IMAGE_PROMPT_MODEL_ID;
}

/**
 * 구조화 출력 스키마(generateObject) — NAI V4.5 캐릭터 기능에 맞춰 장면을 분해한다.
 *  - base: 배경·구도·인원수 태그(1girl/2girls/1boy 1girl)·상호작용(source#/target#) 등 전역 캡션.
 *  - characters[]: 화면에 보이는 인물별로 name/appearance/state 분해.
 *    · name: 외형 원장 대조용 안정 식별자(주인공=char, 유저=user, 그 외 in-story 이름/식별자).
 *    · appearance: 고정 외형(머리·눈·체형·고유특징) — 원장에 박아 턴 간 고정.
 *    · state: 가변(현재 복장·노출·표정·포즈) — 매 턴 새로.
 *    인물을 분리하면 NAI 가 인물 간 속성 누출(머리색·옷 bleeding)을 막는다.
 */
const SITUATION_SCHEMA = jsonSchema<{
	base: string;
	characters: { name: string; appearance: string; state: string }[];
}>({
	type: 'object',
	additionalProperties: false,
	properties: {
		base: { type: 'string' },
		characters: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					name: { type: 'string' },
					appearance: { type: 'string' },
					state: { type: 'string' }
				},
				required: ['name', 'appearance', 'state']
			}
		}
	},
	required: ['base', 'characters']
});

const SITUATION_SYSTEM = [
	`You convert the latest moment of a Korean roleplay scene into a structured image-generation prompt for NovelAI Diffusion V4.5 (anime illustration), using its MULTI-CHARACTER feature.`,
	`You are given a [Character] reference sheet for the main roleplay character, an optional [Known characters] roster of people whose fixed appearance was already established earlier in this story, and the [Recent conversation] (the last few turns, oldest to newest, including the user's actions). Depict ONLY the LATEST moment — the final line of the conversation; use the earlier lines purely as context for what is happening right now. Ignore non-visual text (personality, backstory, rules, command/keyword lists) — use it ONLY for fixed physical appearance.`,
	``,
	`Output a JSON object with two keys:`,
	`  "base": string  — Danbooru-style tags for everything that is NOT an individual character's body/clothes: the SUBJECT COUNT tag (e.g. "1girl", "1boy, 1girl", "2girls"), framing/composition (e.g. "upper body", "cowboy shot", "full body", "from above", "pov"), setting/background, lighting and mood, and INTERACTION action tags between characters using the "source#"/"target#"/"mutual#" prefixes (e.g. "source#hug" on the initiator's intent, "target#hug", "mutual#kiss"). Lowercase, comma-separated.`,
	`  "characters": array — one entry per person VISIBLE in the frame, ordered top-to-bottom / left-to-right. Each entry is { "name", "appearance", "state" }:`,
	`    - "name": a STABLE identifier for this person, used to keep their look consistent across images. Use the literal "char" for the main roleplay character ({{char}}), and the literal "user" for the user/{{나}}. For anyone else, if they are the SAME person as someone in [Known characters], reuse that EXACT name; otherwise assign a short identifier (their in-story name if any, else a concise descriptor like "waitress").`,
	`    - "appearance": that person's FIXED physical look as Danbooru tags only — an UNNUMBERED subject word ("girl"/"boy"/"other"), hair color/length/style, eye color, body type, and distinctive PERMANENT features. NEVER put clothing, expression, or pose here. For "char" use the [Character] reference. For a person listed in [Known characters], COPY their recorded appearance verbatim. For a brand-new person, invent a plausible consistent appearance.`,
	`    - "state": that person's CURRENT scene-specific look from the latest moment — clothing or state of undress (e.g. "white blouse, unbuttoned, no bra", "naked, towel"), plus expression and pose. This is the only part that changes turn to turn. Lowercase, comma-separated.`,
	``,
	`Character rules:`,
	`- "appearance" must stay identical for the same person across turns (that is what keeps images consistent); only "state" follows the latest scene.`,
	`- Include the user ("user") as a SEPARATE entry ONLY if they are physically in the frame in this moment (e.g. the two are embracing, the user's body is shown). For typical 1:1 POV shots where only the character is depicted, output just one entry.`,
	`- The subject COUNT tag in "base" must match the number of character entries (1 entry → "1girl" or "1boy"; 2 entries → e.g. "1boy, 1girl").`,
	`- Put per-person body/clothes ONLY in "appearance"/"state", never in "base". Put the count tag ONLY in "base", never in a character entry.`,
	``,
	`General rules:`,
	`- English only. Focus on the single most recent visual beat, not the whole history.`,
	`- Do NOT copy the status window, stat block, or any prompt/instruction text from the input — write your own concise tags.`,
	`- Do NOT include quality boosters, artist names, "masterpiece", resolution tags, "rating:" tags, or negative terms — those are added separately.`,
	`- Keep it concise (combined budget is small): "base" short, each character under ~40 tags.`,
	`- NSFW content is allowed and should be described plainly when present.`,
	`- ABSOLUTE RULE: every person MUST be depicted as an adult (18+). NEVER output any tag or wording depicting minors, children, or age-regressed characters (e.g. loli, shota, child, kid, toddler, "young girl/boy", "little girl/boy"). If the scene implies a minor, depict them as a clear adult instead. This overrides everything else.`
].join('\n');

/** 문자열 정규화(trim). 알 수 없는 값은 빈 문자열. */
function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/**
 * 상황 프롬프트 후처리. NovelAI 는 영어/danbooru 태그만 해석하므로, 모델이 (지시에도 불구하고)
 * 캐릭터 프롬프트의 '상태창'을 통짜로 베껴 넣는 걸 출력단에서 막는다.
 * — 줄·콤마 단위 세그먼트로 쪼개 한글이 들어간 조각은 통째로 제거(잔여 숫자/기호 junk 포함) →
 *   순수 영어 태그/구문만 ', ' 로 재조립. 입력(assistantText)은 그대로라 모델은 상태를 참고는 한다.
 */
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/;
function sanitizeSituation(raw: string): string {
	return raw
		.split(/[\r\n,]+/)
		.map((s) => s.trim())
		.filter((s) => s && !HANGUL_RE.test(s))
		.join(', ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 외형 원장 키 정규화 — LLM 이 준 name 의 표기 흔들림(공백/대소문자)만 흡수한다.
 * 동일인 판정(대명사·호칭 변동)은 LLM 이 [Known characters] 대조로 이미 처리하므로 여기선 가볍게만.
 */
function normalizeKey(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 주인공/유저 예약 슬롯인지 — 이들은 원장에 박지 않는다(주인공은 매 턴 ref 로 안정, 유저는 persona). */
function isReservedName(key: string, charLabel: string, userLabel: string): boolean {
	return (
		key === 'char' ||
		key === 'user' ||
		key === '나' ||
		key === '{{나}}' ||
		key === normalizeKey(charLabel) ||
		key === normalizeKey(userLabel)
	);
}

/** 원장을 LLM 주입용 [Known characters] 블록으로. 비면 빈 문자열. */
function buildKnownBlock(ledger: AppearanceLedger): string {
	const lines = Object.entries(ledger).map(([name, e]) => `- ${name}: ${e.appearance}`);
	return lines.length ? `[Known characters]\n${lines.join('\n')}` : '';
}

interface ImageRequestBody {
	sessionId?: string;
	/** 방금 완료된 assistant 응답 본문(상황 프롬프트 입력 — 그릴 대상). */
	assistantText?: string;
	/** 최근 대화(유저 입력 포함, 시간순). 그릴 순간의 맥락. 마지막 원소가 보통 assistantText 와 동일. */
	recent?: { role?: string; content?: string }[];
	/**
	 * 이 이미지를 만든 assistant 메시지 행 id. 채팅의 assistant 영속(onFinish/waitUntil)은
	 * 비동기라, '빠른 생성 우선'이면 이미지가 먼저 append 돼 seq 가 역전될 수 있다 →
	 * append 직전 이 행이 박힐 때까지 기다려 항상 assistant 다음 seq 를 받게 한다.
	 */
	assistantMsgId?: string;
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

/** generateObject 를 일시적 에러에 한해 백오프 재시도한다(기본 2회 추가 시도). */
async function generateObjectWithRetry(
	opts: Parameters<typeof generateObject>[0],
	retries = 2
): Promise<Awaited<ReturnType<typeof generateObject>>> {
	let lastErr: unknown;
	for (let i = 0; i <= retries; i++) {
		try {
			return await generateObject(opts);
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
	const db = getDB(platform);
	const bucket = getImages(platform);
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
	const assistantMsgId = typeof body?.assistantMsgId === 'string' ? body.assistantMsgId : '';

	// 최근 대화 블록(유저 입력 포함) — 그릴 순간의 맥락. 화자 라벨은 유저=페르소나/이름, 캐릭터=이름.
	const userLabel = locals.user.personaName?.trim() || locals.user.name?.trim() || '나';
	const charLabel = character?.name?.trim() || '캐릭터';
	const recentBlock = (Array.isArray(body?.recent) ? body.recent : [])
		.filter((m): m is { role: string; content: string } =>
			(m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && !!m.content.trim()
		)
		.slice(-MAX_RECENT_MSGS)
		.map((m) => `${m.role === 'user' ? userLabel : charLabel}: ${m.content.trim().slice(0, MAX_RECENT_MSG_CHARS)}`)
		.join('\n');

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
	// 상황 프롬프트 LLM 도 유저 본인 Gateway 키로(BYO). 없으면 거부(예외 없음).
	const apiKey = await getDecryptedKey(db, locals.user.id, 'gateway');
	if (!apiKey) {
		return json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			{ status: 400 }
		);
	}

	// 외형 원장(세션 누적) — 동적 NPC 외형 고정용. 작업 사본으로 변이 후, 변경 시 NovelAI 전에 영속.
	const ledger: AppearanceLedger = { ...(session.appearances ?? {}) };
	let ledgerDirty = false;
	const knownBlock = buildKnownBlock(ledger); // LLM 주입용 [Known characters] 블록

	// 디버그(요청자가 debug 모드일 때만)용 진단값 누적 — 성공·실패 양쪽에서 동봉한다.
	let situation = ''; // base 와 인물 캡션을 ' | ' 로 합친 표시용
	let baseScene = '';
	let charCaptions: string[] = [];
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
					knownCharacters: knownBlock,
					situation,
					baseScene,
					characters: charCaptions,
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
		// 최근 대화(유저 입력 포함)가 있으면 맥락으로 함께 넣되, 그릴 순간은 마지막(=assistantText).
		const sceneBlock = recentBlock
			? `[Recent conversation]\n${recentBlock}`
			: `[Latest scene]\n${assistantText}`;
		// [Character](주인공 ref) + [Known characters](기존 NPC 외형 원장) + 장면. LLM 이 name 으로 원장 대조.
		const promptParts: string[] = [];
		if (characterRef) promptParts.push(`[Character]\n${characterRef}`);
		if (knownBlock) promptParts.push(knownBlock);
		promptParts.push(sceneBlock);
		const userPrompt = promptParts.join('\n\n');
		// 게이트웨이가 일시적 503/500 을 자동 재시도하지 않으므로 직접 백오프 재시도한다.
		const result = await generateObjectWithRetry({
			model: gateway(promptModel),
			schema: SITUATION_SCHEMA,
			system: SITUATION_SYSTEM,
			prompt: userPrompt,
			temperature: 0.7,
			// 상황 프롬프트는 단순 태그 변환이라 thinking 을 끈다(지연·빈응답 감소). 그래도 thinking 을
			// 못 끄는 모델 대비 headroom 은 남겨 둔다(maxOutputTokens 는 상한이라 지연엔 영향 없음).
			maxOutputTokens: 2000 + reasoningHeadroom(promptModel),
			providerOptions: buildProviderOptions(promptModel, { noThinking: true })
		});
		const obj = (result.object ?? {}) as { base?: unknown; characters?: unknown };
		rawSituation = JSON.stringify(obj);
		// base·각 인물 캡션을 필드별로 한글/잡음 제거(모델이 상태창을 베껴 넣어도 영어 태그만 남김).
		baseScene = sanitizeSituation(str(obj.base));

		// 인물별: name 으로 원장 대조 → 기존이면 외형 고정(override), 신규면 핀. 최종 캡션 = 외형 + 상태.
		const turnRef = session.messageCount;
		const rawChars = (Array.isArray(obj.characters) ? obj.characters : []).slice(0, MAX_CHARACTERS);
		charCaptions = [];
		for (const c of rawChars) {
			const entry = c as { name?: unknown; appearance?: unknown; state?: unknown };
			const cleanState = sanitizeSituation(str(entry.state));
			let appearance = sanitizeSituation(str(entry.appearance)).slice(0, MAX_APPEARANCE_CHARS);
			const key = normalizeKey(str(entry.name));
			// 주인공(char)·유저(user)는 원장에 박지 않는다(주인공은 매 턴 ref 로 안정).
			if (key && !isReservedName(key, charLabel, userLabel)) {
				const known = ledger[key];
				if (known) {
					appearance = known.appearance; // 기존 인물: 고정 외형 강제(LLM 드리프트 무시)
					ledger[key] = { appearance: known.appearance, lastSeen: turnRef };
					ledgerDirty = true;
				} else if (appearance) {
					ledger[key] = { appearance, lastSeen: turnRef }; // 첫 등장: 외형 핀
					ledgerDirty = true;
				}
			}
			const caption = [appearance, cleanState].filter(Boolean).join(', ');
			if (caption) charCaptions.push(caption);
		}

		// 원장 상한 초과 시 가장 오래 안 나온 인물부터 제거(LRU evict).
		const names = Object.keys(ledger);
		if (names.length > MAX_LEDGER_ENTRIES) {
			names
				.sort((a, b) => ledger[a].lastSeen - ledger[b].lastSeen)
				.slice(0, names.length - MAX_LEDGER_ENTRIES)
				.forEach((n) => delete ledger[n]);
			ledgerDirty = true;
		}

		// 표시용 합본(디버그 패널·빈값 판정). base 와 인물 캡션을 ' | ' 로 잇는다.
		situation = [baseScene, ...charCaptions].filter(Boolean).join(' | ');
		finishReason = (result.finishReason as string | undefined) ?? null;
		warnings = result.warnings ?? [];
		cost = parseGatewayCost(result.providerMetadata);
		// 상황프롬프트 비용을 유저 일일 카운터에 가산(NovelAI 실패해도 Gemini 비용은 발생).
	} catch (e) {
		console.error('[chat/image] situation prompt error:', e);
		llmError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		notifyServerError({
			context: 'generateObject /api/chat/image',
			error: e,
			extra: { session: sessionId, user: locals.user.id, model: promptModel },
			waitUntil: getWaitUntil(platform)
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

	// base_caption = (NSFW면) rating + 그림체 + base 장면 + 퀄리티 꼬리. 인물 외형은 char_captions 로 분리.
	const positive = buildPositivePrompt(stylePrompt, baseScene, isNsfw);

	// ── 하드 차단 ── 최종 프롬프트에 미성년/아동 코드 용어가 있으면 NovelAI 호출 없이 거부(fail-closed).
	// 한국법(가상 아동성착취물 형사처벌) 대응의 최종 게이트 — LLM 지시·네거티브와 별개의 결정적 방어선.
	// base 와 모든 인물 캡션을 합쳐 검사한다(인물 캡션에 들어간 용어도 잡아야 함).
	if (containsMinorTerms([positive, ...charCaptions].join(', '))) {
		console.warn(`[chat/image] minor-term hard block (user=${locals.user.id}, session=${sessionId})`);
		notifyServerError({
			context: 'minor-term hard block /api/chat/image',
			error: new Error('blocked: minor term in image prompt'),
			extra: { session: sessionId, user: locals.user.id },
			waitUntil: getWaitUntil(platform)
		});
		return json(
			{ error: 'blocked', message: '생성할 수 없는 내용이 포함되어 있어 이미지를 만들지 않았습니다.', debug: makeDebug(positive) },
			{ status: 422 }
		);
	}

	// 외형 원장 변경분 영속 — 다음 턴 일관성. NovelAI 전에 inline 저장(빠른 재요청 레이스 방지).
	if (ledgerDirty) {
		try {
			await updateAppearances(db, sessionId, ledger);
		} catch (e) {
			console.warn('[chat/image] 외형 원장 저장 실패(무시):', String(e));
		}
	}

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
				for await (const b64 of generateImageStream(naiKey, { positive, charCaptions, resolution })) {
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
				const gen = await generateImage(naiKey, { positive, charCaptions, resolution });
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
				// assistant 영속(비동기 onFinish/waitUntil)이 아직이면 이미지가 먼저 append 돼 seq 가
				// 역전된다(새로고침 시 유저→이미지→응답 순서로 뒤바뀜). 특히 '빠른 생성 우선'은 응답 중간
				// (600자)에 발사하므로, 긴 응답이 계속 스트리밍되는 동안 NovelAI(빠르면 ~7s)가 먼저 끝나
				// 이미지가 앞설 수 있다. 그 assistant 행이 박힐 때까지 기다린 뒤 append → 항상 응답 다음 seq.
				// 한도(~30s, 긴 응답 스트리밍 시간 커버)를 넘기면(응답 에러로 영속이 스킵된 경우 등) 그냥 진행.
				if (assistantMsgId) {
					for (let i = 0; i < 120 && !(await messageExists(db, assistantMsgId, sid)); i++) {
						await new Promise((r) => setTimeout(r, 250));
					}
				}
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
