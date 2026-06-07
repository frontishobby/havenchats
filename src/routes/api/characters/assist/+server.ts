import { json, type RequestHandler } from '@sveltejs/kit';
import { generateObject, jsonSchema } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { isAdmin } from '$lib/server/auth';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { notifyServerError } from '$lib/server/notify';
import { buildProviderOptions, reasoningHeadroom } from '$lib/server/chatAssembly';
import { isOverDailyBudget, addDailySpend, DAILY_BUDGET_USD } from '$lib/server/budget';
import { ASSIST_MODEL_IDS, DEFAULT_ASSIST_MODEL_ID } from '$lib/data/models';
import type { Audience } from '$lib/types';

/**
 * 캐릭터 제작 보조(로그인 필수). 제작 화면 우측 패널에서 자연어로 적은 러프한 설정을
 * 받아, LLM 이 우리 캐릭터 포맷(제목·소개·설명·프롬프트·태그·첫 상황)으로 채워 돌려준다.
 * 실제 등록은 사용자가 폼에서 검토·수정 후 진행한다(여기선 폼 채우기 데이터만 생성).
 *
 * 흐름:
 *  1) 로그인 + 일일 비용 상한 게이트(채팅과 같은 카운터 — 보조 생성 비용도 서버 부담).
 *  2) 러프 입력 → LLM → 엄격 JSON(코드펜스 제거 후 파싱) → 필드별 clamp.
 *  3) 게이트웨이 추론 비용을 유저 일일 카운터에 가산.
 */

/** 요청의 모델을 assist 허용목록(Gemini 계열+Opus)으로 검증. 없거나 미허용이면 기본 모델. */
function pickAssistModel(requested?: string): string {
	return requested && ASSIST_MODEL_IDS.has(requested) ? requested : DEFAULT_ASSIST_MODEL_ID;
}

/** generateObject 구조화 출력 스키마(따옴표·개행 escape 를 공급자가 처리 → 수기 JSON 파싱 불필요). */
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

const SYSTEM = [
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

/** 제작 폼의 현재 내용(수정 모드용 — 있으면 보존하며 새 요청만 반영). */
interface CurrentDraft {
	name?: string;
	tagline?: string;
	intro?: string;
	description?: string;
	tags?: string[];
	greetings?: { name?: string; content?: string }[];
	audience?: string;
	nsfw?: boolean;
}

interface AssistBody {
	/** 자연어 러프 설정. */
	rough?: string;
	/** 제작 폼의 현재 NSFW 토글(힌트). */
	nsfw?: boolean;
	/** 생성에 사용할 모델 id(허용목록 검증). 없으면 기본 모델. */
	model?: string;
	/** 제작 폼의 현재 내용(있고 비어있지 않으면 수정 모드). */
	current?: CurrentDraft;
}

/** 현재 폼 내용을 프롬프트에 넣을 텍스트 블록으로 직렬화. 채워진 게 없으면 null(=신규 생성). */
function serializeCurrent(c: CurrentDraft | undefined): string | null {
	if (!c || typeof c !== 'object') return null;
	const name = str(c.name);
	const tagline = str(c.tagline);
	const intro = str(c.intro);
	const description = str(c.description);
	const tags = Array.isArray(c.tags) ? c.tags.map(str).filter(Boolean) : [];
	const greetings = Array.isArray(c.greetings)
		? c.greetings
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

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
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

	// 일일 비용 상한 게이트 — 채팅·이미지와 같은 카운터.
	const kv = platform?.env?.SESSIONS;
	if (!isAdmin(locals.user.email) && (await isOverDailyBudget(kv, locals.user.id, Date.now()))) {
		return json({ error: 'daily_limit', limit: DAILY_BUDGET_USD }, { status: 429 });
	}

	const body = (await request.json().catch(() => null)) as AssistBody | null;
	const rough = str(body?.rough).slice(0, ROUGH_MAX);
	if (!rough) return json({ error: 'empty', message: '만들고 싶은 캐릭터를 적어 주세요.' }, { status: 400 });
	const nsfwHint = body?.nsfw === true;
	const model = pickAssistModel(body?.model);
	const currentBlock = serializeCurrent(body?.current);

	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });
	const apiKey = await getDecryptedKey(db, locals.user.id, 'gateway');
	if (!apiKey) {
		return json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			{ status: 400 }
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
			system: SYSTEM,
			prompt: userPrompt,
			temperature: 0.9,
			// 한 덩이를 끝까지 받아야 하므로 넉넉히. reasoning 모델은 추론이 예산을 먹으니 headroom 추가.
			maxOutputTokens: 12000 + reasoningHeadroom(model),
			providerOptions: buildProviderOptions(model)
		});
		parsed = result.object as Record<string, unknown>;
		const cost = parseGatewayCost(result.providerMetadata);
		platform?.context?.waitUntil?.(addDailySpend(kv, locals.user.id, cost, Date.now()));
		console.log(`[characters/assist] model=${model} finishReason=${result.finishReason}`);
	} catch (e) {
		console.error('[characters/assist] generateObject error:', e);
		notifyServerError({
			context: 'generateObject /api/characters/assist',
			error: e,
			extra: { user: locals.user.id, model },
			waitUntil: platform?.context?.waitUntil?.bind(platform.context)
		});
		const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		return json(
			{ error: 'llm', message: '캐릭터 생성에 실패했어요. 잠시 후 다시 시도해 주세요.', detail },
			{ status: 502 }
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
			extra: { user: locals.user.id, model },
			waitUntil: platform?.context?.waitUntil?.bind(platform.context)
		});
		return json(
			{
				error: 'incomplete',
				message: '생성 결과가 불완전해요. 입력을 조금 더 구체적으로 적고 다시 시도해 주세요.',
				detail: diag
			},
			{ status: 502 }
		);
	}

	return json({
		ok: true,
		character: { name, tagline, intro, description, tags, greetings, audience, nsfw }
	});
};
