import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { streamText, generateText, type ModelMessage } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
import { findCharacter } from '$lib/server/characters';
import { MODEL_IDS, DEFAULT_MODEL_ID, getContextLimit } from '$lib/data/models';
import {
	getSession,
	createSession,
	appendMessage,
	getWindow,
	updateSummary,
	estimateTokens
} from '$lib/server/db/chats';
import type { Character, ChatSession, StoredMessage } from '$lib/types';
import { buildImageCatalog, pinSceneCodes } from '$lib/imageCodes';

/** live window 토큰 예산 — 이 이상이면 요약 트리거. */
const WINDOW_TOKEN_BUDGET = 6000;
/** 항상 원문으로 유지할 최근 메시지 수(요약 대상에서 제외). */
const KEEP_RECENT = 12;
/** 모델 컨텍스트 상한에서 빼둘 안전 여유(토크나이저 차이·메타데이터 등). */
const INPUT_SAFETY_MARGIN = 2000;
/** 마지막 유저 메시지에 덧붙는 응답 지침의 토큰 어림값(가드 계산용). */
const DIRECTIVE_EST = 60;
/**
 * 한 번에 보낼 수 있는 유저 메시지의 토큰 상한.
 * trimWindowToBudget 는 최신 메시지를 항상 보존하므로, 거대한 단일 메시지는
 * 누적 가드를 우회한다. 여기서 입력 단계에서 직접 막아 한 턴 비용 폭주를 방지한다.
 */
const MAX_USER_MSG_TOKENS = 4000;

interface ChatRequestBody {
	characterId: string;
	/** 이어갈 세션 id. 없으면 새 세션을 lazy 생성. */
	sessionId?: string;
	/** 이번에 보낼 유저 메시지 본문. */
	text: string;
	/** 새 세션 생성 시 사용할 첫 상황(오프닝) 인덱스. */
	openingIndex?: number;
	/** 사용자가 설정에서 선택한 모델 ID (허용목록 검증). */
	model?: string;
	/** 응답 분량(문장 수). 5~30, 기본 12. */
	maxSentences?: number;
	/** '나'(사용자) 행동·대사를 AI가 생성하는 정도. 0=금지, 1=적정, 2=풍부. 기본 1. */
	userActs?: number;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	// 로그인 필수 (클라이언트 가드 우회 방지)
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	const db = platform?.env?.DB;
	if (!db) {
		return json({ error: 'db unavailable' }, { status: 500 });
	}

	const body = (await request.json()) as ChatRequestBody;
	const character = await findCharacter(db, body.characterId);
	if (!character) {
		return json({ error: 'character not found' }, { status: 404 });
	}

	const text = (body.text ?? '').trim();
	if (!text) {
		return json({ error: 'empty message' }, { status: 400 });
	}
	// 거대한 단일 메시지는 window trim 으로 못 막으므로(최신 메시지는 항상 유지됨)
	// 입력 단계에서 직접 거부해 한 턴 input 토큰/비용 상한을 보장한다.
	if (estimateTokens(text) > MAX_USER_MSG_TOKENS) {
		return json({ error: 'message too long' }, { status: 413 });
	}

	const userId = locals.user.id;
	const userName = locals.user.name;
	const userPersona = locals.user.persona;
	const modelId = pickModel(body.model);
	const maxSentences = clampSentences(body.maxSentences);
	const userActs = clampUserActs(body.userActs);

	// ── 세션 확정: 기존 이어가기 or 새 세션(첫 상황을 seq=1 로 저장) ──
	let session: ChatSession | null;
	if (body.sessionId) {
		session = await getSession(db, body.sessionId, userId);
		if (!session) return json({ error: 'session not found' }, { status: 404 });
	} else {
		const opening = personalizeUser(openingContent(character, body.openingIndex), userName);
		session = await createSession(db, {
			userId,
			characterId: character.id,
			model: modelId,
			opening
		});
	}

	// 유저 메시지 즉시 영속화 (스트림 끊겨도 유실 방지) + 세션 모델 갱신
	await appendMessage(db, session.id, 'user', text, modelId);

