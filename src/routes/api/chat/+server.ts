import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { streamText, generateText, type ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
import { findCharacter } from '$lib/server/characters';
import { getCharacterPrompt } from '$lib/server/db/characters';
import { MODEL_IDS, DEFAULT_MODEL_ID, getContextLimit, isReasoningModel } from '$lib/data/models';
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
import { fillCharName, personalize } from '$lib/placeholders';
import { notifyServerError } from '$lib/server/notify';

/** live window 토큰 예산 — 이 이상이면 요약 트리거. */
const WINDOW_TOKEN_BUDGET = 6000;
/** 항상 원문으로 유지할 최근 메시지 수(요약 대상에서 제외). */
const KEEP_RECENT = 12;
/** 모델 컨텍스트 상한에서 빼둘 안전 여유(토크나이저 차이·메타데이터 등). */
const INPUT_SAFETY_MARGIN = 2000;
/** 마지막 유저 메시지에 덧붙는 응답 지침의 토큰 어림값(가드 계산용). */
const DIRECTIVE_EST = 60;
/**
 * thinking/reasoning 모델용 출력 여유 토큰. 이 모델들은 내부 추론이 output 예산을 잠식해
 * 본문이 잘리므로(finishReason='length'), 본문 예산 위에 이만큼을 더해 보존한다.
 * (Google 계열은 추론 자체를 끄므로 대개 미사용 여유로 남는다 — 안전망)
 */
const REASONING_HEADROOM = 8000;
/**
 * Google(Gemini) 계열에 허용할 thinking 예산. 0=완전 차단인데, 약간의 내부 추론은
 * 지시 준수·일관성에 도움이 되므로 소량만 허용한다. 본문 예산(maxOutputTokens)은
 * 이 값 + REASONING_HEADROOM 로 충분히 커서, 이 추론이 본문 길이를 잘라먹지 않는다.
 */
const GOOGLE_THINKING_BUDGET = 1024;
/**
 * 한 번에 보낼 수 있는 유저 메시지의 토큰 상한.
 * trimWindowToBudget 는 최신 메시지를 항상 보존하므로, 거대한 단일 메시지는
 * 누적 가드를 우회한다. 여기서 입력 단계에서 직접 막아 한 턴 비용 폭주를 방지한다.
 */
const MAX_USER_MSG_TOKENS = 4000;
/**
 * 응답 메타 프레임 구분자(RS, U+241E). 스트림 맨 끝에 `META_SEP + JSON` 으로 붙여,
 * 클라이언트가 본문과 분리해 console 에 찍는다. 모델 텍스트엔 등장하지 않는 제어문자.
 */
const META_SEP = '␞';

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
	/** 첫 대화 전에 미리 설정한 상시 기억(새 세션 생성 시에만 사용, 최대 100자). */
	memory?: string;
	/**
	 * 클라가 생성한 이번 유저/assistant 메시지 id. DB PK 로 그대로 저장해 클라 메시지 ↔ DB 행을
	 * 일치시킨다(이어가기 전, 라이브 메시지도 id 로 삭제 가능). 없으면 서버가 생성.
	 */
	userMsgId?: string;
	assistantMsgId?: string;
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
	// imported 캐릭터는 description 이 클라 노출 차단으로 빈 문자열 → 프롬프트 조립용 원본을 서버에서 채운다.
	if (character.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw != null) character.description = raw;
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
	// 클라가 보낸 메시지 id 가 있으면 DB PK 로 사용(라이브 메시지 삭제 동기화). 없으면 서버 생성.
	const userMsgId = pickMsgId(body.userMsgId);
	const assistantMsgId = pickMsgId(body.assistantMsgId);

	// ── 세션 확정: 기존 이어가기 or 새 세션(첫 상황을 seq=1 로 저장) ──
	let session: ChatSession | null;
	if (body.sessionId) {
		session = await getSession(db, body.sessionId, userId);
		if (!session) return json({ error: 'session not found' }, { status: 404 });
	} else {
		const opening = personalize(openingContent(character, body.openingIndex), character.name, userName);
		session = await createSession(db, {
			userId,
			characterId: character.id,
			model: modelId,
			opening,
			memory: body.memory
		});
	}

	// 유저 메시지 즉시 영속화 (스트림 끊겨도 유실 방지) + 세션 모델 갱신
	await appendMessage(db, session.id, 'user', text, modelId, undefined, undefined, userMsgId);

	// live window(seq > summary_upto_seq) — 방금 넣은 유저 메시지·오프닝 포함
	const fullWindow = await getWindow(db, session.id, session.summaryUptoSeq);

	// system 은 한 번만 만들어 토큰 추정과 호출에 함께 쓴다.
	const systemPrompt = buildSystemPrompt(character, userName, userPersona, session.summary);
	const systemTokens = estimateTokens(systemPrompt);

	// ── 모델별 input 상한 하드 가드 ──
	// 요약(백그라운드)이 못 따라잡았거나 거대한 메시지가 끼어도 모델 컨텍스트를 넘지 않도록,
	// 요청 시점에 동기적으로 오래된 window 부터 잘라낸다(최신 메시지는 항상 유지).
	// reasoning 모델은 내부 추론이 output 을 잠식하므로 본문 예산 위에 headroom 을 더한다.
	const outputReserve = sentencesToTokens(maxSentences) + reasoningHeadroom(modelId);
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

	const messages = buildMessages(window, maxSentences, userActs, session.memory);
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
		return mockStream(
			db,
			after,
			session,
			character,
			modelId,
			inputTokensEst,
			assistantMsgId,
			maxSentences,
			tokenHeaders
		);
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
		providerOptions: buildProviderOptions(modelId),
		temperature: 0.9,
		maxOutputTokens: outputReserve,
		onError: ({ error }) => {
			streamError = error;
			console.error(`[chat] streamText error (model=${modelId}):`, error);
			notifyServerError({
				context: 'streamText /api/chat',
				error,
				extra: { model: modelId, session: session!.id, character: character.id, user: userId },
				waitUntil: platform?.context?.waitUntil?.bind(platform.context)
			});
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
			const cost = parseGatewayCost(providerMetadata);
			after(
				persistAndMaybeSummarize(
					db,
					gateway,
					modelId,
					session!,
					window,
					clean,
					inputTokens,
					assistantMsgId,
					maxSentences,
					cost
				)
			);
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
				notifyServerError({
					context: 'textStream iterate /api/chat',
					error: err,
					extra: { model: modelId, session: session!.id, character: character.id, user: userId },
					waitUntil: platform?.context?.waitUntil?.bind(platform.context)
				});
			}
			if (streamError) {
				// 상세 에러는 서버 로그(onError)에만 남기고, 사용자에겐 일반 메시지만 노출
				controller.enqueue(encoder.encode('⚠️ 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'));
			}
			// 응답 메타(finishReason·usage 등)를 스트림 맨 끝에 sentinel 프레임으로 붙인다.
			// 클라이언트는 이를 떼어 console 에만 찍고 화면엔 렌더하지 않는다.
			// flash 등에서 출력이 잘리는 경우 finishReason='length'/'content-filter' 로 드러난다.
			const meta = await collectMeta(result, modelId, streamError);
			controller.enqueue(encoder.encode(META_SEP + safeJson(meta)));
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

/** collectMeta 가 읽는 streamText 결과의 종료 후 프로미스들(구조적 부분 타입). */
interface StreamMetaSource {
	finishReason: PromiseLike<unknown>;
	usage: PromiseLike<unknown>;
	totalUsage?: PromiseLike<unknown>;
	providerMetadata?: PromiseLike<unknown>;
	warnings?: PromiseLike<unknown>;
}

/**
 * 응답 종료 후 메타(종료사유·토큰·경고)를 모아 클라이언트 콘솔용 객체로.
 * finishReason 이 'length'면 maxOutputTokens 에 막혀 잘린 것, 'content-filter'면 안전필터 차단.
 */
async function collectMeta(
	result: StreamMetaSource,
	modelId: string,
	streamError: unknown
): Promise<Record<string, unknown>> {
	const meta: Record<string, unknown> = { model: modelId };
	try {
		meta.finishReason = await result.finishReason;
		meta.usage = await result.usage;
		if (result.totalUsage) meta.totalUsage = await result.totalUsage;
		if (result.providerMetadata) meta.providerMetadata = await result.providerMetadata;
		if (result.warnings) meta.warnings = await result.warnings;
	} catch (e) {
		meta.metaError = String(e);
	}
	if (streamError) meta.streamError = String(streamError);
	return meta;
}

/**
 * AI Gateway 가 반환한 이번 턴 추론 비용(USD)을 추출. providerMetadata.gateway.cost 는
 * "0.0270609" 같은 문자열 → 숫자로. 없거나 파싱 불가면 undefined(미기록).
 */
function parseGatewayCost(providerMetadata: unknown): number | undefined {
	const meta = providerMetadata as { gateway?: { cost?: unknown } } | undefined;
	const raw = meta?.gateway?.cost;
	if (raw == null) return undefined;
	const n = typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/** 메타 직렬화(직렬화 불가 값이 섞여도 스트림이 깨지지 않게 방어). */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (e) {
		return JSON.stringify({ metaError: `serialize failed: ${String(e)}` });
	}
}

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
	inputTokens: number,
	assistantMsgId: string,
	maxSentences: number,
	cost?: number
): Promise<void> {
	const assistantSeq = await appendMessage(
		db,
		session.id,
		'assistant',
		reply,
		modelId,
		inputTokens,
		cost,
		assistantMsgId,
		maxSentences
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
		// reasoning 모델은 추론이 예산을 먹어 빈 요약이 나오므로 headroom 을 더한다.
		maxOutputTokens: 2000 + reasoningHeadroom(modelId),
		providerOptions: buildProviderOptions(modelId)
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
	`- 시점·인물명은 대화 그대로 유지. 한국어. 1500자 이내의 간결한 개조식 문단.`,
	`- 새 요약 본문만 출력(머리말·설명 금지).`
].join('\n');

/** 사용자가 설정에서 선택한 모델을 허용목록으로 검증해 반환. 유효하지 않으면 기본 모델. */
function pickModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_MODEL_ID;
}

