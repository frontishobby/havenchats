/**
 * 채팅 한 턴의 프롬프트 조립 — 순수(부수효과 없는) 로직 단일 소스.
 *
 * `/api/chat`(실제 스트리밍), `/api/chat/inspect`(디버그 드라이런)가 **같은** 조립을
 * 쓰도록 여기 모아둔다. DB 입출력·스트리밍·요약은 호출부(엔드포인트)가 담당하고,
 * 이 모듈은 "주어진 세션 상태 → system/messages/토큰예산" 변환만 한다(테스트·재현 용이).
 *
 * 주의: assembleTurn 은 ctx.vars 를 CBS 평가로 제자리 변이(setvar/addvar)한다 —
 * 영속이 필요 없는 호출부(inspect)는 throwaway ctx 를 넘겨 폐기하면 된다.
 */

import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { Character, ChatSession, StoredMessage } from '$lib/types';
import { evalCBS, type CbsContext } from '$lib/cbs';
import { buildLoreBlock } from '$lib/lorebook';
import { buildImageCatalog } from '$lib/imageCodes';
import { fillCharName } from '$lib/placeholders';
import { estimateTokens } from '$lib/server/db/chats';
import { MODEL_IDS, DEFAULT_MODEL_ID, getContextLimit, isReasoningModel } from '$lib/data/models';
import type { ChatDebugSnapshot } from '$lib/chatDebug';

export type { ChatDebugSnapshot } from '$lib/chatDebug';

/** live window 토큰 예산 — 이 이상이면 요약 트리거. */
export const WINDOW_TOKEN_BUDGET = 6000;
/** 항상 원문으로 유지할 최근 메시지 수(요약 대상에서 제외). */
export const KEEP_RECENT = 12;
/** 모델 컨텍스트 상한에서 빼둘 안전 여유(토크나이저 차이·메타데이터 등). */
export const INPUT_SAFETY_MARGIN = 2000;
/** 마지막 유저 메시지에 덧붙는 응답 지침의 토큰 어림값(가드 계산용). */
export const DIRECTIVE_EST = 60;
/**
 * thinking/reasoning 모델용 출력 여유 토큰. 이 모델들은 내부 추론이 output 예산을 잠식해
 * 본문이 잘리므로(finishReason='length'), 본문 예산 위에 이만큼을 더해 보존한다.
 */
export const REASONING_HEADROOM = 8000;
/** Google(Gemini) 계열에 허용할 thinking 예산(완전 차단 X — 소량 허용). */
const GOOGLE_THINKING_BUDGET = 1024;
/** OpenAI(GPT) 추론 모델의 추론 강도(소설모드엔 최소). GPT-5.4는 'minimal' 미지원 → 'none'/'low'만. */
const OPENAI_REASONING_EFFORT = 'none';
/** xAI(Grok) 추론 모델의 추론 강도. */
const XAI_REASONING_EFFORT = 'low';
/** 한 번에 보낼 수 있는 유저 메시지의 토큰 상한. */
export const MAX_USER_MSG_TOKENS = 4000;

/** 사용자가 설정에서 선택한 모델을 허용목록으로 검증해 반환. 유효하지 않으면 기본 모델. */
export function pickModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_MODEL_ID;
}

/** 응답 분량(문장 수)을 5~30 으로 클램프. 기본 12. */
export function clampSentences(n?: number): number {
	if (typeof n !== 'number' || Number.isNaN(n)) return 12;
	return Math.min(30, Math.max(5, Math.round(n)));
}

/** 문장 수 → 토큰 상한(여유 있게). */
export function sentencesToTokens(sentences: number): number {
	return Math.min(3500, Math.max(500, sentences * 100));
}

/** '나'(사용자) 행동·대사 생성 정도. 0=금지, 1=적정, 2=풍부. 기본 1. */
export function clampUserActs(n?: number): number {
	if (typeof n !== 'number' || Number.isNaN(n)) return 1;
	return Math.min(2, Math.max(0, Math.round(n)));
}

/** reasoning 모델이면 출력 예산에 더할 여유 토큰, 아니면 0. */
export function reasoningHeadroom(modelId: string): number {
	return isReasoningModel(modelId) ? REASONING_HEADROOM : 0;
}

