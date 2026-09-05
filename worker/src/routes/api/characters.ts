import { Hono } from 'hono';
import { generateObject, generateText, jsonSchema } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import type { AppEnv } from '../../context';
import { requireUser } from '../../context';
import { HttpError } from '$lib/server/httpError';
import { getImages } from '$lib/server/images';
import { getWaitUntil } from '$lib/server/waitUntil';
import {
	createCharacter,
	deleteCharacter,
	getCharacterById,
	getCharacterDefaultVars,
	getCharacterLorebook,
	getCharacterOwnership,
	getCharacterPrompt,
	updateCharacter,
	updateImageSet
} from '$lib/server/db/characters';
import { styleExists } from '$lib/server/db/styles';
import { ALLOWED_IMAGE, parseCharacterForm } from '$lib/server/characterForm';
import { commitSceneImages, deleteAllSceneImages, deleteKeys } from '$lib/server/imageStore';
import { isAdmin, requireAdmin } from '$lib/server/auth';
import { findCharacter } from '$lib/server/characters';
import { canSeeNsfw } from '$lib/nsfw';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { notifyServerError } from '$lib/server/notify';
import { buildProviderOptions, reasoningHeadroom } from '$lib/server/chatAssembly';
import { ASSIST_MODEL_IDS, DEFAULT_ASSIST_MODEL_ID, MODEL_IDS } from '$lib/data/models';
import {
	buildPositivePrompt,
	generateImage,
	generateImageStream,
	upscaleImage,
	type ResolutionKey
} from '$lib/server/novelai';
import { pickNaiModel } from '$lib/naiModels';
import type { Audience } from '$lib/types';
import type {
	AssistCurrentDraft,
	AssistRequest,
	CharacterEditData,
	CharacterAssetsData,
	RedirectResponse
} from '$lib/api/characters';

export const charactersRouter = new Hono<AppEnv>();

/** 유저 캐릭터 id 는 uuid. 그 외 형식은 편집 대상이 아님. */
function isUserCharacterId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ── POST /api/characters — 캐릭터 생성 ─────────────────────────
charactersRouter.post('/', async (c) => {
	// 캐릭터 만들기는 로그인 필수
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const db = c.env.DB;
	const bucket = getImages();
	if (!db || !bucket) {
		return c.json({ error: 'storage unavailable' }, 500);
	}

	const form = await c.req.formData();
	const parsed = parseCharacterForm(form);
	if (!parsed.ok) {
		return c.json({ error: parsed.error }, 400);
	}
	const data = parsed.data;

	// 생성 시 썸네일은 필수.
	if (!data.image) {
		return c.json({ error: '썸네일 이미지를 추가해 주세요.' }, 400);
	}

	// ── 저장 ──
	const id = crypto.randomUUID();
	const ext = ALLOWED_IMAGE[data.image.type];
	const key = `char/${id}.${ext}`;

	await bucket.put(key, await data.image.arrayBuffer(), {
		httpMetadata: { contentType: data.image.type }
	});

	// 장면 이미지(grid|named) 업로드. 생성이므로 기존 세트 없음. 실패 시 썸네일 정리.
	const committed = await commitSceneImages(form, bucket, id, null);
	if (!committed.ok) {
		await bucket.delete(key).catch(() => {});
		return c.json({ error: committed.error }, 400);
	}
	const { imageSet, uploadedKeys } = committed.result;

	// 추천 그림체는 실제 존재하는 것만 저장(삭제·위조 방지).
	const recommendedStyleId =
		data.recommendedStyleId && (await styleExists(db, data.recommendedStyleId))
			? data.recommendedStyleId
			: null;

	try {
		await createCharacter(db, {
			id,
			creatorId: user.id,
			name: data.name,
			tagline: data.tagline,
			intro: data.intro,
			description: data.description,
			thumbnailKey: key,
			audience: data.audience,
			contentRating: data.contentRating,
			visibility: data.visibility,
			tags: data.tags,
			greetings: data.greetings,
			imageSet,
			lorebook: data.lorebook,
			scriptData: null,
			displayScripts: null,
			recommendedStyleId
		});
	} catch (e) {
		// DB 실패 시 업로드한 이미지는 모두 정리 (고아 오브젝트 방지)
		await bucket.delete(key).catch(() => {});
		await deleteKeys(bucket, uploadedKeys);
		console.error('[create] character insert failed:', e);
		return c.json({ error: '캐릭터 저장에 실패했어요. 잠시 후 다시 시도해 주세요.' }, 500);
	}

	return c.json({ id });
});