	// live window(seq > summary_upto_seq) — 방금 넣은 유저 메시지·오프닝 포함
	const fullWindow = await getWindow(db, session.id, session.summaryUptoSeq);

	// system 은 한 번만 만들어 토큰 추정과 호출에 함께 쓴다.
	const systemPrompt = buildSystemPrompt(character, userName, userPersona, session.summary);
	const systemTokens = estimateTokens(systemPrompt);

	// ── 모델별 input 상한 하드 가드 ──
	// 요약(백그라운드)이 못 따라잡았거나 거대한 메시지가 끼어도 모델 컨텍스트를 넘지 않도록,
	// 요청 시점에 동기적으로 오래된 window 부터 잘라낸다(최신 메시지는 항상 유지).
	const outputReserve = sentencesToTokens(maxSentences);
	const inputLimit = Math.max(
		1000,
		getContextLimit(modelId) - outputReserve - INPUT_SAFETY_MARGIN
	);
	const window = trimWindowToBudget(fullWindow, systemTokens, inputLimit);
	if (window.length < fullWindow.length) {
		console.warn(
			`[chat] input guard trimmed window ${fullWindow.length}→${window.length} (model=${modelId}, limit=${inputLimit})`
		);
	}

	const messages = buildMessages(window, maxSentences, userActs);
	// 이번 턴에 실제로 보낼 input 토큰 추정치(헤더로 즉시 반환 + usage 없을 때 폴백).
	const inputTokensEst =
		systemTokens +
		messages.reduce(
			(s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''),
			0
		);

	const apiKey = env.AI_GATEWAY_API_KEY;
	const gateway = apiKey ? createGateway({ apiKey }) : null;

	// 응답 종료 후 처리(영속화·요약)를 워커 생존 보장 하에 실행.
	const after = (p: Promise<unknown>) => {
		const guarded = p.catch((e) => console.error('[chat] after-task error:', e));
		if (platform?.context?.waitUntil) platform.context.waitUntil(guarded);
	};

	// 턴별 input 토큰을 응답 헤더로 내려준다(추정치). 실측은 onFinish 에서 DB 저장.
	const tokenHeaders = {
		'x-haven-session': session.id,
		'x-haven-input-tokens': String(inputTokensEst),
		'x-haven-input-max': String(inputLimit)
	};

	// 키가 없으면 mock 스트리머로 폴백 (로컬에서 키 없이도 UI 동작)
	if (!gateway) {
		return mockStream(db, after, session, character, modelId, inputTokensEst, tokenHeaders);
	}

	console.log(
		`[chat] session=${session.id} character=${character.id} model=${modelId} window=${window.length} inputEst=${inputTokensEst} summarized=${session.summaryUptoSeq > 0}`
	);

	// AI SDK v6 의 textStream 은 에러를 throw 하지 않고 빈 스트림으로 끝나므로
	// onError 로 에러를 포착한 뒤, 스트림 종료 후 채팅 버블에 노출한다(디버깅용).
	let streamError: unknown = null;