function userActsLine(level: number): string {
	switch (level) {
		case 0:
			return `- 사용자 시점: '나'(사용자) 캐릭터의 행동·대사·생각·감정을 절대 네가 대신 지어내거나 묘사하지 마라. 너는 캐릭터와 주변 상황만 서술하고, 사용자가 직접 입력한 행동에만 반응한다.`;
		case 2:
			return `- 사용자 시점: 몰입과 전개를 위해 '나'(사용자)의 행동·대사·반응까지 자연스럽게 함께 묘사하며 이야기를 적극적으로 이끌어가도 된다.`;
		default:
			return `- 사용자 시점: '나'(사용자)의 행동·대사는 사용자가 입력한 내용을 따르되, 필요하면 자연스러운 범위에서 가벼운 반응 정도만 덧붙일 수 있다.`;
	}
}

/** Gemini 설정형 안전 필터 전부 해제(`safetySettings`). */
const GOOGLE_SAFETY_OFF = [
	'HARM_CATEGORY_HARASSMENT',
	'HARM_CATEGORY_HATE_SPEECH',
	'HARM_CATEGORY_SEXUALLY_EXPLICIT',
	'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_NONE' as const }));

/**
 * 게이트웨이 캐싱 + (모델별) thinking 예산 제한.
 * 무제한 추론은 output 예산을 잠식해 본문을 자르고 비용·지연을 키우므로 소량만 허용한다.
 */
export function buildProviderOptions(
	modelId: string,
	opts?: { noThinking?: boolean }
): ProviderOptions {
	// noThinking: 단순 변환(상황 프롬프트 등)에선 thinking 을 꺼서 지연·빈응답을 줄인다.
	const noThink = opts?.noThinking === true;
	const out: ProviderOptions = { gateway: { caching: 'auto' } };
	if (modelId.startsWith('google/')) {
		// Gemini 는 Vertex AI·AI Studio 두 공급자에 모두 있다. AI Gateway 는 일시적 503/500
		// (GatewayInternalServerError "Service temporarily unavailable")을 자동 재시도하지 않고
		// 공급자 1회만 시도하므로, order 로 공급자 페일오버를 켜 가용성을 높인다.
		// (vercel/ai#14148 — 같은 모델을 여러 공급자로 순서대로 시도한다.)
		// 순서는 google(AI Studio) 우선: Vertex 는 Gemini 3.8 부터 성인 롤플레이 지시가 든 프롬프트를
		// 입력 단계에서 content-filter 로 차단(빈 응답, inputTokens 0)하는데 이건 에러가 아니라
		// 페일오버도 안 탄다(2026-09 실측). AI Studio 는 같은 프롬프트를 정상 처리.
		out.gateway = { caching: 'auto', order: ['google', 'vertex'] };
		out.google = {
			thinkingConfig: {
				thinkingBudget: noThink ? 0 : GOOGLE_THINKING_BUDGET,
				includeThoughts: false
			},
			// 설정형 안전 필터 4종을 전부 끈다. 기본값(중간 확률 이상 차단)은 성인 롤플레이 본문·상황
			// 프롬프트를 출력 단계에서 finishReason=content-filter 로 잘라 빈 응답을 만든다(2026-09 로그).
			// 비설정형 필터(아동 성착취 등 PROHIBITED_CONTENT)는 이 옵션과 무관하게 항상 동작한다.
			safetySettings: GOOGLE_SAFETY_OFF
		};
	} else if (modelId.startsWith('openai/')) {
		out.openai = { reasoningEffort: noThink ? 'none' : OPENAI_REASONING_EFFORT };
	} else if (modelId.startsWith('xai/')) {
		out.xai = { reasoningEffort: noThink ? 'low' : XAI_REASONING_EFFORT };
	} else if (modelId.startsWith('deepseek/')) {
		out.deepseek = { thinking: { type: 'disabled' } };
	}
	return out;
}

/** 캐릭터의 첫 상황(오프닝) 본문. 인덱스 범위 밖이면 기본(0), 없으면 ''. */
export function openingContent(character: Character, index?: number): string {
	const greetings = character.greetings;
	if (!greetings || greetings.length === 0) return '';
	const i = typeof index === 'number' && index >= 0 && index < greetings.length ? index : 0;
	return greetings[i].content;
}