// ── POST /api/characters/assist — 캐릭터 제작 보조 ─────────────
const ASSIST_SCHEMA = jsonSchema<{
	name: string;
	tagline: string;
	intro: string;
	description: string;
	tags: string[];
	greetings: { name: string; content: string }[];
	nsfw: boolean;
	audience: Audience;
}>({
	type: 'object',
	additionalProperties: false,
	properties: {
		name: { type: 'string' },
		tagline: { type: 'string' },
		intro: { type: 'string' },
		description: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
		greetings: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: { name: { type: 'string' }, content: { type: 'string' } },
				required: ['name', 'content']
			}
		},
		nsfw: { type: 'boolean' },
		audience: { type: 'string', enum: ['all', 'male', 'female'] }
	},
	required: ['name', 'tagline', 'intro', 'description', 'tags', 'greetings', 'nsfw', 'audience']
});

const ROUGH_MAX = 4000;

// 폼/검증과 동일한 상한(자/토큰은 폼이 최종 검증하므로 여기선 넉넉히 자른다).
const NAME_MAX = 30;
const TAGLINE_MAX = 100;
const INTRO_MAX = 3000;
const DESC_CHAR_CEIL = 32000;
const GREETING_MAX = 4000;
const GREETING_NAME_MAX = 30;
const GREETINGS_MAX = 5;
const TAGS_MAX = 5;

const ASSIST_SYSTEM = [
	`너는 한국어 캐릭터 AI 채팅 서비스 "Haven"의 캐릭터 제작 보조다. 사용자가 자연어로 적은 러프한 아이디어를 받아, 이 서비스의 캐릭터 포맷에 맞게 완성도 높은 캐릭터 설정을 만들어 낸다.`,
	`이 서비스는 **소설 모드**(말풍선이 아닌 산문) 1:1 롤플레이다. 사용자가 캐릭터와 대화한다.`,
	``,
	`아래 키를 가진 **JSON 객체 하나만** 출력한다. 코드펜스(\`\`\`)·설명·머리말 없이 순수 JSON 만.`,
	`{`,
	`  "name": string,        // 캐릭터 이름/제목. ${NAME_MAX}자 이내.`,
	`  "tagline": string,     // 카드에 보일 한 줄 소개. ${TAGLINE_MAX}자 이내. 매력적으로.`,
	`  "intro": string,       // 상세 화면에 보이는 소개글(세계관·관계·분위기). 표시 전용이라 프롬프트엔 안 들어감. 2~5문장.`,
	`  "description": string, // ★핵심★ 시스템 프롬프트 본문. 아래 [프롬프트 작성 규칙] 을 따른다.`,
	`  "tags": string[],      // 한국어 해시태그 ${TAGS_MAX}개 이내. '#' 없이 단어만.`,
	`  "greetings": [ { "name": string, "content": string } ],  // 첫 상황(오프닝) 1~${GREETINGS_MAX}개. name=상황 라벨, content=캐릭터의 첫 메시지 본문.`,
	`  "nsfw": boolean,       // 성인(NSFW) 콘텐츠 캐릭터면 true.`,
	`  "audience": "all" | "male" | "female"  // 타깃 독자층.`,
	`}`,
	``,
	`[프롬프트 작성 규칙] (description 필드)`,
	`- description 이 곧 시스템 프롬프트가 된다. 역할 선언(캐릭터 연기)으로 시작해, 성격·말투·외형·세계관·관계·행동 양식을 구체적으로 적는다.`,
	`- 캐릭터 본인은 {{char}}, 대화 상대(사용자)는 {{나}} 로 지칭한다. 이름은 대화 중 자동 치환된다.`,
	`- 출력 형식 지침을 반드시 포함한다: "소설 형식(산문)으로 서술한다. 대사는 '이름 | \\"대사\\"' 형식으로 쓴다. 행동·서술은 그대로 산문으로 쓴다." 같은 식.`,
	`- 상태창·스탯이 어울리는 캐릭터면, 백틱3개+{제목} … 백틱3개 형식의 상태창 블록을 출력 형식에 넣어도 된다(선택).`,
	`- 금지/필수 규칙은 따로 묶어 명확히. 상대(사용자) 정보와 안전 가드레일은 서버가 자동으로 덧붙이니 적지 않는다.`,
	`- 모순되는 지시는 피하고, 핵심 설정을 짧고 명확하게.`,
	``,
	`[첫 상황(greetings) 규칙]`,
	`- 최소 1개. 채팅을 시작할 때 캐릭터가 건네는 첫 장면·대사다. description 의 출력 형식과 같은 톤(소설체, '이름 | "대사"')으로 쓴다.`,
	`- 사용자({{나}})를 장면 안으로 끌어들이는 몰입감 있는 도입으로. 2~6문장 정도.`,
	`- name 은 그 상황을 고르는 짧은 라벨(예: "첫 만남", "비 오는 밤").`,
	``,
	`[기존 내용 수정 모드]`,
	`- [현재 폼 내용] 이 함께 주어지면, 그것을 백지에서 갈아엎지 말고 **기존 내용을 최대한 보존하면서 사용자의 새 요청만 반영해 수정·보완**한다.`,
	`- 새 요청과 무관한 필드·문장은 그대로 유지한다. 새 요청이 가리키는 부분만 자연스럽게 고치거나 덧붙인다.`,
	`- 단, 사용자가 명시적으로 "다시 써", "새로 만들어", "갈아엎어" 같은 전면 재작성을 요청하면 새로 만들어도 된다.`,
	`- 출력은 항상 **모든 필드를 채운 완전한 JSON** 이다(수정 안 한 필드도 기존 값을 그대로 다시 담는다).`,
	``,
	`[중요]`,
	`- 모든 텍스트는 사용자가 입력한 언어(보통 한국어)로 작성한다.`,
	`- 모든 등장인물은 성인이다. 미성년자 묘사는 절대 만들지 않는다.`,
	`- 사용자의 러프 입력이 짧아도, 빈 칸 없이 매력적이고 일관된 캐릭터로 풍부하게 살을 붙인다.`
].join('\n');