	const result = streamText({
		model: gateway(modelId),
		// system = [제작자 프롬프트 + 상대 정보 + 가드레일] (고정 prefix)
		//          + (요약 있으면) "지금까지의 이야기" 블록. 요약 갱신 때만 변함 → 대부분 캐시 hit.
		system: systemPrompt,
		// live window 만 전송(오래된 맥락은 summary 가 대체) → input 토큰 상한.
		messages,
		providerOptions: {
			gateway: { caching: 'auto' }
		},
		temperature: 0.9,
		maxOutputTokens: outputReserve,
		onError: ({ error }) => {
			streamError = error;
			console.error(`[chat] streamText error (model=${modelId}):`, error);
		},
		onFinish: ({ text: reply, usage, providerMetadata }) => {
			// AI 호출 토큰·캐시 사용량 실측 로그.
			// cacheRead > 0 이면 prefix 캐시 hit, cacheWrite 는 이번 턴에 새로 캐시에 쓴 토큰.
			const d = usage?.inputTokenDetails;
			const cacheRead = d?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
			const cacheWrite = d?.cacheWriteTokens ?? 0;
			console.log(
				`[chat] usage session=${session!.id} model=${modelId} ` +
					`in=${usage?.inputTokens ?? 0} out=${usage?.outputTokens ?? 0} total=${usage?.totalTokens ?? 0} | ` +
					`cacheRead=${cacheRead} cacheWrite=${cacheWrite} noCache=${d?.noCacheTokens ?? 0}` +
					(providerMetadata?.gateway
						? ` | gateway=${JSON.stringify(providerMetadata.gateway)}`
						: '')
			);

			// 저장 직전 위치코드 {AAB} → 불변 토큰 {#id} 로 고정(이후 제작자 수정에 안 흔들림).
			const clean = pinSceneCodes(reply.trim(), character.imageSet);
			if (!clean) return; // 에러/빈 응답은 저장하지 않음(유저 메시지는 이미 저장됨)
			const inputTokens = usage?.inputTokens ?? inputTokensEst;
			after(persistAndMaybeSummarize(db, gateway, modelId, session!, window, clean, inputTokens));
		}
	});

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const chunk of result.textStream) {
					controller.enqueue(encoder.encode(chunk));
				}
			} catch (err) {
				streamError = err;
			}
			if (streamError) {
				// 상세 에러는 서버 로그(onError)에만 남기고, 사용자에겐 일반 메시지만 노출
				controller.enqueue(encoder.encode('⚠️ 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'));
			}
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			...tokenHeaders
		}
	});
};

/**
 * 모델 input 상한에 맞춰 window 앞(오래된 것)부터 잘라낸다. 최신 메시지 1개는 항상 유지.
 * 정상 흐름에선 요약이 window 를 작게 유지하므로 거의 동작하지 않는 안전망이다.
 */
function trimWindowToBudget<T extends { tokenEst: number }>(
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
 * assistant 응답을 저장하고, live window 가 예산을 넘으면 요약을 갱신한다.
 * window 는 assistant 추가 전 시점이라, 여기에 reply 를 더해 트리거를 판단한다.
 */
async function persistAndMaybeSummarize(
	db: D1Database,
	gateway: GatewayProvider,
	modelId: string,
	session: ChatSession,
	windowBefore: Array<StoredMessage & { tokenEst: number }>,
	reply: string,
	inputTokens: number
): Promise<void> {
	const assistantSeq = await appendMessage(
		db,
		session.id,
		'assistant',
		reply,
		modelId,
		inputTokens
	);

	const liveCount = windowBefore.length + 1;
	const liveTokens = windowBefore.reduce((s, m) => s + m.tokenEst, 0) + estimateTokens(reply);
	if (liveCount > KEEP_RECENT && liveTokens > WINDOW_TOKEN_BUDGET) {
		await summarizeSession(db, gateway, modelId, session, assistantSeq);
	}
}

/**
 * 요약 갱신: [기존 summary] + [summary_upto_seq+1 ~ (latest - KEEP_RECENT)] 구간을
 * 세션의 마지막 사용 모델로 합쳐 새 summary 를 만들고 경계를 전진시킨다.
 * 최근 KEEP_RECENT 개는 원문으로 남겨 직전 맥락·말투를 보존한다.
 */
async function summarizeSession(
	db: D1Database,
	gateway: GatewayProvider,
	modelId: string,
	session: ChatSession,
	latestSeq: number
): Promise<void> {
	const cutSeq = latestSeq - KEEP_RECENT;
	if (cutSeq <= session.summaryUptoSeq) return;

	const win = await getWindow(db, session.id, session.summaryUptoSeq);
	const toSummarize = win.filter((m) => m.seq <= cutSeq);
	if (toSummarize.length === 0) return;

	const transcript = toSummarize
		.map((m) => `${m.role === 'user' ? '상대' : '캐릭터'}: ${m.content}`)
		.join('\n');
	const prior = session.summary ? `[기존 요약]\n${session.summary}\n\n` : '';

	const { text } = await generateText({
		model: gateway(modelId),
		system: SUMMARY_SYSTEM,
		prompt: `${prior}[추가 대화]\n${transcript}`,
		temperature: 0.3,
		maxOutputTokens: 800,
		providerOptions: { gateway: { caching: 'auto' } }
	});

	const summary = text.trim();
	if (summary) {
		await updateSummary(db, session.id, summary, cutSeq);
		console.log(`[chat] summarized session=${session.id} upto seq=${cutSeq}`);
	}
}

const SUMMARY_SYSTEM = [
	`너는 롤플레이 대화의 "기록 관리자"다.`,
	`[기존 요약]과 [추가 대화]를 하나로 합쳐, 이후 대화에 필요한 정보만 남긴 새 요약을 작성하라.`,
	`- 포함: 줄거리 진행, 인물 관계·감정 변화, 확정된 설정/사실, 미해결된 떡밥·약속.`,
	`- 제외: 인사·잡담·중복, 문체 흉내(요약은 산문 묘사가 아니라 사실 정리다).`,
	`- 시점·인물명은 대화 그대로 유지. 한국어. 800자 이내의 간결한 개조식 문단.`,
	`- 새 요약 본문만 출력(머리말·설명 금지).`
].join('\n');

/** 사용자가 설정에서 선택한 모델을 허용목록으로 검증해 반환. 유효하지 않으면 기본 모델. */
function pickModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_MODEL_ID;
}