/** 클라가 보낸 메시지 id 검증(비어있지 않은 문자열만 채택). 없으면 새 uuid. */
function pickMsgId(requested?: string): string {
	return typeof requested === 'string' && requested.trim() !== ''
		? requested.trim()
		: crypto.randomUUID();
}

/** reasoning 모델이면 출력 예산에 더할 여유 토큰, 아니면 0. */
function reasoningHeadroom(modelId: string): number {
	return isReasoningModel(modelId) ? REASONING_HEADROOM : 0;
}

/**
 * 게이트웨이 캐싱 + (Google 계열) thinking 예산 소량 제한.
 * 무제한 추론은 output 예산을 잠식해 본문을 자르고 비용·지연을 키우므로, Gemini 등 Google
 * 모델은 thinkingBudget 을 작게 둔다(완전 차단 X). includeThoughts=false 로 추론 텍스트는
 * 응답 본문에 섞지 않는다.
 */
function buildProviderOptions(modelId: string): ProviderOptions {
	const opts: ProviderOptions = { gateway: { caching: 'auto' } };
	if (modelId.startsWith('google/')) {
		opts.google = {
			thinkingConfig: { thinkingBudget: GOOGLE_THINKING_BUDGET, includeThoughts: false }
		};
	}
	return opts;
}