/** 요청의 모델을 assist 허용목록(Gemini 계열)으로 검증. 없거나 미허용이면 기본 모델. */
function pickAssistModel(requested?: string): string {
	return requested && ASSIST_MODEL_IDS.has(requested) ? requested : DEFAULT_ASSIST_MODEL_ID;
}

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/** 현재 폼 내용을 프롬프트에 넣을 텍스트 블록으로 직렬화. 채워진 게 없으면 null(=신규 생성). */
function serializeCurrent(cur: AssistCurrentDraft | undefined): string | null {
	if (!cur || typeof cur !== 'object') return null;
	const name = str(cur.name);
	const tagline = str(cur.tagline);
	const intro = str(cur.intro);
	const description = str(cur.description);
	const tags = Array.isArray(cur.tags) ? cur.tags.map(str).filter(Boolean) : [];
	const greetings = Array.isArray(cur.greetings)
		? cur.greetings
				.map((g) => ({ name: str(g?.name), content: str(g?.content) }))
				.filter((g) => g.content || g.name)
		: [];

	// 의미 있는 내용이 하나도 없으면 신규 생성으로 처리.
	if (!name && !tagline && !intro && !description && tags.length === 0 && greetings.length === 0) {
		return null;
	}

	const lines: string[] = [];
	if (name) lines.push(`name: ${name}`);
	if (tagline) lines.push(`tagline: ${tagline}`);
	if (intro) lines.push(`intro: ${intro}`);
	if (description) lines.push(`description:\n${description}`);
	if (tags.length) lines.push(`tags: ${tags.join(', ')}`);
	if (greetings.length) {
		lines.push(
			`greetings:\n${greetings.map((g, i) => `  [${i + 1}] ${g.name || '(이름없음)'}: ${g.content}`).join('\n')}`
		);
	}
	return lines.join('\n');
}