/** 캐릭터의 첫 상황(오프닝) 본문. 인덱스 범위 밖이면 기본(0), 없으면 ''. */
function openingContent(character: Character, index?: number): string {
	const greetings = character.greetings;
	if (!greetings || greetings.length === 0) return '';
	const i = typeof index === 'number' && index >= 0 && index < greetings.length ? index : 0;
	return greetings[i].content;
}

/** 제작자가 쓴 "{{나}}" 플레이스홀더 → 사용자 이름(없으면 '나')으로 치환. */
function personalizeUser(text: string, userName: string | null): string {
	const label = (userName && userName.trim()) || '나';
	return text.replace(/\{\{\s*나\s*\}\}/g, label);
}

/**
 * 시스템 프롬프트 = [제작자 프롬프트] + 상대 정보 + 가드레일 (+ 요약 블록).
 * 앞 3개는 캐릭터/유저 단위로 고정 → 장수명 prefix 캐시.
 * 요약 블록은 갱신될 때만 바뀌므로 그 사이 턴들에선 캐시가 재사용된다.
 */
function buildSystemPrompt(
	character: Character,
	userName: string | null,
	userPersona: string | null,
	summary: string | null
): string {
	const userLabel = (userName && userName.trim()) || '나';

	// ① 제작자가 작성한 프롬프트 (전체 프레이밍·설정·형식)
	const lines: string[] = [character.description.trim(), ``];

	// ①-b 장면 이미지 카탈로그 — 캐릭터 단위로 고정 → prefix 캐시 유지.
	const catalog = buildImageCatalog(character.imageSet);
	if (catalog) lines.push(catalog, ``);

	// ② 상대(사용자) 정보 — 런타임 정보라 공통으로 주입
	lines.push(
		`# 상대(사용자) 정보`,
		`- 상대의 이름은 "${userLabel}" 이다. 대화에서 상대를 이 이름으로 부른다.`,
		`- 프롬프트나 첫 상황 등에 나오는 "{{나}}" 는 이 서비스를 사용하는 상대(사용자), 즉 "${userLabel}" 를 가리킨다. 너 자신이 아니라 항상 상대를 뜻한다.`
	);
	if (userPersona && userPersona.trim()) {
		lines.push(`- 상대(${userLabel})의 페르소나: ${userPersona.trim()}`);
	}

	// ③ 가드레일 — 항상 강제되는 안전 규칙. 캐릭터 등급(sfw/nsfw)에 따라 성적 묘사 정책이 달라진다.
	lines.push(``, `# 필수 준수`, `- 미성년자에 대한 성적 묘사 등 불법적인 내용은 어떤 경우에도 생성하지 않는다.`);
	if (character.contentRating === 'nsfw') {
		lines.push(`- 등장인물이 미성년자가 아닌 '성인'인 경우, 상황에 맞는 성적 묘사 등이 허용된다.`);
	} else {
		lines.push(
			`- 이 캐릭터는 전체 이용가(SFW)다. 성적 묘사·성행위·노골적인 성적 표현은 어떤 경우에도 절대 생성하지 않는다.`,
			`- 상대가 성적인 내용을 요구하더라도 응하지 말고, 이야기의 흐름을 해치지 않는 선에서 자연스럽게 화제를 돌린다.`,
			`- 로맨스·애정 표현은 가능하나, 신체 접촉은 키스 정도의 가벼운 수위까지만 묘사한다.`
		);
	}

	// ④ 요약(있으면) — 잘려나간 과거 맥락의 압축본. 마지막에 둬서 위 prefix 캐시를 보존.
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

/** 응답 분량(문장 수)을 5~30 으로 클램프. 기본 12. */
function clampSentences(n?: number): number {
	if (typeof n !== 'number' || Number.isNaN(n)) return 12;
	return Math.min(30, Math.max(5, Math.round(n)));
}

/** 문장 수 → 토큰 상한(여유 있게). */
function sentencesToTokens(sentences: number): number {
	return Math.min(3500, Math.max(500, sentences * 100));
}

/** '나'(사용자) 행동·대사 생성 정도. 0=금지, 1=적정, 2=풍부. 기본 1. */
function clampUserActs(n?: number): number {
	if (typeof n !== 'number' || Number.isNaN(n)) return 1;
	return Math.min(2, Math.max(0, Math.round(n)));
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

/**
 * live window(DB 메시지)를 AI SDK 메시지로 변환(빈 내용 제거).
 * 유저 설정(분량·'나' 행동 생성 정도)은 마지막 유저 메시지 끝에만 덧붙인다
 * → 과거 메시지/시스템 prefix 는 그대로라 캐싱 유지.
 */
function buildMessages(
	window: StoredMessage[],
	maxSentences: number,
	userActs: number
): ModelMessage[] {
	const out: ModelMessage[] = window
		.filter((m) => m.content.trim() !== '')
		.map((m) => ({ role: m.role, content: m.content }));

	const last = out[out.length - 1];
	if (last && last.role === 'user') {
		const directive = [
			`[응답 지침]`,
			`- 분량: 약 ${maxSentences}문장 내외로 작성하라.`,
			userActsLine(userActs)
		].join('\n');
		last.content = `${last.content}\n\n${directive}`;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────
// 폴백: AI Gateway 키가 없을 때 사용하는 mock 스트리머 (저장은 동일하게 수행)
// ─────────────────────────────────────────────────────────────
function mockStream(
	db: D1Database,
	after: (p: Promise<unknown>) => void,
	session: ChatSession,
	character: Character,
	modelId: string,
	inputTokensEst: number,
	tokenHeaders: Record<string, string>
): Response {
	const reply = mockReply(character.name);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const tokens = reply.match(/\S+\s*/g) ?? [reply];
			for (const token of tokens) {
				controller.enqueue(encoder.encode(token));
				await new Promise((r) => setTimeout(r, 35));
			}
			controller.close();
			// mock 은 실 usage 가 없으므로 추정치를 input 토큰으로 저장.
			after(
				appendMessage(db, session.id, 'assistant', reply, modelId, inputTokensEst).then(
					() => undefined
				)
			);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'x-haven-mock': '1',
			...tokenHeaders
		}
	});
}

function mockReply(name: string): string {
	const samples = [
		`그래? 사실 나도 비슷한 생각 하고 있었어. 근데 너는 어떻게 하고 싶은데?`,
		`(${name}이/가 잠시 고민한다) 흠... 솔직히 말하면, 네가 그렇게 말해주니까 좀 기뻐.`,
		`그 말, 곱씹게 되네. 우리 천천히 같이 풀어보자.`
	];
	return samples[name.length % samples.length];
}