/** 캐릭터의 첫 상황(오프닝) 본문. 인덱스 범위 밖이면 기본(0), 없으면 ''. */
function openingContent(character: Character, index?: number): string {
	const greetings = character.greetings;
	if (!greetings || greetings.length === 0) return '';
	const i = typeof index === 'number' && index >= 0 && index < greetings.length ? index : 0;
	return greetings[i].content;
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
	//    {{char}} 는 캐릭터-불변이라 prefix 에 직접 치환해도 교차-유저 캐싱 안전.
	//    {{나}}/{{user}} 는 유저-가변이라 여기선 그대로 두고 아래 ②에서 의미만 설명(캐시 prefix 보존).
	const lines: string[] = [fillCharName(character.description.trim(), character.name), ``];

	// ①-b 장면 이미지 카탈로그 — 캐릭터 단위로 고정 → prefix 캐시 유지.
	const catalog = buildImageCatalog(character.imageSet);
	if (catalog) lines.push(catalog, ``);

	// ② 상대(사용자) 정보 — 런타임 정보라 공통으로 주입
	lines.push(
		`# 상대(사용자) 정보`,
		`- 상대의 이름은 "${userLabel}" 이다. 대화에서 상대를 이 이름으로 부른다.`,
		`- 프롬프트나 첫 상황 등에 나오는 "{{나}}" 와 "{{user}}" 는 이 서비스를 사용하는 상대(사용자), 즉 "${userLabel}" 를 가리킨다. 너 자신이 아니라 항상 상대를 뜻한다.`
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
 * memory(상시 기억)가 있으면 system 프롬프트와 history 사이(messages 맨 앞)에
 * system 롤 메시지로 끼워 넣는다 — 유저가 강제하는 항상 유효한 지침.
 */
function buildMessages(
	window: StoredMessage[],
	maxSentences: number,
	userActs: number,
	memory: string | null
): ModelMessage[] {
	const out: ModelMessage[] = window
		.filter((m) => m.content.trim() !== '')
		.map((m) => ({ role: m.role, content: m.content }));

	if (memory && memory.trim()) {
		out.unshift({
			role: 'system',
			content: `# 상시 기억 (반드시 준수)\n상대(사용자)가 직접 지정한, 대화 내내 항상 유효한 정보·지침이다. 잊지 말고 일관되게 반영하라.\n${memory.trim()}`
		});
	}

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
	assistantMsgId: string,
	maxSentences: number,
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
			controller.enqueue(
				encoder.encode(
					META_SEP + safeJson({ model: modelId, finishReason: 'stop', mock: true })
				)
			);
			controller.close();
			// mock 은 실 usage 가 없으므로 추정치를 input 토큰으로 저장.
			after(
				appendMessage(
					db,
					session.id,
					'assistant',
					reply,
					modelId,
					inputTokensEst,
					undefined,
					assistantMsgId,
					maxSentences
				).then(() => undefined)
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