charactersRouter.post('/assist', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'unauthorized' }, 401);

	const body = (await c.req.json().catch(() => null)) as AssistRequest | null;
	const rough = str(body?.rough).slice(0, ROUGH_MAX);
	if (!rough) return c.json({ error: 'empty', message: '만들고 싶은 캐릭터를 적어 주세요.' }, 400);
	const nsfwHint = body?.nsfw === true;
	const model = pickAssistModel(body?.model);
	const currentBlock = serializeCurrent(body?.current);

	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const apiKey = await getDecryptedKey(db, user.id, 'gateway');
	if (!apiKey) {
		return c.json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			400
		);
	}

	const userPrompt = [
		...(currentBlock
			? [
					`[현재 폼 내용] — 이미 작성된 내용이다. 아래 요청에 맞춰 이걸 보존하며 수정·보완하라(전면 재작성 요청이 아니면 무관한 부분은 그대로 유지).`,
					currentBlock,
					``,
					`[요청 / 수정할 점]`
				]
			: [`[만들고 싶은 캐릭터 (러프한 설정)]`]),
		rough,
		``,
		nsfwHint
			? `[참고] 제작자가 NSFW(성인) 캐릭터로 설정했다. 성인 콘텐츠를 전제로 작성하되 모든 등장인물은 성인이다. nsfw 는 true 로.`
			: `[참고] 제작자는 일반(SFW) 캐릭터로 두었다. 입력 내용이 명백히 성인용이 아니면 nsfw 는 false 로.`
	].join('\n');

	// 구조화 출력(generateObject) — 공급자가 따옴표·개행 escape 를 보장해 수기 JSON 파싱 깨짐을 없앤다.
	let parsed: Record<string, unknown>;
	try {
		const gateway = createGateway({ apiKey });
		const result = await generateObject({
			model: gateway(model),
			schema: ASSIST_SCHEMA,
			system: ASSIST_SYSTEM,
			prompt: userPrompt,
			temperature: 0.9,
			// 한 덩이를 끝까지 받아야 하므로 넉넉히. reasoning 모델은 추론이 예산을 먹으니 headroom 추가.
			maxOutputTokens: 12000 + reasoningHeadroom(model),
			providerOptions: buildProviderOptions(model)
		});
		parsed = result.object as Record<string, unknown>;
		console.log(`[characters/assist] model=${model} finishReason=${result.finishReason}`);
	} catch (e) {
		console.error('[characters/assist] generateObject error:', e);
		notifyServerError({
			context: 'generateObject /api/characters/assist',
			error: e,
			extra: { user: user.id, model },
			waitUntil: getWaitUntil()
		});
		const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		return c.json(
			{ error: 'llm', message: '캐릭터 생성에 실패했어요. 잠시 후 다시 시도해 주세요.', detail },
			502
		);
	}

	// ── 필드별 정규화·clamp (폼이 최종 검증하므로 여기선 형태만 맞춘다) ──
	const name = str(parsed.name).slice(0, NAME_MAX);
	const tagline = str(parsed.tagline).slice(0, TAGLINE_MAX);
	const intro = str(parsed.intro).slice(0, INTRO_MAX);
	const description = str(parsed.description).slice(0, DESC_CHAR_CEIL);

	const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
		.map((t) => str(t).replace(/^#/, ''))
		.filter(Boolean)
		.slice(0, TAGS_MAX);

	const greetingsRaw = Array.isArray(parsed.greetings) ? parsed.greetings : [];
	const greetings = greetingsRaw
		.map((g) => {
			const o = (g ?? {}) as { name?: unknown; content?: unknown };
			return {
				name: str(o.name).slice(0, GREETING_NAME_MAX),
				content: str(o.content).slice(0, GREETING_MAX)
			};
		})
		.filter((g) => g.content)
		.slice(0, GREETINGS_MAX);

	const audRaw = str(parsed.audience);
	const audience: Audience = audRaw === 'male' || audRaw === 'female' ? audRaw : 'all';
	const nsfw = parsed.nsfw === true;

	if (!name || !description) {
		const diag = `keys=${Object.keys(parsed).join(',')} nameLen=${name.length} descLen=${description.length}`;
		console.warn(`[characters/assist] 불완전 결과 model=${model} ${diag}`);
		notifyServerError({
			context: 'incomplete /api/characters/assist',
			error: new Error(`불완전 결과 — ${diag}\n${JSON.stringify(parsed).slice(0, 600)}`),
			extra: { user: user.id, model },
			waitUntil: getWaitUntil()
		});
		return c.json(
			{
				error: 'incomplete',
				message: '생성 결과가 불완전해요. 입력을 조금 더 구체적으로 적고 다시 시도해 주세요.',
				detail: diag
			},
			502
		);
	}

	return c.json({
		ok: true,
		character: { name, tagline, intro, description, tags, greetings, audience, nsfw }
	});
});