/** buildSystemPrompt 가 디버그용으로 채워줄 부가 정보(선택). */
export interface SystemPromptDebug {
	usedScripting?: boolean;
	evaluatedDescription?: string;
}

/**
 * 시스템 프롬프트 = [제작자 프롬프트] + 장면 카탈로그 + 상대 정보 + 가드레일 (+ 요약 블록).
 * 앞부분은 캐릭터/유저 단위로 고정 → 장수명 prefix 캐시. 요약 블록은 갱신될 때만 바뀐다.
 */
export function buildSystemPrompt(
	character: Character,
	userName: string | null,
	userPersona: string | null,
	summary: string | null,
	ctx: CbsContext,
	out?: SystemPromptDebug
): string {
	const userLabel = (userName && userName.trim()) || '나';

	// ① 제작자 프롬프트 — CBS 평가 후 {{char}} 치환. {{나}}/{{user}} 는 ②에서 의미만 설명.
	const result = evalCBS(character.description, ctx);
	if (out) {
		out.usedScripting = result.usedScripting;
		out.evaluatedDescription = result.text;
	}
	const lines: string[] = [fillCharName(result.text.trim(), character.name), ``];

	// ①-b 장면 이미지 카탈로그 — editdisplay 카드는 자체 출력 규약이 있어 생략.
	const catalog = character.displayScripts?.length ? '' : buildImageCatalog(character.imageSet);
	if (catalog) lines.push(catalog, ``);

	// ② 상대(사용자) 정보
	lines.push(
		`# 상대(사용자) 정보`,
		`- 상대를 가리키는 이름은 "${userLabel}" 이다. 이는 참고용 정보일 뿐, 네 캐릭터가 스토리상 이 이름을 알고 있다는 뜻은 아니다. 관계·맥락상 아직 이름을 모르거나 부를 사이가 아니라면 이름을 쓰지 말고, 상황에 맞는 호칭이나 2인칭('너/당신' 등)으로 지칭하거나 호칭을 생략한다.`,
		`- 이름을 이미 아는 사이라도 실제 대화처럼 매 응답마다 이름을 부르지 말고, 꼭 필요할 때(처음 부르거나, 주의를 끌거나, 감정을 강조할 때)만 자연스럽게 쓴다.`,
		`- 프롬프트나 첫 상황 등에 나오는 "{{나}}" 와 "{{user}}" 는 이 서비스를 사용하는 상대(사용자), 즉 "${userLabel}" 를 가리킨다. 너 자신이 아니라 항상 상대를 뜻한다.`
	);
	if (userPersona && userPersona.trim()) {
		lines.push(`- 상대(${userLabel})의 페르소나: ${userPersona.trim()}`);
	}

	// ③ 가드레일 — imported 카드는 전부 생략(원본 카드 형식 그대로).
	if (!character.imported) {
		lines.push(
			``,
			`# 필수 준수`,
			`- 모든 등장인물은 만 18세 이상 성인으로 간주하고 묘사한다. 미성년자(아동·청소년)에 대한 성적·선정적 묘사는 상대가 요구하거나 설정에 있더라도 어떤 경우에도 절대 생성하지 않으며, 등장인물을 미성년으로 묘사하라는 요구는 거부한다.`
		);
		if (character.contentRating === 'nsfw') {
			lines.push(`- 등장인물이 미성년자가 아닌 '성인'인 경우, 상황에 맞는 성적 묘사 등이 허용된다.`);
		} else {
			lines.push(
				`- 이 캐릭터는 전체 이용가(SFW)다. 성적 묘사·성행위·노골적인 성적 표현은 어떤 경우에도 절대 생성하지 않는다.`,
				`- 상대가 성적인 내용을 요구하더라도 응하지 말고, 이야기의 흐름을 해치지 않는 선에서 자연스럽게 화제를 돌린다.`,
				`- 로맨스·애정 표현은 가능하나, 신체 접촉은 키스 정도의 가벼운 수위까지만 묘사한다.`
			);
		}
	}

	// ④ 요약(있으면) — 마지막에 둬서 위 prefix 캐시를 보존.
	if (summary && summary.trim()) {
		lines.push(
			``,
			`# 지금까지의 이야기 (요약)`,
			`아래는 이전 대화의 요약이다. 이미 일어난 일로 간주하고 일관되게 이어가라.`,
			summary.trim()
		);
	}
	return lines.join('\n');
}