// ── POST /api/characters/thumbnail — 썸네일 생성(스트리밍) ─────
const THUMB_RESOLUTION: ResolutionKey = '832x1216';
const DEFAULT_PROMPT_MODEL = 'google/gemini-3.8-flash';
const MAX_DESC_CHARS = 6000;
const MAX_STYLE_CHARS = 1500;
const MAX_SITU_CHARS = 1000;
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/;

/** 요청 모델 허용목록 검증. 없거나 미허용이면 기본(flash). */
function pickPromptModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_PROMPT_MODEL;
}

const SITUATION_SYSTEM = [
	`You convert a Korean character setup sheet into an image-generation prompt for a CHARACTER THUMBNAIL/PORTRAIT (NovelAI Diffusion V4.5/V5, anime illustration).`,
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

interface ThumbBody {
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
	/** NovelAI 생성 모델 id(고른 그림체에 박힌 값, 허용목록 검증). 없으면 기본. */
	naiModel?: string;
}

/** Uint8Array → base64(폴백 최종 프레임 전송용). */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

charactersRouter.post('/thumbnail', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'unauthorized' }, 401);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json().catch(() => null)) as ThumbBody | null;
	const description = (body?.description ?? '').trim().slice(0, MAX_DESC_CHARS);
	const style = (body?.style ?? '').slice(0, MAX_STYLE_CHARS);
	const givenSituation = (body?.situation ?? '').trim().slice(0, MAX_SITU_CHARS);
	const regen = body?.regenSituation === true;
	const isNsfw = body?.nsfw === true;
	const model = pickPromptModel(body?.model);
	const naiModel = pickNaiModel(body?.naiModel);

	// NovelAI 키 — 없으면 안내(클라가 등록 유도).
	const naiKey = await getDecryptedKey(db, user.id, 'novelai');
	if (!naiKey) {
		return c.json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			400
		);
	}

	// ── 1) 상황 프롬프트 결정: 주어졌고 regen 아니면 그대로, 아니면 LLM 생성 ──
	let situation = givenSituation;
	const needLlm = !situation || regen;
	if (needLlm) {
		const apiKey = await getDecryptedKey(db, user.id, 'gateway');
		if (!apiKey) {
			return c.json(
				{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
				400
			);
		}
		if (!description) {
			return c.json(
				{ error: 'no_desc', message: '프롬프트(설정)를 먼저 작성하거나 상황을 직접 입력해 주세요.' },
				400
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
		} catch (e) {
			console.error('[characters/thumbnail] situation prompt error:', e);
			notifyServerError({
				context: 'generateText /api/characters/thumbnail',
				error: e,
				extra: { user: user.id, model },
				waitUntil: getWaitUntil()
			});
			return c.json(
				{ error: 'situation', message: '상황 프롬프트 생성에 실패했어요. 다시 시도해 주세요.' },
				502
			);
		}
		if (!situation) {
			return c.json(
				{
					error: 'situation',
					message: '상황 프롬프트가 비어 있어 생성하지 않았어요. 설정을 더 구체적으로 적어 주세요.'
				},
				502
			);
		}
	}

	const positive = buildPositivePrompt(style, situation, isNsfw, naiModel);

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
					resolution: THUMB_RESOLUTION,
					model: naiModel
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
			const gen = await generateImage(naiKey, { positive, resolution: THUMB_RESOLUTION, model: naiModel });
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
});

// ── POST /api/characters/thumbnail/upscale — 썸네일 2배 업스케일 ─
/** 입력 한도 — 폭주 방지. 썸네일은 보통 832×1216(~1MP). */
const MAX_PIXELS = 3_000_000;
const MAX_DIM = 4096;

interface UpscaleBody {
	/** 원본 이미지 base64(data URL 접두 없이). */
	image?: string;
	/** 원본 폭/높이(px) — NAI 업스케일 요청에 필요. */
	width?: number;
	height?: number;
}

charactersRouter.post('/thumbnail/upscale', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'unauthorized' }, 401);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json().catch(() => null)) as UpscaleBody | null;
	const image = typeof body?.image === 'string' ? body.image.trim() : '';
	const width = Number(body?.width);
	const height = Number(body?.height);
	if (!image) return c.json({ error: 'empty', message: '업스케일할 이미지가 없습니다.' }, 400);
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_DIM ||
		height > MAX_DIM ||
		width * height > MAX_PIXELS
	) {
		return c.json({ error: 'bad_size', message: '이미지 크기가 올바르지 않습니다.' }, 400);
	}

	// NovelAI 키 — 없으면 안내(클라가 등록 유도).
	const naiKey = await getDecryptedKey(db, user.id, 'novelai');
	if (!naiKey) {
		return c.json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			400
		);
	}

	const result = await upscaleImage(naiKey, {
		imageBase64: image,
		width: Math.round(width),
		height: Math.round(height),
		scale: 2
	});
	if (!result.ok) {
		return c.json(
			{ error: 'upscale', message: result.message },
			(result.status || 502) as never
		);
	}

	// 업스케일 이미지 바이트를 그대로 반환(클라가 webp 변환).
	return new Response(result.image.bytes as BlobPart, {
		headers: { 'content-type': result.image.contentType, 'cache-control': 'no-store' }
	});
});

// ── PUT /api/characters/:id — 캐릭터 수정 ──────────────────────
charactersRouter.put('/:id', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const db = c.env.DB;
	const bucket = getImages();
	if (!db || !bucket) {
		return c.json({ error: 'storage unavailable' }, 500);
	}

	const id = c.req.param('id');
	if (!isUserCharacterId(id)) {
		return c.json({ error: '수정할 수 없는 캐릭터예요.' }, 400);
	}

	const owner = await getCharacterOwnership(db, id);
	if (!owner) {
		return c.json({ error: 'not found' }, 404);
	}
	if (owner.creatorId !== user.id) {
		return c.json({ error: 'forbidden' }, 403);
	}

	// 기존 캐릭터(장면 세트 diff + charx import 여부 확인).
	const existing = await getCharacterById(db, id);
	// charx import 캐릭터는 수정 불가(프롬프트 숨김·영구 비공개). 단, 관리자는 프롬프트 편집 허용.
	if (existing?.imported && !isAdmin(user.email)) {
		return c.json({ error: '가져온 캐릭터는 수정할 수 없어요.' }, 403);
	}

	// imported 캐릭터의 기본 변수(scriptData)는 폼에서 다루지 않으므로 관리자 편집 시 기존 값을 보존.
	const existingVars = existing?.imported ? await getCharacterDefaultVars(db, id) : null;

	const form = await c.req.formData();
	const parsed = parseCharacterForm(form);
	if (!parsed.ok) {
		return c.json({ error: parsed.error }, 400);
	}
	const data = parsed.data;

	const oldSet = existing?.imageSet ?? null;

	// 새 이미지가 있으면 교체, 없으면 기존 썸네일 유지.
	let newKey: string | undefined;
	if (data.image) {
		const ext = ALLOWED_IMAGE[data.image.type];
		newKey = `char/${id}.${ext}`;
		await bucket.put(newKey, await data.image.arrayBuffer(), {
			httpMetadata: { contentType: data.image.type }
		});
	}

	// 장면 이미지(grid|named) 업로드/keep. 실패 시 방금 올린 썸네일 정리.
	const committed = await commitSceneImages(form, bucket, id, oldSet);
	if (!committed.ok) {
		if (newKey) await bucket.delete(newKey).catch(() => {});
		return c.json({ error: committed.error }, 400);
	}
	const { imageSet, uploadedKeys, staleKeys } = committed.result;

	try {
		await updateCharacter(db, id, {
			name: data.name,
			tagline: data.tagline,
			intro: data.intro,
			description: data.description,
			audience: data.audience,
			contentRating: data.contentRating,
			visibility: data.visibility,
			tags: data.tags,
			greetings: data.greetings,
			imageSet,
			lorebook: data.lorebook,
			// 폼이 scriptData 를 실어 보냈으면(관리자 import 편집) 그 값을 쓰고,
			// 아니면 기존 기본 변수를 보존(폼에서 다루지 않는 일반 수정).
			scriptData: form.has('scriptData')
				? data.scriptData
				: existingVars
					? { defaultVariables: existingVars }
					: null,
			recommendedStyleId:
				data.recommendedStyleId && (await styleExists(db, data.recommendedStyleId))
					? data.recommendedStyleId
					: null,
			thumbnailKey: newKey
		});
	} catch (e) {
		// DB 실패 시 새로 올린 이미지(썸네일·장면)는 정리.
		if (newKey) await bucket.delete(newKey).catch(() => {});
		await deleteKeys(bucket, uploadedKeys);
		console.error('[update] character update failed:', e);
		return c.json({ error: '캐릭터 저장에 실패했어요. 잠시 후 다시 시도해 주세요.' }, 500);
	}

	// 확장자가 바뀌어 키가 달라진 경우 옛 이미지 정리(같은 키면 덮어쓰여 정리 불필요).
	if (newKey && owner.thumbnailKey && owner.thumbnailKey !== newKey) {
		await bucket.delete(owner.thumbnailKey).catch(() => {});
	}
	// DB 성공 후 더 이상 참조되지 않는 옛 장면 이미지 정리.
	await deleteKeys(bucket, staleKeys);

	return c.json({ id });
});