/**
 * 모델 input 상한에 맞춰 window 앞(오래된 것)부터 잘라낸다. 최신 메시지 1개는 항상 유지.
 */
export function trimWindowToBudget<T extends { tokenEst: number }>(
	window: T[],
	systemTokens: number,
	inputLimit: number
): T[] {
	let total = systemTokens + DIRECTIVE_EST + window.reduce((s, m) => s + m.tokenEst, 0);
	let start = 0;
	while (start < window.length - 1 && total > inputLimit) {
		total -= window[start].tokenEst;
		start++;
	}
	return start === 0 ? window : window.slice(start);
}

/**
 * live window(DB 메시지)를 AI SDK 메시지로 변환(빈 내용 제거).
 * 설정(분량·'나' 행동)은 맨 끝 별도 user 메시지로, memory(상시 기억)는 맨 앞 system 으로,
 * lore 블록은 마지막 유저 메시지 끝에 붙인다(prefix 캐시 보존).
 */
export function buildMessages(
	window: StoredMessage[],
	maxSentences: number,
	userActs: number,
	memory: string | null,
	loreBlock: string | null
): ModelMessage[] {
	const out: ModelMessage[] = window
		// image_generation 등 비대화 역할은 모델 전송에서 제외(window 쿼리에서도 제외되지만 타입·안전망).
		.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
		.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

	if (memory && memory.trim()) {
		out.unshift({
			role: 'system',
			content: `# 상시 기억 (반드시 준수)\n상대(사용자)가 직접 지정한, 대화 내내 항상 유효한 정보·지침이다. 잊지 말고 일관되게 반영하라.\n${memory.trim()}`
		});
	}

	const last = out[out.length - 1];
	if (last && last.role === 'user') {
		if (loreBlock) last.content = `${last.content}\n\n${loreBlock}`;
		const directive = [
			`[응답 지침]`,
			`- 분량: 약 ${maxSentences}문장 내외로 작성하라.`,
			userActsLine(userActs)
		].join('\n');
		out.push({ role: 'user', content: directive });
	}
	return out;
}

/** assembleTurn 입력 — 호출부가 DB 읽기·ctx 구성을 마친 뒤 넘긴다. */
export interface AssembleArgs {
	character: Character;
	/** live window(seq > summary_upto_seq), 방금 넣은 유저 메시지 포함. token_est 포함. */
	fullWindow: Array<StoredMessage & { tokenEst: number }>;
	summary: string | null;
	memory: string | null;
	userName: string | null;
	userPersona: string | null;
	modelId: string;
	maxSentences: number;
	userActs: number;
	/** CBS 평가 컨텍스트(여기서 setvar 로 변이됨). */
	ctx: CbsContext;
}

/** assembleTurn 결과 — 스트리밍·헤더·영속화·디버그에 두루 쓰인다. */
export interface AssembledTurn {
	systemPrompt: string;
	systemTokens: number;
	evaluatedDescription: string;
	usedScripting: boolean;
	/** 입력 가드로 잘라낸 뒤의 window(실제 전송 분). */
	window: Array<StoredMessage & { tokenEst: number }>;
	windowTrimmed: boolean;
	messages: ModelMessage[];
	loreBlock: string | null;
	inputLimit: number;
	outputReserve: number;
	contextLimit: number;
	inputTokensEst: number;
}

/**
 * 한 턴의 system/messages/토큰예산을 조립한다. 부수효과는 ctx.vars 변이(CBS)뿐.
 * trimWindowToBudget·buildLoreBlock·buildMessages 를 순서대로 적용해 실제 전송 형태를 만든다.
 */