// ── DELETE /api/characters/:id — 캐릭터 삭제 ───────────────────
charactersRouter.delete('/:id', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const db = c.env.DB;
	const bucket = getImages();
	if (!db) {
		return c.json({ error: 'storage unavailable' }, 500);
	}

	const id = c.req.param('id');
	const owner = await getCharacterOwnership(db, id);
	if (!owner) {
		return c.json({ error: 'not found' }, 404);
	}
	if (owner.creatorId !== user.id) {
		return c.json({ error: 'forbidden' }, 403);
	}

	await deleteCharacter(db, id);
	if (owner.thumbnailKey) await bucket?.delete(owner.thumbnailKey).catch(() => {});
	// 장면 이미지(charimg/<id>/*) 전부 정리.
	if (bucket) await deleteAllSceneImages(bucket, id);

	return c.json({ ok: true });
});

// ── POST /api/characters/:id/promote — charx 로컬→클라우드 전환 ─
/**
 * 로컬(IndexedDB) charx 캐릭터를 클라우드로 '기기간 공유' 전환.
 * 클라가 먼저 /api/import/charx/<id>/assets 로 로컬 이미지를 R2 에 모두 올린 뒤 호출한다.
 * 서버는 ① 소유자 확인 ② R2 에 모든 장면 이미지가 실제로 있는지 검증 ③ image_set 의 storage
 * 플래그를 떼어(클라우드) 일반 캐릭터처럼 동작하게 한다. 본인만.
 */
charactersRouter.post('/:id/promote', async (c) => {
	const user = c.get('user');
	if (!user) return c.json({ error: 'unauthorized' }, 401);
	requireAdmin(user.email); // imported(charx) 캐릭터 전용 기능 → 관리자 전용

	const db = c.env.DB;
	const bucket = getImages();
	if (!db || !bucket) return c.json({ error: 'storage unavailable' }, 500);

	const cid = c.req.param('id');
	const own = await getCharacterOwnership(db, cid);
	if (!own) return c.json({ error: 'not found' }, 404);
	if (own.creatorId !== user.id) return c.json({ error: 'forbidden' }, 403);

	const character = await getCharacterById(db, cid);
	const set = character?.imageSet;
	if (!set || set.kind !== 'named' || set.storage !== 'local') {
		return c.json({ error: '전환할 수 없는 캐릭터예요.' }, 400);
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
		return c.json(
			{ error: '아직 업로드되지 않은 이미지가 있어요. 다시 시도해 주세요.', missing: missing.length },
			409
		);
	}

	// storage 플래그 제거 → 클라우드(일반) 캐릭터로 전환.
	await updateImageSet(db, cid, { kind: 'named', images: set.images });

	return c.json({ ok: true });
});

// ── GET /api/characters/:id/edit-data — 캐릭터 수정 폼 로더 ────
// (원래 /characters/[id]/edit/+page.server.ts load. SPA 가 fetch 하는 GET 으로 전환.)
charactersRouter.get('/:id/edit-data', async (c) => {
	const user = c.get('user');
	// 비로그인 → SvelteKit redirect(302,'/') 였음. SPA 가 처리하도록 redirect 지시 반환.
	if (!user) {
		return c.json({ redirect: '/' } satisfies RedirectResponse, 200);
	}
	const db = c.env.DB;
	if (!db) throw new HttpError(500, '저장소를 사용할 수 없어요.');

	const id = c.req.param('id');
	const owner = await getCharacterOwnership(db, id);
	if (!owner) throw new HttpError(404, '캐릭터를 찾을 수 없어요.');
	if (owner.creatorId !== user.id) throw new HttpError(403, '내가 만든 캐릭터만 수정할 수 있어요.');

	const character = await getCharacterById(db, id);
	if (!character) throw new HttpError(404, '캐릭터를 찾을 수 없어요.');

	const admin = isAdmin(user.email);

	// charx import 캐릭터는 수정 불가(프롬프트 숨김·영구 비공개). 단, 관리자는 프롬프트 편집 허용.
	if (character.imported && !admin) {
		// 원래 redirect(302, `/user/${user.id}`). SPA 가 처리하도록 redirect 지시 반환.
		return c.json({ redirect: `/user/${user.id}` } satisfies RedirectResponse, 200);
	}

	// 관리자가 imported 캐릭터를 편집할 땐, getCharacterById 가 가린 원본 프롬프트/로어북/기본 변수를 폼에 복원.
	const adminImported = character.imported && admin;
	let defaultVariables: Record<string, string> | null = null;
	if (adminImported) {
		const [prompt, lorebook, vars] = await Promise.all([
			getCharacterPrompt(db, id),
			getCharacterLorebook(db, id),
			getCharacterDefaultVars(db, id)
		]);
		character.description = prompt ?? '';
		character.lorebook = lorebook;
		defaultVariables = vars;
	}

	// allowScriptVars: 관리자가 import 캐릭터를 편집할 때만 스크립트 변수 편집 노출.
	return c.json({
		character,
		ownerId: user.id,
		allowScriptVars: adminImported,
		defaultVariables
	} satisfies CharacterEditData);
});

// ── GET /api/characters/:id/assets-data — 캐릭터 에셋 미리보기 로더 ─
// (원래 /characters/[id]/assets/+page.server.ts load. SPA 가 fetch 하는 GET 으로 전환.)
/**
 * 캐릭터 에셋(장면 이미지 카탈로그) 미리보기.
 * 접근 규칙은 채팅 진입과 동일: 비공개=제작자만, NSFW=로그인 필수.
 */
charactersRouter.get('/:id/assets-data', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');

	const db = c.env.DB;
	const character = await findCharacter(db, id);
	if (!character) {
		throw new HttpError(404, '캐릭터를 찾을 수 없어요.');
	}

	// 비공개 캐릭터는 제작자 본인만 접근 가능. (관리자는 공개/비공개 무관 접근 — 어드민 미리보기용)
	if (character.visibility === 'private' && !isAdmin(user?.email)) {
		const owner = db ? await getCharacterOwnership(db, id) : null;
		if (owner && owner.creatorId !== user?.id) {
			throw new HttpError(404, '캐릭터를 찾을 수 없어요.');
		}
	}

	// NSFW 캐릭터는 파라과이(PY) 유저만. 단 제작자 본인·관리자는 미리보기 접근 허용.
	if (
		character.contentRating === 'nsfw' &&
		!canSeeNsfw(user) &&
		character.creator.id !== user?.id &&
		!isAdmin(user?.email)
	) {
		// 원래 redirect(302, '/'). SPA 가 처리하도록 redirect 지시 반환.
		return c.json({ redirect: '/' } satisfies RedirectResponse, 200);
	}

	return c.json({ character } satisfies CharacterAssetsData);
});