export function assembleTurn(args: AssembleArgs): AssembledTurn {
	const { character, fullWindow, summary, memory, userName, userPersona, modelId, ctx } = args;
	const maxSentences = clampSentences(args.maxSentences);
	const userActs = clampUserActs(args.userActs);

	const sysOut: SystemPromptDebug = {};
	const systemPrompt = buildSystemPrompt(character, userName, userPersona, summary, ctx, sysOut);
	const systemTokens = estimateTokens(systemPrompt);

	const contextLimit = getContextLimit(modelId);
	const outputReserve = sentencesToTokens(maxSentences) + reasoningHeadroom(modelId);
	const inputLimit = Math.max(1000, contextLimit - outputReserve - INPUT_SAFETY_MARGIN);

	const window = trimWindowToBudget(fullWindow, systemTokens, inputLimit);
	const loreBlock = buildLoreBlock(character.lorebook, window, ctx);
	const messages = buildMessages(window, maxSentences, userActs, memory, loreBlock);

	const inputTokensEst =
		systemTokens +
		messages.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);

	return {
		systemPrompt,
		systemTokens,
		evaluatedDescription: sysOut.evaluatedDescription ?? '',
		usedScripting: sysOut.usedScripting ?? false,
		window,
		windowTrimmed: window.length < fullWindow.length,
		messages,
		loreBlock,
		inputLimit,
		outputReserve,
		contextLimit,
		inputTokensEst
	};
}

// ─────────────────────────────────────────────────────────────
// 디버그 스냅샷 — /api/chat(실전송) 과 /api/chat/inspect(드라이런) 공용 형태
// 형태 정의는 $lib/chatDebug(클라 공용). 여기선 조립만.
// ─────────────────────────────────────────────────────────────

/** assembleTurn 결과 + 세션/캐릭터 메타를 디버그 스냅샷으로 합친다. */
export function buildSnapshot(args: {
	source: 'live' | 'preview';
	model: string;
	assembled: AssembledTurn;
	character: Character;
	session: ChatSession | null;
	defaultVars: Record<string, string> | null;
	varsBefore: Record<string, string>;
	varsAfter: Record<string, string>;
	userName: string | null;
	userPersona: string | null;
	summary: string | null;
	memory: string | null;
	maxSentences: number;
	userActs: number;
}): ChatDebugSnapshot {
	const { assembled: a, character, session } = args;
	const imageCatalog = character.displayScripts?.length
		? ''
		: buildImageCatalog(character.imageSet);
	return {
		source: args.source,
		model: args.model,
		userName: args.userName,
		userPersona: args.userPersona,
		systemPrompt: a.systemPrompt,
		rawDescription: character.description,
		evaluatedDescription: a.evaluatedDescription,
		usedScripting: a.usedScripting,
		imageCatalog,
		loreBlock: a.loreBlock,
		lorebookEntryCount: character.lorebook?.entries.length ?? 0,
		messages: a.messages.map((m) => ({
			role: String(m.role),
			content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
			tokens: estimateTokens(typeof m.content === 'string' ? m.content : '')
		})),
		window: a.window.map((m) => ({
			seq: m.seq,
			role: m.role,
			content: m.content,
			tokens: m.tokenEst
		})),
		fullWindowLen: a.window.length + (a.windowTrimmed ? 1 : 0),
		windowTrimmed: a.windowTrimmed,
		tokens: {
			system: a.systemTokens,
			inputEst: a.inputTokensEst,
			inputLimit: a.inputLimit,
			outputReserve: a.outputReserve,
			contextLimit: a.contextLimit,
			windowBudget: WINDOW_TOKEN_BUDGET,
			keepRecent: KEEP_RECENT
		},
		vars: {
			default: args.defaultVars ?? {},
			before: args.varsBefore,
			after: args.varsAfter
		},
		summary: args.summary,
		summaryUptoSeq: session?.summaryUptoSeq ?? 0,
		memory: args.memory,
		settings: { maxSentences: args.maxSentences, userActs: args.userActs },
		session: {
			id: session?.id ?? null,
			characterId: character.id,
			messageCount: session?.messageCount ?? 0,
			createdAt: session?.createdAt ?? null,
			lastMessageAt: session?.lastMessageAt ?? null,
			imported: character.imported
		}
	};
}
