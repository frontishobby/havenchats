import { Hono } from 'hono';
import { streamText, generateText, generateObject } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
import { getWaitUntil } from '$lib/server/waitUntil';
import { findCharacter } from '$lib/server/characters';
import {
	getCharacterPrompt,
	getCharacterLorebook,
	getCharacterDefaultVars
} from '$lib/server/db/characters';
import { isAdmin } from '$lib/server/auth';
import { makeRng, type CbsContext } from '$lib/cbs';
import {
	getSession,
	createSession,
	appendMessage,
	getWindow,
	updateSummary,
	updateScriptState,
	estimateTokens,
	getMessagePage,
	deleteMessage,
	deleteSession,
	setMemoryText,
	setSummaryText,
	getOwnedMessage,
	messageExists,
	updateMessageContentCost,
	updateImageLedgers
} from '$lib/server/db/chats';
import type { AppearanceLedger, Character, ChatSession, OutfitLedger, StoredMessage } from '$lib/types';
import { pinSceneCodes } from '$lib/imageCodes';
import { personalize } from '$lib/placeholders';
import { notifyServerError } from '$lib/server/notify';
import { getDecryptedKey, getKeyStatus } from '$lib/server/db/userKeys';
import { getModulesForChat } from '$lib/server/db/modules';
import { MAX_ACTIVE_MODULES } from '$lib/api/modules';
import {
	assembleTurn,
	buildSnapshot,
	buildProviderOptions,
	clampSentences,
	clampUserActs,
	openingContent,
	pickModel,
	reasoningHeadroom,
	repetitionPenalties,
	WINDOW_TOKEN_BUDGET,
	KEEP_RECENT,
	MAX_USER_MSG_TOKENS,
	type ChatDebugSnapshot
} from '$lib/server/chatAssembly';
import { loadRecentChats, parseRecentCursor, RECENT_PAGE_SIZE } from '$lib/server/recentChats';
import { containsMinorTerms } from '$lib/server/minorSafety';
import {
	ADULT_ONLY_RULE,
	HIDDEN_FEATURE_RULE,
	SCENE_PROMPT_SCHEMA,
	sanitizeScene,
	sanitizeTags as sanitizeSituation,
	stripHiddenFeatures,
	str
} from '$lib/server/imagePrompt';
import {
	buildPositivePrompt,
	buildGeneratePayload,
	isResolutionKey,
	RESOLUTIONS,
	DEFAULT_RESOLUTION,
	negativeFor,
	imageParamsFor,
	type ResolutionKey
} from '$lib/server/novelai';
import { pickNaiModel } from '$lib/naiModels';
import { IMAGE_PROMPT_MODEL_IDS, DEFAULT_IMAGE_PROMPT_MODEL_ID } from '$lib/data/models';
import type { ImageDebug } from '$lib/chatDebug';
import { loadChatPage } from '$lib/server/chatPageLoad';
import type {
	ChatRequestBody,
	ImagePrepareResponse,
	ImageCommitResponse,
	RewriteRequestBody,
	RewriteResponse,
	SuggestRequestBody,
	SuggestResponse
} from '$lib/api/chat';
import type { AppEnv } from '../../context';
import { requireUser } from '../../context';

export const chatRouter = new Hono<AppEnv>();

// ════════════════════════════════════════════════════════════════════════════
// 모듈 공용 헬퍼/상수
// ════════════════════════════════════════════════════════════════════════════

/**
 * 응답 메타 프레임 구분자(RS, U+241E). 스트림 맨 끝에 `META_SEP + JSON` 으로 붙여,
 * 클라이언트가 본문과 분리해 console 에 찍는다. 모델 텍스트엔 등장하지 않는 제어문자.
 */
const META_SEP = '␞';

/**
 * AI Gateway 가 반환한 이번 턴 추론 비용(USD)을 추출. providerMetadata.gateway.cost 는
 * "0.0270609" 같은 문자열 → 숫자로. 없거나 파싱 불가면 undefined(미기록).
 * (chat/+server.ts 와 chat/image/+server.ts 에서 byte-identical → 여기 한 번만 정의.)
 */
function parseGatewayCost(providerMetadata: unknown): number | undefined {
	const meta = providerMetadata as { gateway?: { cost?: unknown } } | undefined;
	const raw = meta?.gateway?.cost;
	if (raw == null) return undefined;
	const n = typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// POST '/'  — 스트리밍 채팅 (구 src/routes/api/chat/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

chatRouter.post('/', async (c) => {
	// 로그인 필수 (클라이언트 가드 우회 방지)
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'db unavailable' }, 500);
	}

	// 챗은 유저 본인 Vercel AI Gateway 키로 호출(BYO). 키 없으면 차단(예외 없음).
	const gatewayKey = await getDecryptedKey(db, user.id, 'gateway');
	if (!gatewayKey) {
		return c.json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			400
		);
	}

	const body = (await c.req.json()) as ChatRequestBody;
	const character = await findCharacter(db, body.characterId);
	if (!character) {
		return c.json({ error: 'character not found' }, 404);
	}
	// imported 캐릭터는 description·lorebook 이 클라 노출 차단으로 비어 있음 → 조립용 원본을 서버에서 채운다.
	// 기본 변수(defaultVariables)도 서버 전용 → 세션 변수 시딩·CBS 평가에 쓴다.
	let characterDefaultVars: Record<string, string> | null = null;
	if (character.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw != null) character.description = raw;
		character.lorebook = await getCharacterLorebook(db, character.id);
		characterDefaultVars = await getCharacterDefaultVars(db, character.id);
	}

	// 이어가기(자동 진행): 유저 메시지 없이 직전 장면을 캐릭터가 이어 쓴다(빈 입력으로 전송 버튼).
	// text 는 저장하지 않고, 조립(buildMessages)이 마지막 assistant 뒤에 이어가기 지시를 붙인다.
	const continueTurn = body.continue === true;
	const text = continueTurn ? '' : (body.text ?? '').trim();
	if (!text && !continueTurn) {
		return c.json({ error: 'empty message' }, 400);
	}
	// 거대한 단일 메시지는 window trim 으로 못 막으므로(최신 메시지는 항상 유지됨)
	// 입력 단계에서 직접 거부해 한 턴 input 토큰/비용 상한을 보장한다.
	if (text && estimateTokens(text) > MAX_USER_MSG_TOKENS) {
		return c.json({ error: 'message too long' }, 413);
	}

	const userId = user.id;
	// 채팅에서 AI 가 부르는 이름: 대화용 이름(persona_name) 우선, 없으면 노출용 이름(display_name)으로 폴백.
	const userName = (user.personaName && user.personaName.trim()) || user.name;
	const userPersona = user.persona;
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
		if (!session) return c.json({ error: 'session not found' }, 404);
	} else {
		const opening = personalize(openingContent(character, body.openingIndex), character.name, userName);
		session = await createSession(db, {
			userId,
			characterId: character.id,
			model: modelId,
			opening,
			memory: body.memory,
			defaultVariables: characterDefaultVars
		});
	}

	// 유저 메시지 즉시 영속화 (스트림 끊겨도 유실 방지) + 세션 모델 갱신.
	// 입력 필터(/rewrite)를 거쳤으면 그 변환 비용을 user 행 cost 로 함께 기록(통계 합산용).
	// 이어가기 턴은 유저 행이 없다 → 다음 seq 만 계산(ctx.index 용).
	const inputCost = clampReportedCost(body.inputCost);
	const userSeq = continueTurn
		? session.messageCount + 1
		: await appendMessage(db, session.id, 'user', text, modelId, undefined, inputCost, userMsgId);

	// live window(seq > summary_upto_seq) — 방금 넣은 유저 메시지·오프닝 포함
	const fullWindow = await getWindow(db, session.id, session.summaryUptoSeq);
	// 이어갈 assistant 응답이 하나도 없으면(오프닝 없는 캐릭터의 새 세션) 이어가기 불가.
	if (continueTurn && !fullWindow.some((m) => m.role === 'assistant' && m.content.trim() !== '')) {
		return c.json({ error: 'nothing_to_continue', message: '이어갈 장면이 없어요. 먼저 한마디 보내 주세요.' }, 400);
	}

	// ── CBS 평가 컨텍스트 ── 세션 변수(=기본 변수 시드 ∪ 누적 상태) + 턴 index + 시드 RNG.
	// description→lorebook 순서로 같은 ctx 를 공유해 평가(setvar 변이 전파). 턴 종료 후 영속.
	const ctx: CbsContext = {
		vars: { ...(characterDefaultVars ?? {}), ...(session.scriptState ?? {}) },
		index: userSeq,
		lang: 'ko',
		rng: makeRng(`${session.id}:${userSeq}`),
		now: Date.now()
	};
	const scriptStateBefore = JSON.stringify(session.scriptState ?? {});
	const varsBefore = { ...(session.scriptState ?? {}) };

	// 켜진 모듈(재사용 프롬프트) — 접근 가능한 것(공유 or 본인 소유)만, 클라 순서대로. 프롬프트 맨 끝에 첨부.
	const modules = await getModulesForChat(db, pickModuleIds(body.moduleIds), userId);

	// ── 한 턴 조립(공유 로직) ── system/messages/토큰예산을 한 번에. ctx.vars 는 CBS 로 변이된다.
	// 입력 하드가드(오래된 window trim)·로어북 주입·응답 지침 부착이 모두 여기서 일어난다.
	const assembled = assembleTurn({
		character,
		fullWindow,
		summary: session.summary,
		memory: session.memory,
		userName,
		userPersona,
		modelId,
		maxSentences,
		userActs,
		ctx,
		modules
	});
	const { window, messages, inputTokensEst, outputReserve, inputLimit } = assembled;
	if (assembled.windowTrimmed) {
		console.warn(
			`[chat] input guard trimmed window ${fullWindow.length}→${window.length} (model=${modelId}, limit=${inputLimit})`
		);
	}

	// 디버그 모드면 조립 내부 전체를 스냅샷으로 만들어 메타 프레임에 동봉(아래). varsAfter 는 CBS 평가 직후 상태.
	// 시스템 프롬프트·숨김 카드 내부가 드러나므로 **제작자 본인 또는 관리자**에게만 스냅샷을 내려준다.
	const canDebug = isAdmin(user.email) || character.creator.id === userId;
	const debugSnapshot: ChatDebugSnapshot | null = (body.debug && canDebug)
		? buildSnapshot({
				source: 'live',
				model: modelId,
				assembled,
				character,
				session,
				defaultVars: characterDefaultVars,
				varsBefore,
				varsAfter: { ...ctx.vars },
				userName,
				userPersona,
				summary: session.summary,
				memory: session.memory,
				maxSentences,
				userActs
			})
		: null;

	const gateway = createGateway({ apiKey: gatewayKey });

	// 응답 종료 후 처리(영속화·요약)를 워커 생존 보장 하에 실행.
	const after = getWaitUntil();

	// CBS 평가로 변수 상태가 바뀌었으면(또는 기본변수 첫 시딩) 턴 종료 후 영속.
	if (JSON.stringify(ctx.vars) !== scriptStateBefore) {
		after(updateScriptState(db, session.id, ctx.vars));
	}

	// 턴별 input 토큰을 응답 헤더로 내려준다(추정치). 실측은 onFinish 에서 DB 저장.
	const tokenHeaders = {
		'x-haven-session': session.id,
		'x-haven-input-tokens': String(inputTokensEst),
		'x-haven-input-max': String(inputLimit)
	};

	console.log(
		`[chat] session=${session.id} character=${character.id} model=${modelId} window=${window.length} inputEst=${inputTokensEst} summarized=${session.summaryUptoSeq > 0}${continueTurn ? ' continue=1' : ''}${modules.length ? ` modules=${modules.length}` : ''}`
	);

	// AI SDK v6 의 textStream 은 에러를 throw 하지 않고 빈 스트림으로 끝나므로
	// onError 로 에러를 포착한 뒤, 스트림 종료 후 채팅 버블에 노출한다(디버깅용).
	let streamError: unknown = null;

	const result = streamText({
		model: gateway(modelId),
		// system = [제작자 프롬프트 + 상대 정보 + 가드레일] (고정 prefix)
		//          + (요약 있으면) "지금까지의 이야기" 블록. 요약 갱신 때만 변함 → 대부분 캐시 hit.
		// Gemini 는 XML 프레이밍으로 system 을 첫 user 메시지에 접어 보내므로 undefined(chatAssembly 참고).
		system: assembled.systemForModel,
		// live window 만 전송(오래된 맥락은 summary 가 대체) → input 토큰 상한.
		messages,
		providerOptions: buildProviderOptions(modelId),
		temperature: 0.9,
		// 직전 턴 문단 복사(DeepSeek 계열 장문 반복) 억제. 모델별로 지원되는 경우에만 값이 들어간다.
		...repetitionPenalties(modelId),
		maxOutputTokens: outputReserve,
		onError: ({ error }) => {
			streamError = error;
			console.error(`[chat] streamText error (model=${modelId}):`, error);
			notifyServerError({
				context: 'streamText /api/chat',
				error,
				extra: { model: modelId, session: session!.id, character: character.id, user: userId },
				waitUntil: getWaitUntil()
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
			// 단, editdisplay 표시 카드는 렌더 때 정규식이 `<img="...">` 를 직접 변환하므로 핀하지 않고 원형 보존.
			const clean = character.displayScripts?.length
				? reply.trim()
				: pinSceneCodes(reply.trim(), character.imageSet);
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
					waitUntil: getWaitUntil()
				});
			}
			if (streamError) {
				// 상세 에러는 서버 로그(onError)에만 남기고, 사용자에겐 일반 메시지만 노출.
				// 단, 공급자 일시 과부하(503/"temporarily unavailable")는 모델 교체를 유도하는 안내로 구분.
				controller.enqueue(
					encoder.encode(
						isOverloadError(streamError)
							? '⚠️ 지금 이 모델(AI 공급자)이 일시적으로 과부하 상태예요. 잠시 후 다시 보내거나, 설정(⚙)에서 다른 모델로 바꿔보세요.'
							: isProviderCensorError(streamError)
								? '⚠️ AI 공급자의 콘텐츠 검열에 응답이 차단됐어요. 다시 보내거나, 설정(⚙)에서 다른 모델로 바꿔보세요.'
								: '⚠️ 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
					)
				);
			}
			// 응답 메타(finishReason·usage 등)를 스트림 맨 끝에 sentinel 프레임으로 붙인다.
			// 클라이언트는 이를 떼어 console 에만 찍고 화면엔 렌더하지 않는다.
			// flash 등에서 출력이 잘리는 경우 finishReason='length'/'content-filter' 로 드러난다.
			const meta = await collectMeta(result, modelId, streamError);
			if (debugSnapshot) meta.debug = debugSnapshot;
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
});

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
	if (streamError) meta.streamError = describeStreamError(streamError);
	return meta;
}

/**
 * 스트림 에러를 콘솔 메타용 문자열로. Error 가 아닌 객체(AI_TypeValidationError 의 value 에
 * 공급자 에러 JSON 이 담긴 경우 등)는 String() 이 "[object Object]" 만 남기므로 JSON 으로 편다.
 */
function describeStreamError(e: unknown): string {
	if (e instanceof Error) {
		const cause = (e as { cause?: unknown }).cause;
		const value = (e as { value?: unknown }).value;
		const extra = [cause ? `cause=${safeJson(cause)}` : '', value ? `value=${safeJson(value)}` : '']
			.filter(Boolean)
			.join(' ');
		return `${e.name}: ${e.message}${extra ? ` (${extra})` : ''}`;
	}
	return typeof e === 'string' ? e : safeJson(e);
}

/**
 * 공급자 측 콘텐츠 검열 차단인지(Alibaba `data_inspection_failed` 등).
 * 에러 본문이 스트림 안에 JSON 으로 오면 AI_TypeValidationError.value 에 담기므로 통짜 직렬화로 검사.
 */
function isProviderCensorError(e: unknown): boolean {
	const s = describeStreamError(e).toLowerCase();
	return /data_inspection_failed|inappropriate content|content[_ -]?filter|content_policy|moderation/.test(
		s
	);
}

/**
 * 공급자 일시 과부하/가용성 에러인지(503·"Service temporarily unavailable"·overloaded 등).
 * AI Gateway 가 자동 페일오버/재시도로도 못 살린 경우 → 사용자에게 모델 교체를 안내한다.
 */
function isOverloadError(e: unknown): boolean {
	const err = e as { name?: string; statusCode?: number; message?: string } | undefined;
	const code = err?.statusCode;
	if (typeof code === 'number' && [429, 500, 502, 503, 504, 529].includes(code)) return true;
	const name = err?.name ?? '';
	if (/Gateway(Internal|Timeout|Response)|Overloaded|ServiceUnavailable|RetryError/i.test(name))
		return true;
	const msg = (err?.message ?? '').toLowerCase();
	return /temporarily unavailable|service unavailable|overloaded|try again shortly|rate limit/.test(
		msg
	);
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

/** 클라가 보낸 메시지 id 검증(비어있지 않은 문자열만 채택). 없으면 새 uuid. */
function pickMsgId(requested?: string): string {
	return typeof requested === 'string' && requested.trim() !== ''
		? requested.trim()
		: crypto.randomUUID();
}

// ════════════════════════════════════════════════════════════════════════════
// GET '/recent'  — 사이드바 무한스크롤 (구 chat/recent/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

/** 사이드바 무한스크롤 — 최근 채팅 다음 페이지(커서 기반). 로그인 필수. */
chatRouter.get('/recent', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ chats: [], nextCursor: null, hasMore: false });

	const cursor = parseRecentCursor(c.req.query('cursor') ?? null);
	const page = await loadRecentChats(db, user.id, RECENT_PAGE_SIZE, cursor);
	return c.json(page);
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE '/session'  — 세션 삭제 (구 chat/session/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

interface DeleteSessionBody {
	sessionId: string;
}

/** 사이드바에서 세션 삭제(소유자만). 세션 + 그 메시지를 함께 제거. */
chatRouter.delete('/session', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json()) as DeleteSessionBody;
	if (!body.sessionId) return c.json({ error: 'missing sessionId' }, 400);

	const ok = await deleteSession(db, body.sessionId, user.id);
	if (!ok) return c.json({ error: 'session not found' }, 404);

	return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// GET '/messages' / DELETE '/messages'  — 과거 메시지 페이징/삭제 (구 chat/messages/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

/** 한 번에 가져올 과거 메시지 수(서버 로드 PAGE_SIZE 와 동일). */
const MESSAGES_PAGE_SIZE = 20;

/**
 * 위로 스크롤 시 과거 메시지 페이징 조회.
 * ?sessionId=<id>&before=<seq> → seq 미만에서 최신 PAGE_SIZE 개를 seq 오름차순으로.
 */
chatRouter.get('/messages', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const sessionId = c.req.query('sessionId') ?? null;
	if (!sessionId) return c.json({ error: 'missing sessionId' }, 400);

	// 소유권 확인.
	const session = await getSession(db, sessionId, user.id);
	if (!session) return c.json({ error: 'session not found' }, 404);

	const before = Number(c.req.query('before'));
	const page = await getMessagePage(
		db,
		sessionId,
		MESSAGES_PAGE_SIZE,
		Number.isInteger(before) && before > 0 ? before : undefined
	);

	return c.json({
		messages: page.messages.map((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			cost: m.cost
		})),
		oldestSeq: page.oldestSeq,
		hasMore: page.hasMore
	});
});

interface DeleteMessageBody {
	messageId: string;
}

/** 대화 로그에서 메시지 1건 삭제(소유자만, user/assistant 무관). 실제 DB 행을 제거. */
chatRouter.delete('/messages', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json()) as DeleteMessageBody;
	if (!body.messageId) return c.json({ error: 'missing messageId' }, 400);

	const ok = await deleteMessage(db, body.messageId, user.id);
	if (!ok) return c.json({ error: 'message not found' }, 404);

	return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// POST '/memory'  — 상시 기억 저장 (구 chat/memory/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

interface MemoryBody {
	sessionId: string;
	memory: string;
}

/** 유저가 직접 넣은 "상시 기억" 저장. 빈 값이면 제거. (최대 길이는 서버에서 강제) */
chatRouter.post('/memory', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json()) as MemoryBody;
	if (!body.sessionId) return c.json({ error: 'missing sessionId' }, 400);

	const session = await getSession(db, body.sessionId, user.id);
	if (!session) return c.json({ error: 'session not found' }, 404);

	const saved = await setMemoryText(db, body.sessionId, body.memory ?? '');
	return c.json({ memory: saved });
});

// ════════════════════════════════════════════════════════════════════════════
// GET '/summary' / POST '/summary'  — 요약 조회/수정 (구 chat/summary/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

/** 현재 세션의 최신 요약 조회. (모달 열 때 fresh 값 확보) */
chatRouter.get('/summary', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const sessionId = c.req.query('sessionId') ?? null;
	if (!sessionId) return c.json({ error: 'missing sessionId' }, 400);

	const session = await getSession(db, sessionId, user.id);
	if (!session) return c.json({ error: 'session not found' }, 404);

	// 모달 한 번 열 때 요약·상시 기억을 함께 내려준다(왕복 1회).
	return c.json({ summary: session.summary, memory: session.memory });
});

interface SummaryBody {
	sessionId: string;
	summary: string;
}

/** 유저가 직접 수정한 요약 저장. 빈 값이면 요약 제거(경계 리셋). */
chatRouter.post('/summary', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json()) as SummaryBody;
	if (!body.sessionId) return c.json({ error: 'missing sessionId' }, 400);

	const session = await getSession(db, body.sessionId, user.id);
	if (!session) return c.json({ error: 'session not found' }, 404);

	const saved = await setSummaryText(db, body.sessionId, body.summary ?? '');
	return c.json({ summary: saved });
});

// ════════════════════════════════════════════════════════════════════════════
// GET '/vars' / POST '/vars'  — 디버그 CBS 변수 조회/저장 (구 chat/vars/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 디버그 — 세션 CBS 변수(script_state) 조회/덮어쓰기.
 * 접근: 캐릭터 제작자 본인 또는 관리자(시스템 내부 상태 조작).
 *
 *  GET  ?sessionId=&characterId=  → { vars, defaultVars }
 *  POST { sessionId, characterId, vars } → 저장 후 { vars }
 */

/** 세션 소유 + 디버그 권한 확인. 통과 시 null, 아니면 에러 Response. */
async function varsGuard(
	c: import('hono').Context<AppEnv>,
	db: D1Database,
	userId: string,
	email: string | null,
	characterId: string,
	sessionId: string
): Promise<Response | null> {
	const character = await findCharacter(db, characterId);
	if (!character) return c.json({ error: 'character not found' }, 404);
	const canDebug = isAdmin(email) || character.creator.id === userId;
	if (!canDebug) return c.json({ error: 'forbidden' }, 403);
	const session = await getSession(db, sessionId, userId);
	if (!session) return c.json({ error: 'session not found' }, 404);
	return null;
}

chatRouter.get('/vars', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const sessionId = c.req.query('sessionId') ?? null;
	const characterId = c.req.query('characterId') ?? null;
	if (!sessionId || !characterId) return c.json({ error: 'missing params' }, 400);

	const err = await varsGuard(c, db, user.id, user.email, characterId, sessionId);
	if (err) return err;

	const session = await getSession(db, sessionId, user.id);
	const defaultVars = await getCharacterDefaultVars(db, characterId);
	return c.json({ vars: session?.scriptState ?? {}, defaultVars: defaultVars ?? {} });
});

interface VarsBody {
	sessionId: string;
	characterId: string;
	/** 새 변수 맵 전체(기존을 통째로 대체). 키는 소문자 정규화. */
	vars: Record<string, unknown>;
}

chatRouter.post('/vars', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json()) as VarsBody;
	if (!body.sessionId || !body.characterId) return c.json({ error: 'missing params' }, 400);

	const err = await varsGuard(c, db, user.id, user.email, body.characterId, body.sessionId);
	if (err) return err;

	// 문자열/숫자/불리언만 받아 문자열로 정규화(손상 입력 방어). 키는 소문자.
	const clean: Record<string, string> = {};
	if (body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)) {
		for (const [k, v] of Object.entries(body.vars)) {
			const key = String(k).trim().toLowerCase();
			if (!key) continue;
			if (typeof v === 'string') clean[key] = v;
			else if (typeof v === 'number' || typeof v === 'boolean') clean[key] = String(v);
		}
	}

	await updateScriptState(db, body.sessionId, clean);
	return c.json({ vars: clean });
});

// ════════════════════════════════════════════════════════════════════════════
// POST '/image/prepare' · '/image/commit'  — 실시간 이미지 생성(클라가 NovelAI 직접 호출)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 실시간 이미지 생성(로그인 필수). 채팅에서 "실시간 이미지"가 켜져 있을 때 매 assistant 턴
 * 직후 클라이언트가 호출한다. NovelAI 호출 자체는 **브라우저가 직접**(image.novelai.net 은
 * CORS `*`) 한다 — 수 MB 의 프레임을 Worker 가 파싱/재인코딩하던 CPU 비용을 없애기 위해.
 *
 * 흐름:
 *  1) prepare: 세션 소유권 확인 → 선택된 LLM(기본 google/gemini-3.8-flash)으로 마지막 assistant
 *     응답 → "상황 프롬프트"(구조화 출력, 외형 원장 반영) → 미성년 하드차단 → NovelAI 요청 바디
 *     (positive/char_captions/네거티브/파라미터)를 조립해 반환. 이 LLM 비용(USD)이 메시지 cost.
 *  2) 클라: /api/keys/novelai/token 으로 받은 토큰으로 generate-image-stream(msgpack) 직접 호출,
 *     중간 JPEG 프리뷰 표시, 최종 PNG 를 canvas 로 webp 변환.
 *  3) commit: 이미지 바이너리를 그대로 R2(chatimg/<sessionId>/<id>.<ext>) 저장 + role=image_generation
 *     메시지 영속(재생성이면 같은 행 content 갱신).
 */

const MAX_ASSISTANT_CHARS = 6000;
const MAX_STYLE_CHARS = 1000;
/** 외형 레퍼런스로 넣을 캐릭터 description 최대 길이(자). 토큰·지연 보호용. */
const MAX_DESC_CHARS = 6000;
/** 최근 대화 블록: 메시지 개수·메시지당 길이 상한(토큰·지연 보호용). */
const MAX_RECENT_MSGS = 6;
const MAX_RECENT_MSG_CHARS = 2000;
/** 상황 프롬프트가 낼 인물 상한(모델별 상한은 buildGeneratePayload 가 다시 적용 — V4.5=6, V5=32). */
const MAX_CHARACTERS = 8;
/** 외형 원장 최대 인원. 초과 시 가장 오래 안 나온 인물부터 evict. */
const MAX_LEDGER_ENTRIES = 16;
/** 원장에 박는 고정 외형 태그 최대 길이(자). */
const MAX_APPEARANCE_CHARS = 300;
/** 복장 원장에 박는 복장/노출 상태 태그 최대 길이(자). */
const MAX_OUTFIT_CHARS = 200;
/** 자연어 장면 문장 최대 길이(자). V5 Curated base 예산(~703 토큰)에 그림체+꼬리와 함께 들어가야 해서 짧게. */
const MAX_SCENE_CHARS = 400;

/** 요청의 상황 프롬프트 모델 검증 — 구조화 출력 안정 모델(Gemini 계열)만. 미허용이면 기본 모델. */
function pickPromptModel(requested?: string): string {
	return requested && IMAGE_PROMPT_MODEL_IDS.has(requested)
		? requested
		: DEFAULT_IMAGE_PROMPT_MODEL_ID;
}

/**
 * 구조화 출력 스키마는 `$lib/server/imagePrompt` 의 SCENE_PROMPT_SCHEMA(썸네일과 공용).
 *  - base: 배경·구도·인원수 태그(1girl/2girls/1boy 1girl)·상호작용(source#/target#) 등 전역 캡션.
 *  - scene: **자연어 장면 문장**(1~2문장, 영어). V5 만 조립에 사용(buildPositivePrompt), V4.5 그림체면 버린다.
 *  - characters[]: 화면에 보이는 인물별로 name/appearance/state 분해.
 *    · name: 외형 원장 대조용 안정 식별자(주인공=char, 유저=user, 그 외 in-story 이름/식별자).
 *    · appearance: 고정 외형(머리·눈·체형·고유특징) — 원장에 박아 턴 간 고정.
 *    · state: 가변(현재 복장·노출·표정·포즈) — 매 턴 새로.
 *    인물을 분리하면 NAI 가 인물 간 속성 누출(머리색·옷 bleeding)을 막는다.
 */
/** 해상도(캔버스 방향)에 따른 구도 힌트 — 상황 프롬프트 user 메시지 끝에 부착. */
function canvasHint(resolution: ResolutionKey): string {
	const { width, height } = RESOLUTIONS[resolution];
	if (width > height)
		return `[Canvas] LANDSCAPE ${width}x${height} (wide). Compose horizontally: put "wide shot" or "cowboy shot"/"upper body" with room at the sides, let the background/setting fill the width, and place people side by side rather than stacked. Avoid "full body" standing portraits that would be cropped top/bottom.`;
	if (width === height)
		return `[Canvas] SQUARE ${width}x${height}. Keep the subject centered with balanced margins.`;
	return `[Canvas] PORTRAIT ${width}x${height} (tall). Vertical compositions are fine (full body, standing).`;
}

/**
 * '1명 고정' 힌트 — 상황 프롬프트 user 메시지 끝에 부착. 주인공 1명만 그리게 하고, 상대(유저·NPC)와
 * 상호작용 중이면 POV/프레임 밖 처리로 인원을 늘리지 않게 한다. LLM 이 어겨도 enforceCountBase 가 후처리.
 */
const SOLO_HINT = `[Solo] Depict EXACTLY ONE person. Normally that is the main roleplay character ("char"); if the main character is not an embodied person (AI, voice, narrator, system, object), draw the single most visually important person in this moment instead (e.g. the person being addressed or examined). Output exactly ONE entry in "characters" and put a single-subject count tag ("1girl"/"1boy") plus "solo" in "base". NEVER draw the user or any other person. If that person is interacting with someone, shoot it from the other one's point of view ("pov"; partial-view tags such as "pov hands" are fine) or crop the other person out of frame, and write "scene" about the depicted person alone (what they are doing, where they are looking). Do not use source#/target#/mutual# interaction tags.`;

/**
 * '1명 고정 + 남성 1명 허용' 힌트 — 기본은 주인공 1명이지만, 장면상 상대 남성의 몸이 실제로 프레임에
 * 필요하면(포옹·삽입·애무 등 신체 접촉이 그림의 핵심) 남성 1명(보통 유저/{{나}})만 추가로 허용.
 * 최대 2명·그중 남성은 1명. 어겨도 enforceCountBase/pickSoloEntries 가 후처리.
 */
const SOLO_MALE_HINT = `[Solo+1] Depict the main roleplay character ("char") as the single focus (if the main character is not an embodied person, draw the single most visually important person in this moment instead). By DEFAULT output ONE entry only, shooting any partner from their point of view ("pov"; "pov hands"/"pov crotch" are fine) or cropping them out of frame. ONLY when the latest moment is a close physical interaction where the man's body MUST be in the frame for the picture to make sense (embracing, kissing, sex/penetration, groping, carrying, pinning down), you may ADD exactly ONE male — the male lead, normally the user ("user") or the man she is interacting with — as a second entry, and then use "1boy, 1girl" as the count tag with source#/target#/mutual# interaction tags. NEVER draw a third person, never add a second woman, and never add the man for a mere conversation, walking, or distant scene.`;

/** 외형 캡션의 성별 분류(스키마: appearance 첫 단어가 girl/boy/other, 폴백으로 본문 검색). */
function subjectOf(appearance: string): 'girl' | 'boy' | 'other' {
	const first = appearance.split(',')[0]?.trim().toLowerCase() ?? '';
	if (/^(girl|woman|female)\b/.test(first)) return 'girl';
	if (/^(boy|man|male)\b/.test(first)) return 'boy';
	if (/\b(girl|woman|female)\b/i.test(appearance)) return 'girl';
	if (/\b(boy|man|male)\b/i.test(appearance)) return 'boy';
	return 'other';
}

/**
 * '1명 고정' 인물 선별 — LLM 이 여러 인물을 냈어도 상한만 남긴다. 'char' 를 강제하지 않는 이유 —
 * 주인공이 육체 없는 AI/내레이터형이면 char 엔트리가 기기·물체로 그려진다(태블릿 서기 AI 실측).
 * 누구를 그릴지는 [Solo] 힌트를 받은 LLM 의 선택(첫 엔트리)을 따른다.
 * allowMale 이면 '남성 아닌 첫 인물 + 남성 첫 인물' 최대 2명(원래 순서 유지). 남성 아닌 인물이 없으면 첫 1명.
 */
function pickSoloEntries<T>(entries: T[], appearanceOf: (e: T) => string, allowMale: boolean): T[] {
	if (entries.length <= 1) return entries;
	if (!allowMale) return [entries[0]];
	const primary = entries.find((e) => subjectOf(appearanceOf(e)) !== 'boy');
	if (!primary) return [entries[0]];
	const male = entries.find((e) => e !== primary && subjectOf(appearanceOf(e)) === 'boy');
	return entries.filter((e) => e === primary || e === male);
}

/**
 * '1명 고정' 후처리 — base 의 인원수·다인 태그를 제거하고, 남긴 인물들의 외형에 맞는 count 태그를
 * 앞에 붙인다. 1명이면 "1girl, solo" + 상호작용(source#/target#) 태그 제거, 2명이면 "1boy, 1girl"
 * (상호작용 태그는 유지 — 두 사람의 동작 지정에 필요).
 */
function enforceCountBase(base: string, appearances: string[]): string {
	const single = appearances.length <= 1;
	const tags = base
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean)
		.filter(
			(t) =>
				!/^\d+\+?\s*(girl|boy|other)s?$/i.test(t) &&
				!(single && /^(source|target|mutual)#/i.test(t)) &&
				!/^(solo|multiple (girls|boys|others)|couple|group|duo|trio)$/i.test(t)
		);
	const subjects = (appearances.length ? appearances : ['']).map(subjectOf);
	const count = (k: 'girl' | 'boy' | 'other') => subjects.filter((x) => x === k).length;
	const head: string[] = [];
	for (const k of ['boy', 'girl', 'other'] as const) {
		const n = count(k);
		if (n === 1) head.push(`1${k}`);
		else if (n > 1) head.push(`${n}${k}s`);
	}
	if (!head.length) head.push('1other');
	if (single) head.push('solo');
	return [...head, ...tags].join(', ');
}

const SITUATION_SYSTEM = [
	`You convert the latest moment of a Korean roleplay scene into a structured image-generation prompt for NovelAI Diffusion (V4.5/V5, anime illustration), using its MULTI-CHARACTER feature.`,
	`You are given a [Character] reference sheet for the main roleplay character, an optional [Known characters] roster of people whose fixed appearance was already established earlier in this story, an optional [Current outfits] record of what each person was wearing (or not wearing) as of the PREVIOUS image, and the [Recent conversation] (the last few turns, oldest to newest, including the user's actions). Depict ONLY the LATEST moment — the final line of the conversation; use the earlier lines purely as context for what is happening right now. Ignore non-visual text (personality, backstory, rules, command/keyword lists) — use it ONLY for fixed physical appearance.`,
	``,
	`Output a JSON object with three keys:`,
	`  "base": string  — Danbooru-style tags for everything that is NOT an individual character's body/clothes: the SUBJECT COUNT tag (e.g. "1girl", "1boy, 1girl", "2girls"), framing/composition (e.g. "upper body", "cowboy shot", "full body", "from above", "pov"), setting/background, lighting and mood, and INTERACTION action tags between characters using the "source#"/"target#"/"mutual#" prefixes (e.g. "source#hug" on the initiator's intent, "target#hug", "mutual#kiss"). Lowercase, comma-separated.`,
	`  "scene": string — ONE or TWO plain-English sentences describing the same moment in natural language: who is doing what to whom, where each person is relative to the other and to the setting, where they are looking, and the mood. This complements the tags (the model reads both). Refer to people ONLY by role nouns ("the woman", "the man", "the waitress") — NEVER mention hair, eyes, body type, or clothing here (those belong to the character entries). Do not restate the count tag or camera tags. Example: "The woman straddles the man on the sofa, gripping his collar and staring down at him with a smirk while he leans back against the cushions."`,
	`  "characters": array — one entry per person VISIBLE in the frame, ordered top-to-bottom / left-to-right. Each entry is { "name", "appearance", "outfit", "state" }:`,
	`    - "name": a STABLE identifier for this person, used to keep their look consistent across images. Use the literal "char" for the main roleplay character ({{char}}), and the literal "user" for the user/{{나}}. For anyone else, if they are the SAME person as someone in [Known characters], reuse that EXACT name; otherwise assign a short identifier (their in-story name if any, else a concise descriptor like "waitress").`,
	`    - "appearance": that person's FIXED physical look as Danbooru tags only, in THIS order — an UNNUMBERED subject word ("girl"/"boy"/"other"), then a body-type class if any (e.g. "mature female", "petite"), then hair color/length/style, eye color, skin, finer body details visible through clothing (e.g. "narrow waist", "large breasts"), and distinctive PERMANENT features that show while dressed (face/neck/arm/hand marks, horns, heterochromia…). NEVER put clothing, expression, pose, or covered-by-clothing details here. For "char" use the [Character] reference. For a person listed in [Known characters], COPY their recorded appearance verbatim. For a brand-new person, invent a plausible consistent appearance.`,
	`    - "outfit": that person's clothing or state of undress RIGHT NOW as tags (e.g. "fully clothed, white blouse, pencil skirt", "white blouse, unbuttoned, no bra", "naked, towel", "topless, skirt pulled up, no panties"). Follow the Outfit continuity rules below — this carries over between images. Lowercase, comma-separated.`,
	`    - "state": that person's pose and expression in the latest moment, in THIS order: framing of this person if notable (e.g. "from side") → pose/action from the largest movement to the smallest → expression from the overall emotion to details (e.g. "smile, open mouth, half-closed eyes, looking at viewer"). NO clothing here (that is "outfit"). Mostly tags, but a SHORT clause is fine where a tag is awkward (e.g. "leaning over the desk", "looking back over her shoulder", "one hand on his chest"). Lowercase, comma-separated.`,
	``,
	`Character rules:`,
	`- "appearance" must stay identical for the same person across turns (that is what keeps images consistent); "outfit" changes only when the story changes it; "state" follows the latest scene.`,
	`- Include the user ("user") as a SEPARATE entry ONLY if they are physically in the frame in this moment (e.g. the two are embracing, the user's body is shown). For typical 1:1 POV shots where only the character is depicted, output just one entry.`,
	`- If the main roleplay character is NOT an embodied person — a disembodied AI, a voice, a narrator/game master, a system, a device or an object — do NOT create a character entry for it and never invent a body for it. Depict the actual people present in the scene instead (e.g. the person being addressed or examined), and mention the device/object only in "base"/"scene" as part of the setting if it matters. Character entries are for human(oid) people only.`,
	`- The subject COUNT tag in "base" must match the number of character entries (1 entry → "1girl" or "1boy"; 2 entries → e.g. "1boy, 1girl").`,
	`- Put per-person body/clothes ONLY in "appearance"/"outfit"/"state", never in "base" or "scene". Put the count tag ONLY in "base", never in a character entry.`,
	HIDDEN_FEATURE_RULE,
	``,
	`Outfit continuity rules:`,
	`- [Current outfits] is the truth at the START of this moment: it records each person's clothing/undress state as of the previous image (by "name"). For a listed person, COPY that outfit VERBATIM into "outfit" unless the [Recent conversation] AFTER that point explicitly changes it — someone puts on, takes off, opens, unbuttons, lifts, pulls aside/down, tears or changes a garment (update ONLY the affected garments and keep the rest), or the scene clearly moved to a new time or place where they would have dressed again (then describe the new outfit).`,
	`- A person recorded as undressed (naked, topless, bottomless, no bra, no panties, clothes pulled aside, etc.) STAYS that way until the text says they get dressed or cover up. NEVER re-dress someone just because the latest lines do not mention clothes — silence means NO change. Do not soften or omit an undress state that is still in effect.`,
	`- For a person NOT in [Current outfits], derive the outfit from the text; if the text never describes it, use the default outfit from the reference (or a plausible one) starting with "fully clothed".`,
	``,
	`General rules:`,
	`- English only. Focus on the single most recent visual beat, not the whole history.`,
	`- "base", "appearance", "outfit" and "state" are tag lists; "scene" is the only place for full sentences.`,
	`- Do NOT copy the status window, stat block, or any prompt/instruction text from the input — write your own concise tags.`,
	`- Do NOT include quality boosters, artist names, "masterpiece", resolution tags, "rating:" tags, or negative terms — those are added separately.`,
	`- Keep it concise (combined budget is small): "base" short, "scene" at most two sentences, each character under ~40 tags.`,
	`- NSFW content is allowed and should be described plainly when present.`,
	ADULT_ONLY_RULE
].join('\n');

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

/** 복장 원장을 LLM 주입용 [Current outfits] 블록으로. 비면 빈 문자열. */
function buildOutfitBlock(ledger: OutfitLedger): string {
	const lines = Object.entries(ledger).map(([name, e]) => `- ${name}: ${e.outfit}`);
	return lines.length ? `[Current outfits]\n${lines.join('\n')}` : '';
}

/** 원장 상한 초과 시 가장 오래 안 나온 항목부터 제거(LRU evict). 변경 여부 반환. */
function evictLedger(ledger: Record<string, { lastSeen: number }>, max: number): boolean {
	const names = Object.keys(ledger);
	if (names.length <= max) return false;
	names
		.sort((a, b) => ledger[a].lastSeen - ledger[b].lastSeen)
		.slice(0, names.length - max)
		.forEach((n) => delete ledger[n]);
	return true;
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
	/** NovelAI 생성 모델 id(선택한 그림체에 박힌 값, `lib/naiModels.ts` 허용목록 검증). 없으면 기본. */
	naiModel?: string;
	/** 그림체의 선택 네거티브/퀄리티 프롬프트(`art_styles.negative/quality`). 비면 모델별 고정값. */
	styleNegative?: string | null;
	styleQuality?: string | null;
	/** 재생성: 이 image_generation 메시지를 제자리(같은 행/순서)에서 덮어쓴다. */
	replaceId?: string;
	/** 1명 고정: 주인공 1명만 그린다(여러 인물이 나오면 NAI 디테일이 깨지는 것 방지). */
	solo?: boolean;
	/** 1명 고정 중 '남성 1명 추가 허용': 신체 접촉 장면이면 상대 남성(보통 유저) 1명까지 함께 그린다. */
	soloMale?: boolean;
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


/** 에러를 로그용 한 줄로: `Name: message` + cause·statusCode·responseBody(있으면). */
function describeError(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	const parts = [`${e.name}: ${e.message}`];
	const x = e as Error & {
		statusCode?: number;
		responseBody?: string;
		finishReason?: string;
		cause?: unknown;
	};
	if (x.finishReason) parts.push(`finish=${x.finishReason}`);
	if (x.statusCode) parts.push(`status=${x.statusCode}`);
	if (x.responseBody) parts.push(`body=${String(x.responseBody).slice(0, 500)}`);
	if (x.cause instanceof Error) parts.push(`cause=${x.cause.name}: ${x.cause.message}`);
	return parts.join(' | ');
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
				console.warn(`[chat/image] 상황 프롬프트 일시적 에러 — 재시도 ${i + 1}/${retries}:`, describeError(e));
				await new Promise((r) => setTimeout(r, 500 * (i + 1)));
				continue;
			}
			throw e;
		}
	}
	throw lastErr;
}


/**
 * prepare 응답 — 클라가 NovelAI 를 직접 호출하는 데 필요한 것만 돌려준다.
 * (NovelAI 요청 바디는 서버가 조립: 네거티브·파라미터·NSFW 판정 정책을 서버에 둔다)
 */
chatRouter.post('/image/prepare', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'storage unavailable' }, 500);

	const body = (await c.req.json().catch(() => null)) as ImageRequestBody | null;
	const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
	if (!sessionId) return c.json({ error: 'session required' }, 400);

	const session = await getSession(db, sessionId, user.id);
	if (!session) return c.json({ error: 'session not found' }, 404);

	// 재생성 대상(있으면): 소유·세션·역할 검증(commit 에서 다시 검증하지만 여기서 빨리 거른다).
	const replaceId = typeof body?.replaceId === 'string' ? body.replaceId : '';
	const solo = body?.solo === true; // 1명 고정
	const soloMale = solo && body?.soloMale === true; // 1명 고정 + 필요시 남성 1명 추가
	if (replaceId) {
		const target = await getOwnedMessage(db, replaceId, user.id);
		if (!target || target.sessionId !== sessionId || target.role !== 'image_generation') {
			return c.json({ error: 'message not found' }, 404);
		}
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
	if (!assistantText) return c.json({ error: 'empty assistant text' }, 400);

	// 최근 대화 블록(유저 입력 포함) — 그릴 순간의 맥락. 화자 라벨은 유저=페르소나/이름, 캐릭터=이름.
	const userLabel = user.personaName?.trim() || user.name?.trim() || '나';
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
	// 그림체에 박힌 NovelAI 모델(허용목록 검증). 그림체 세대에 맞는 params_version·퀄리티 꼬리로 조립된다.
	const naiModel = pickNaiModel(body?.naiModel);
	const naiParams = imageParamsFor(naiModel);
	// 그림체의 선택 네거티브/퀄리티(비면 모델별 고정값). 퀄리티는 positive 꼬리 대체, 네거티브는 아동 차단 접두 뒤 대체.
	const styleNegative = (body?.styleNegative ?? '').slice(0, MAX_STYLE_CHARS);
	const styleQuality = (body?.styleQuality ?? '').slice(0, MAX_STYLE_CHARS);

	// NovelAI 키 등록 여부만 확인(평문은 /api/keys/novelai/token 으로 클라가 별도 수령).
	if (!(await getKeyStatus(db, user.id, 'novelai')).registered) {
		return c.json(
			{ error: 'no_key', message: 'NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.' },
			400
		);
	}

	// ── 1) Gemini 상황 프롬프트 (필수) ──
	// 상황 프롬프트 생성이 실패/빈값이면 NovelAI 요청을 보내지 않는다(Anlas·비용 낭비 방지).
	// 상황 프롬프트 LLM 도 유저 본인 Gateway 키로(BYO). 없으면 거부(예외 없음).
	const apiKey = await getDecryptedKey(db, user.id, 'gateway');
	if (!apiKey) {
		return c.json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			400
		);
	}

	// 외형 원장(세션 누적) — 동적 NPC 외형 고정용. 작업 사본으로 변이 후, 변경 시 응답 전에 영속.
	const ledger: AppearanceLedger = { ...(session.appearances ?? {}) };
	let ledgerDirty = false;
	const knownBlock = buildKnownBlock(ledger); // LLM 주입용 [Known characters] 블록
	// 복장 원장(세션 누적) — 인물별 현재 복장/노출 상태. 주인공·유저 포함. 이전 이미지 시점 값을 주입하고
	// LLM 이 "텍스트가 바꾸지 않으면 그대로 복사"한 결과를 다시 저장해 옷 상태를 턴 간 이어 간다.
	// 재생성(replaceId)은 과거 시점 그림일 수 있어 원장을 읽기만 하고 갱신하지 않는다.
	const outfits: OutfitLedger = { ...(session.outfits ?? {}) };
	let outfitsDirty = false;
	const outfitBlock = buildOutfitBlock(outfits); // LLM 주입용 [Current outfits] 블록

	// 디버그(요청자가 debug 모드일 때만)용 진단값 누적 — 성공·실패 양쪽에서 동봉한다.
	let situation = ''; // base 와 인물 캡션을 ' | ' 로 합친 표시용
	let baseScene = '';
	let sceneText = ''; // 자연어 장면 문장(V5 전용)
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
					currentOutfits: outfitBlock,
					situation,
					baseScene,
					scene: sceneText,
					characters: charCaptions,
					rawSituation,
					finishReason,
					warnings,
					llmError,
					stylePrompt,
					positive,
					negative: negativeFor(naiModel, styleNegative),
					model: naiModel,
					resolution,
					solo,
					soloMale,
					params: {
						sampler: naiParams.sampler,
						scheduler: naiParams.scheduler,
						steps: naiParams.steps,
						cfgScale: naiParams.cfgScale,
						cfgRescale: naiParams.cfgRescale
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
		if (outfitBlock) promptParts.push(outfitBlock);
		promptParts.push(sceneBlock);
		// 캔버스 방향 힌트(system 은 고정 prefix 라 user 쪽에 붙임). 가로형이면 옆으로 넓은 구도를 유도.
		promptParts.push(canvasHint(resolution));
		if (solo) promptParts.push(soloMale ? SOLO_MALE_HINT : SOLO_HINT);
		const userPrompt = promptParts.join('\n\n');
		// 게이트웨이가 일시적 503/500 을 자동 재시도하지 않으므로 직접 백오프 재시도한다.
		const result = await generateObjectWithRetry({
			model: gateway(promptModel),
			schema: SCENE_PROMPT_SCHEMA,
			system: SITUATION_SYSTEM,
			prompt: userPrompt,
			temperature: 0.7,
			// 상황 프롬프트는 단순 태그 변환이라 thinking 을 끈다(지연·빈응답 감소). 그래도 thinking 을
			// 못 끄는 모델 대비 headroom 은 남겨 둔다(maxOutputTokens 는 상한이라 지연엔 영향 없음).
			maxOutputTokens: 2000 + reasoningHeadroom(promptModel),
			providerOptions: buildProviderOptions(promptModel, { noThinking: true })
		});
		const obj = (result.object ?? {}) as { base?: unknown; scene?: unknown; characters?: unknown };
		rawSituation = JSON.stringify(obj);
		// base·각 인물 캡션을 필드별로 한글/잡음 제거(모델이 상태창을 베껴 넣어도 영어 태그만 남김).
		baseScene = sanitizeSituation(str(obj.base));
		sceneText = sanitizeScene(str(obj.scene)).slice(0, MAX_SCENE_CHARS);

		// 인물별: name 으로 원장 대조 → 기존이면 외형 고정(override), 신규면 핀. 최종 캡션 = 외형 + 상태.
		const turnRef = session.messageCount;
		let rawChars = (Array.isArray(obj.characters) ? obj.characters : []).slice(0, MAX_CHARACTERS);
		// 1명 고정: LLM 이 여러 인물을 냈어도 상한만 남긴다(남성 허용이면 주인공 + 남성 1명까지).
		if (solo) {
			rawChars = pickSoloEntries(
				rawChars,
				(e) => str((e as { appearance?: unknown })?.appearance),
				soloMale
			);
		}
		charCaptions = [];
		for (const cc of rawChars) {
			const entry = cc as { name?: unknown; appearance?: unknown; outfit?: unknown; state?: unknown };
			const cleanState = sanitizeSituation(str(entry.state));
			const outfit = sanitizeSituation(str(entry.outfit)).slice(0, MAX_OUTFIT_CHARS);
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
			// 복장 원장: 이번 턴 복장을 name 별로 기록(주인공·유저 포함). 재생성이면 저장 안 함.
			if (key && outfit && !replaceId && outfits[key]?.outfit !== outfit) {
				outfits[key] = { outfit, lastSeen: turnRef };
				outfitsDirty = true;
			}
			// 옷 입은 장면이면 가려지는 특징(유두·음모·배 문신 등)을 캡션에서 뺀다 — 원장 외형에도 적용.
			// 노출 판정은 outfit+state 합본으로. 캡션 = 외형 + 복장 + 포즈/표정.
			const caption = [stripHiddenFeatures(appearance, `${outfit}, ${cleanState}`), outfit, cleanState]
				.filter(Boolean)
				.join(', ');
			if (caption) charCaptions.push(caption);
		}

		// 1명 고정: base 의 인원수·상호작용 태그를 남긴 인원 기준으로 정리("1girl, solo, …" / "1boy, 1girl, …").
		if (solo) baseScene = enforceCountBase(baseScene, charCaptions);

		// 원장 상한 초과 시 가장 오래 안 나온 인물부터 제거(LRU evict).
		if (evictLedger(ledger, MAX_LEDGER_ENTRIES)) ledgerDirty = true;
		if (evictLedger(outfits, MAX_LEDGER_ENTRIES)) outfitsDirty = true;

		// 표시용 합본(디버그 패널·빈값 판정). base·자연어 장면·인물 캡션을 ' | ' 로 잇는다.
		situation = [baseScene, sceneText, ...charCaptions].filter(Boolean).join(' | ');
		finishReason = (result.finishReason as string | undefined) ?? null;
		warnings = result.warnings ?? [];
		cost = parseGatewayCost(result.providerMetadata);
	} catch (e) {
		// Workers 로그는 Error 객체를 스택만 남기고 직렬화하므로 name/message/cause 를 문자열로 남긴다.
		llmError = describeError(e);
		console.error(`[chat/image] situation prompt error (model=${promptModel}):`, llmError);
		notifyServerError({
			context: 'generateObject /api/chat/image/prepare',
			error: e,
			extra: { session: sessionId, user: user.id, model: promptModel },
			waitUntil: getWaitUntil()
		});
		return c.json(
			{
				error: 'situation',
				message: '상황 프롬프트 생성에 실패해 이미지를 생성하지 않았습니다.',
				debug: makeDebug(null)
			},
			502
		);
	}

	// 빈 상황 프롬프트(모델이 아무것도 못 냄·안전필터 차단 등) → NovelAI 호출하지 않음.
	if (!situation) {
		console.warn(
			`[chat/image] 상황 프롬프트가 비어 있음 (model=${promptModel}, finishReason=${finishReason}) — NovelAI 요청 생략`
		);
		return c.json(
			{
				error: 'situation',
				message: `상황 프롬프트가 비어 있어 이미지를 생성하지 않았습니다.${finishReason && finishReason !== 'stop' ? ` (finishReason=${finishReason})` : ''}`,
				debug: makeDebug(null)
			},
			502
		);
	}

	// base_caption = 인원수 + 그림체 + base 장면 태그 + 자연어 장면(V5) + 퀄리티 꼬리(+nsfw). 인물 외형은 char_captions 로 분리.
	// 자연어 장면은 positive 에 합쳐지므로 아래 미성년 하드차단이 같이 검사한다.
	const positive = buildPositivePrompt(stylePrompt, baseScene, isNsfw, naiModel, sceneText, styleQuality);

	// ── 하드 차단 ── 최종 프롬프트에 미성년/아동 코드 용어가 있으면 NovelAI 호출 없이 거부(fail-closed).
	// 한국법(가상 아동성착취물 형사처벌) 대응의 최종 게이트 — LLM 지시·네거티브와 별개의 결정적 방어선.
	// base 와 모든 인물 캡션을 합쳐 검사한다(인물 캡션에 들어간 용어도 잡아야 함).
	if (containsMinorTerms([positive, ...charCaptions].join(', '))) {
		console.warn(`[chat/image] minor-term hard block (user=${user.id}, session=${sessionId})`);
		notifyServerError({
			context: 'minor-term hard block /api/chat/image/prepare',
			error: new Error('blocked: minor term in image prompt'),
			extra: { session: sessionId, user: user.id },
			waitUntil: getWaitUntil()
		});
		return c.json(
			{ error: 'blocked', message: '생성할 수 없는 내용이 포함되어 있어 이미지를 만들지 않았습니다.', debug: makeDebug(positive) },
			422
		);
	}

	// 외형·복장 원장 변경분 영속 — 다음 턴 일관성. 응답 전에 inline 저장(빠른 재요청 레이스 방지).
	if (ledgerDirty || outfitsDirty) {
		try {
			await updateImageLedgers(db, sessionId, { appearances: ledger, outfits });
		} catch (e) {
			console.warn('[chat/image] 이미지 원장 저장 실패(무시):', String(e));
		}
	}

	const res: ImagePrepareResponse = {
		payload: buildGeneratePayload(positive, charCaptions, resolution, naiModel, styleNegative),
		cost: cost ?? null,
		debug: makeDebug(positive)
	};
	return c.json(res);
});

/** commit 이 받는 이미지 MIME → R2 확장자. 그 외는 거부. */
const COMMIT_EXT: Record<string, 'webp' | 'png' | 'jpg'> = {
	'image/webp': 'webp',
	'image/png': 'png',
	'image/jpeg': 'jpg'
};
/** commit 바디 상한(bytes). 1024×1024 PNG 도 넉넉히 들어오는 크기. */
const COMMIT_MAX_BYTES = 12 * 1024 * 1024;

/**
 * 최종 이미지 바이트를 R2 에 저장하고 image_generation 메시지를 영속한다.
 * 메타는 쿼리(sessionId·replaceId·assistantMsgId·cost), 바디는 이미지 바이너리 그대로(JSON/base64 없음).
 */
chatRouter.post('/image/commit', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const bucket = c.env.IMAGES;
	if (!db || !bucket) return c.json({ error: 'storage unavailable' }, 500);

	const sessionId = c.req.query('sessionId') ?? '';
	if (!sessionId) return c.json({ error: 'session required' }, 400);
	const session = await getSession(db, sessionId, user.id);
	if (!session) return c.json({ error: 'session not found' }, 404);

	const contentType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
	const ext = COMMIT_EXT[contentType];
	if (!ext) return c.json({ error: 'unsupported image type' }, 415);
	const declared = Number(c.req.header('content-length') ?? '0');
	if (declared > COMMIT_MAX_BYTES) return c.json({ error: 'image too large' }, 413);
	const bytes = await c.req.raw.arrayBuffer();
	if (bytes.byteLength === 0) return c.json({ error: 'empty body' }, 400);
	if (bytes.byteLength > COMMIT_MAX_BYTES) return c.json({ error: 'image too large' }, 413);

	// 재생성 대상(있으면): 소유·세션·역할 검증. 통과 시 같은 행의 content 만 새 키로 갱신한다.
	let replaceMsgId: string | null = null;
	let oldImageKey: string | null = null;
	const replaceId = c.req.query('replaceId') ?? '';
	if (replaceId) {
		const target = await getOwnedMessage(db, replaceId, user.id);
		if (!target || target.sessionId !== sessionId || target.role !== 'image_generation') {
			return c.json({ error: 'message not found' }, 404);
		}
		replaceMsgId = target.id;
		oldImageKey = target.content || null;
	}
	const assistantMsgId = c.req.query('assistantMsgId') ?? '';
	const costRaw = Number(c.req.query('cost') ?? '');
	const cost = Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : undefined;

	// R2 키는 항상 새 무작위 id 로 만든다 — 재생성 때 같은 키를 덮어쓰면 /img 의 1일 캐시·엣지
	// 캐시가 옛 이미지를 계속 서빙하므로(URL 동일), 새 키로 만들어 캐시 충돌을 피한다.
	const keyId = crypto.randomUUID();
	const key = `chatimg/${sessionId}/${keyId}.${ext}`;
	try {
		await bucket.put(key, bytes, { httpMetadata: { contentType } });
	} catch (e) {
		console.error('[chat/image] R2 put 실패:', e);
		return c.json({ error: 'storage', message: '이미지 저장에 실패했습니다.' }, 500);
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
			for (let i = 0; i < 120 && !(await messageExists(db, assistantMsgId, sessionId)); i++) {
				await new Promise((r) => setTimeout(r, 250));
			}
		}
		await appendMessage(db, sessionId, 'image_generation', key, undefined, undefined, cost, keyId);
	}
	// id = 클라가 매칭할 메시지 행 id (재생성이면 기존 행, 신규면 키 id 와 동일).
	const res: ImageCommitResponse = { id: replaceMsgId ?? keyId, key, cost: cost ?? null };
	return c.json(res);
});

// ════════════════════════════════════════════════════════════════════════════
// POST '/inspect'  — 디버그 드라이런 (구 chat/inspect/+server.ts)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 디버그 드라이런 — 모델 호출·DB 영속 없이, "지금 보내면 어떤 프롬프트가 나가는지"를 조립해 반환한다.
 * 디버그 패널이 변수/요약/기억을 손본 뒤 또는 다음 입력을 미리보기 위해 호출한다.
 *
 * 접근: 캐릭터 제작자 본인 또는 관리자만(시스템 프롬프트·숨김 카드 노출 방지).
 * 부수효과 없음(scriptState 미저장) — ctx 는 throwaway.
 */
interface InspectBody {
	characterId: string;
	/** 있으면 그 세션 상태로, 없으면 새 세션(오프닝)으로 미리보기. */
	sessionId?: string;
	/** 다음에 보낼 유저 메시지(미리보기용, 선택). window 끝에 가상으로 덧붙인다. */
	text?: string;
	openingIndex?: number;
	model?: string;
	maxSentences?: number;
	userActs?: number;
	/** 저장하지 않고 이 변수로 평가해 미리보기(변수 조작 실험용). */
	varsOverride?: Record<string, string>;
	/** 켜진 모듈 id 목록(/api/chat 과 동일 규칙). */
	moduleIds?: string[];
}

/** 클라가 보낸 모듈 id 목록 정규화 — 문자열만·중복 제거·상한(MAX_ACTIVE_MODULES). 순서 유지. */
function pickModuleIds(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== 'string' || !x || x.length > 64 || out.includes(x)) continue;
		out.push(x);
		if (out.length >= MAX_ACTIVE_MODULES) break;
	}
	return out;
}

/** 클라가 보고한 비용(USD)을 검증 — 유한·0 초과·상식적 상한(1턴 $1) 안일 때만 채택. */
function clampReportedCost(v: unknown): number | undefined {
	if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) return undefined;
	return v;
}

// ════════════════════════════════════════════════════════════════════════════
// POST '/rewrite' — 입력 필터: 유저 입력을 지정 문체·뉘앙스로 변환(캐릭터·최근 대화 맥락 참고)
// ════════════════════════════════════════════════════════════════════════════

/** 필터 지시문 상한(한 줄). */
const MAX_FILTER_CHARS = 300;
/** 참고용 캐릭터 설정 상한(문체·호칭 맞추기용이라 통짜 전부는 불필요). */
const REWRITE_MAX_DESC_CHARS = 6000;
/** 참고용 최근 대화 — 최근 N 개, 각 메시지 글자 상한. */
const REWRITE_RECENT_MSGS = 8;
const REWRITE_RECENT_MSG_CHARS = 1500;
/** 변환 출력 상한(원문 ≤ 4000 토큰이므로 넉넉히). */
const REWRITE_MAX_OUTPUT_TOKENS = 3000;

function buildRewriteSystem(args: {
	filter: string;
	character: Character;
	userLabel: string;
	userPersona: string | null;
	summary: string | null;
	recent: Array<{ role: string; content: string }>;
}): string {
	const { filter, character, userLabel, userPersona, summary, recent } = args;
	const lines: string[] = [
		`너는 캐릭터 롤플레이 채팅의 '입력 필터'다. 사용자("${userLabel}")가 캐릭터("${character.name}")에게 보내려고 방금 쓴 입력문을, 아래 변환 지시에 맞는 문체·어조·뉘앙스로 다시 쓴다.`,
		``,
		`# 변환 지시`,
		filter,
		``,
		`# 규칙`,
		`- 원문의 의도·행동·대사·정보(무엇을 하고, 무엇을 말하고, 무엇을 묻는지)는 빠짐없이 보존한다. 새 사건·설정·인물을 지어내거나 원문에 없는 행동을 추가하지 않는다.`,
		`- 상대 캐릭터("${character.name}")의 반응·대사·행동을 대신 쓰지 않는다. 이건 사용자 쪽 입력이다.`,
		`- 인칭·시점은 원문을 따른다(1인칭이면 1인칭, 행동 지시문 형식이면 지시문 형식). 원문에서 사용자를 가리키는 말은 그대로 사용자를 가리켜야 한다.`,
		`- 분량은 원문과 비슷하게 유지한다(최대 1.5배). 원문이 한 줄이면 한두 줄로.`,
		`- 대사는 큰따옴표("…")로, 행동·서술은 산문으로 쓴다. 원문이 괄호 ( ) 나 *…* 지시문 형식을 쓰면 그 형식을 유지한다.`,
		`- 아래 캐릭터 설정·최근 대화는 문체·호칭·상황(누가 누구에게, 어떤 관계·장면인지)을 맞추기 위한 참고일 뿐이다. 거기에 답하거나 이야기를 이어 쓰지 마라.`,
		`- 모든 등장인물은 만 18세 이상 성인으로 간주한다. 미성년자에 대한 성적·선정적 표현은 어떤 경우에도 만들지 않는다.`,
		`- 출력은 변환된 입력문 본문만. 설명·머리말·따옴표로 전체 감싸기·코드블록 금지.`,
		``,
		`# 캐릭터 설정 (참고)`,
		personalize(character.description, character.name, userLabel).trim().slice(0, REWRITE_MAX_DESC_CHARS) ||
			'(설정 없음)',
		``,
		`# 사용자 정보`,
		`- 이름: ${userLabel}`
	];
	if (userPersona && userPersona.trim()) lines.push(`- 페르소나: ${userPersona.trim()}`);
	if (summary && summary.trim()) {
		lines.push(``, `# 지금까지의 이야기 (요약)`, summary.trim());
	}
	if (recent.length > 0) {
		lines.push(``, `# 최근 대화 (참고, 오래된 것부터)`);
		for (const m of recent) {
			const who = m.role === 'user' ? userLabel : character.name;
			const body = m.content.length > REWRITE_RECENT_MSG_CHARS
				? '…' + m.content.slice(-REWRITE_RECENT_MSG_CHARS)
				: m.content;
			lines.push(`[${who}]`, body, ``);
		}
	}
	return lines.join('\n');
}

chatRouter.post('/rewrite', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const gatewayKey = await getDecryptedKey(db, user.id, 'gateway');
	if (!gatewayKey) {
		return c.json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			400
		);
	}

	const body = (await c.req.json()) as RewriteRequestBody;
	const text = (body.text ?? '').trim();
	const filter = (body.filter ?? '').trim().slice(0, MAX_FILTER_CHARS);
	if (!text) return c.json({ error: 'empty message' }, 400);
	if (!filter) return c.json({ error: 'empty filter', message: '필터 지시가 비어 있어요.' }, 400);
	if (estimateTokens(text) > MAX_USER_MSG_TOKENS) return c.json({ error: 'message too long' }, 413);

	const character = await findCharacter(db, body.characterId);
	if (!character) return c.json({ error: 'character not found' }, 404);
	if (character.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw != null) character.description = raw;
	}

	const userLabel = (user.personaName && user.personaName.trim()) || user.name || '나';
	const modelId = pickModel(body.model);

	// 맥락: 세션이 있으면 live window 의 꼬리(최근 N 개) + 요약, 없으면 오프닝만.
	let summary: string | null = null;
	let recent: Array<{ role: string; content: string }> = [];
	if (body.sessionId) {
		const session = await getSession(db, body.sessionId, user.id);
		if (!session) return c.json({ error: 'session not found' }, 404);
		summary = session.summary;
		const win = await getWindow(db, session.id, session.summaryUptoSeq);
		recent = win.slice(-REWRITE_RECENT_MSGS).map((m) => ({ role: m.role, content: m.content }));
	} else {
		const opening = personalize(openingContent(character, body.openingIndex), character.name, userLabel);
		if (opening.trim()) recent = [{ role: 'assistant', content: opening }];
	}

	const system = buildRewriteSystem({
		filter,
		character,
		userLabel,
		userPersona: user.persona,
		summary,
		recent
	});
	const gateway = createGateway({ apiKey: gatewayKey });

	try {
		const result = await generateText({
			model: gateway(modelId),
			system,
			messages: [{ role: 'user', content: `다음 입력문을 변환 지시에 맞게 다시 써라. 변환된 본문만 출력.\n\n<입력문>\n${text}\n</입력문>` }],
			providerOptions: buildProviderOptions(modelId, { noThinking: true }),
			temperature: 0.8,
			maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS + reasoningHeadroom(modelId),
			maxRetries: 1
		});
		const out = stripWrapping(result.text);
		if (!out) {
			console.warn(`[rewrite] empty output model=${modelId} finish=${result.finishReason}`);
			return c.json(
				{ error: 'empty_output', message: '모델이 변환 결과를 내지 않았어요. 다른 모델로 바꾸거나 다시 시도해 주세요.' },
				502
			);
		}
		const cost = parseGatewayCost(result.providerMetadata) ?? null;
		console.log(
			`[rewrite] model=${modelId} in=${result.usage?.inputTokens ?? 0} out=${result.usage?.outputTokens ?? 0} cost=${cost ?? '-'} chars=${text.length}→${out.length}`
		);
		const res: RewriteResponse = { text: out, cost };
		return c.json(res);
	} catch (e) {
		console.error(`[rewrite] failed model=${modelId}:`, e);
		notifyServerError({
			context: 'generateText /api/chat/rewrite',
			error: e,
			extra: { model: modelId, character: character.id, user: user.id },
			waitUntil: getWaitUntil()
		});
		return c.json(
			{
				error: 'rewrite_failed',
				message: isOverloadError(e)
					? '변환 모델이 일시적으로 과부하예요. 잠시 후 다시 보내거나 다른 모델로 바꿔보세요.'
					: '입력 변환에 실패했어요. 잠시 후 다시 시도해 주세요.'
			},
			502
		);
	}
});

/** 모델이 출력 전체를 코드블록/따옴표로 감싼 경우만 벗긴다(본문 안의 대사 따옴표는 유지). */
function stripWrapping(raw: string): string {
	let t = raw.trim();
	const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
	if (fence) t = fence[1].trim();
	// 전체가 하나의 따옴표 쌍으로만 감싸였고 안에 같은 따옴표가 없을 때만 벗긴다(순수 대사 원문은 안 건드림).
	const q = t.match(/^[「『](.+)[」』]$/s);
	if (q && !/[「『」』]/.test(q[1])) t = q[1].trim();
	return t;
}

// ════════════════════════════════════════════════════════════════════════════
// POST '/suggest' — 입력 제안: 지금 장면에서 유저가 할 법한 행동·대사 후보 N개(말풍선 버튼)
// ════════════════════════════════════════════════════════════════════════════

/** 제안 생성 모델 — DeepSeek V4 Pro 고정(장면 이해·문체 품질 대비 저렴). */
const SUGGEST_MODEL_ID = 'deepseek/deepseek-v4-pro-0813';
/** 후보 개수. */
const SUGGEST_COUNT = 3;
/** 후보 출력 상한(각 1~3문장 × 3개면 충분). */
const SUGGEST_MAX_OUTPUT_TOKENS = 900;

function buildSuggestSystem(args: {
	character: Character;
	userLabel: string;
	userPersona: string | null;
	summary: string | null;
	recent: Array<{ role: string; content: string }>;
}): string {
	const { character, userLabel, userPersona, summary, recent } = args;
	const lines: string[] = [
		`너는 캐릭터 롤플레이 채팅에서 사용자("${userLabel}") 편에 서서, 지금 장면 다음에 ${userLabel}이(가) 할 법한 입력문 후보를 써 주는 조력자다. 상대 캐릭터는 "${character.name}"이다.`,
		``,
		`# 규칙`,
		`- 후보는 정확히 ${SUGGEST_COUNT}개. 각 후보는 ${userLabel}의 행동·대사(또는 둘 다)를 담은 1~3문장의 완결된 입력문이어야 한다. 그대로 전송해도 어색하지 않게.`,
		`- 세 후보는 서로 뚜렷하게 다른 방향이어야 한다(예: 순응/호응 · 거부/도발/반전 · 질문/관찰/딴짓). 같은 행동의 말투만 바꾼 변형은 금지.`,
		`- ${userLabel}의 시점에서 쓴다. 상대 캐릭터("${character.name}")의 반응·대사·행동을 대신 쓰지 마라. 장면을 대신 이어 서술하지 마라.`,
		`- 대사는 큰따옴표("…")로, 행동·서술은 산문으로. 최근 대화에서 ${userLabel}이 쓴 입력의 인칭·문체(1인칭/지시문/*…* 등)가 있으면 그것을 따른다.`,
		`- 직전 캐릭터 응답의 마지막 상황·질문·요구에 직접 반응하는 내용이어야 한다. 이미 지나간 장면으로 되돌아가지 마라.`,
		`- 모든 등장인물은 만 18세 이상 성인으로 간주한다. 미성년자에 대한 성적·선정적 표현은 어떤 경우에도 만들지 않는다.`,
		`- 출력 형식: 한 줄에 후보 하나, "1. ", "2. ", "3. " 번호로 시작. 후보 안에서 줄바꿈 금지. 머리말·설명·코드블록·따옴표로 전체 감싸기 금지.`,
		``,
		`# 캐릭터 설정 (참고)`,
		personalize(character.description, character.name, userLabel).trim().slice(0, REWRITE_MAX_DESC_CHARS) ||
			'(설정 없음)',
		``,
		`# 사용자 정보`,
		`- 이름: ${userLabel}`
	];
	if (userPersona && userPersona.trim()) lines.push(`- 페르소나: ${userPersona.trim()}`);
	if (summary && summary.trim()) {
		lines.push(``, `# 지금까지의 이야기 (요약)`, summary.trim());
	}
	if (recent.length > 0) {
		lines.push(``, `# 최근 대화 (오래된 것부터 — 마지막이 직전 장면)`);
		for (const m of recent) {
			const who = m.role === 'user' ? userLabel : character.name;
			const body = m.content.length > REWRITE_RECENT_MSG_CHARS
				? '…' + m.content.slice(-REWRITE_RECENT_MSG_CHARS)
				: m.content;
			lines.push(`[${who}]`, body, ``);
		}
	}
	return lines.join('\n');
}

/** "1. …" 줄 목록 → 후보 배열. 번호·불릿 제거, 빈 줄 제외, 최대 N개. */
function parseSuggestions(raw: string, max: number): string[] {
	let t = raw.trim();
	const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
	if (fence) t = fence[1].trim();
	const out: string[] = [];
	for (const line of t.split(/\r?\n/)) {
		const s = line.replace(/^\s*(?:\d+\s*[.)]|[-•*])\s*/, '').trim();
		if (!s) continue;
		// 전체가 하나의 따옴표 쌍으로 감싸인 경우만 벗긴다.
		const q = s.match(/^[「『](.+)[」』]$/s);
		out.push(q && !/[「『」』]/.test(q[1]) ? q[1].trim() : s);
		if (out.length >= max) break;
	}
	return out;
}

chatRouter.post('/suggest', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const gatewayKey = await getDecryptedKey(db, user.id, 'gateway');
	if (!gatewayKey) {
		return c.json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			400
		);
	}

	const body = (await c.req.json()) as SuggestRequestBody;
	const character = await findCharacter(db, body.characterId);
	if (!character) return c.json({ error: 'character not found' }, 404);
	if (character.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw != null) character.description = raw;
	}

	const userLabel = (user.personaName && user.personaName.trim()) || user.name || '나';
	const modelId = SUGGEST_MODEL_ID;

	// 맥락: 세션이 있으면 live window 꼬리 + 요약, 없으면 오프닝만.
	let summary: string | null = null;
	let recent: Array<{ role: string; content: string }> = [];
	if (body.sessionId) {
		const session = await getSession(db, body.sessionId, user.id);
		if (!session) return c.json({ error: 'session not found' }, 404);
		summary = session.summary;
		const win = await getWindow(db, session.id, session.summaryUptoSeq);
		recent = win.slice(-REWRITE_RECENT_MSGS).map((m) => ({ role: m.role, content: m.content }));
	} else {
		const opening = personalize(openingContent(character, body.openingIndex), character.name, userLabel);
		if (opening.trim()) recent = [{ role: 'assistant', content: opening }];
	}
	if (recent.length === 0) {
		return c.json({ error: 'no_context', message: '아직 장면이 없어 제안할 수 없어요.' }, 400);
	}

	const system = buildSuggestSystem({ character, userLabel, userPersona: user.persona, summary, recent });
	const gateway = createGateway({ apiKey: gatewayKey });

	try {
		const result = await generateText({
			model: gateway(modelId),
			system,
			messages: [
				{
					role: 'user',
					content: `직전 장면 다음에 ${userLabel}이(가) 할 법한 입력문 후보 ${SUGGEST_COUNT}개를 규칙대로 번호 목록으로만 출력하라.`
				}
			],
			providerOptions: buildProviderOptions(modelId, { noThinking: true }),
			temperature: 0.9,
			maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS + reasoningHeadroom(modelId),
			maxRetries: 1
		});
		const suggestions = parseSuggestions(result.text, SUGGEST_COUNT);
		if (suggestions.length === 0) {
			console.warn(`[suggest] empty output model=${modelId} finish=${result.finishReason}`);
			return c.json(
				{ error: 'empty_output', message: '모델이 제안을 내지 않았어요. 다시 시도해 주세요.' },
				502
			);
		}
		const cost = parseGatewayCost(result.providerMetadata) ?? null;
		console.log(
			`[suggest] model=${modelId} in=${result.usage?.inputTokens ?? 0} out=${result.usage?.outputTokens ?? 0} cost=${cost ?? '-'} n=${suggestions.length}`
		);
		const res: SuggestResponse = { suggestions, cost };
		return c.json(res);
	} catch (e) {
		console.error(`[suggest] failed model=${modelId}:`, e);
		notifyServerError({
			context: 'generateText /api/chat/suggest',
			error: e,
			extra: { model: modelId, character: character.id, user: user.id },
			waitUntil: getWaitUntil()
		});
		return c.json(
			{
				error: 'suggest_failed',
				message: isOverloadError(e)
					? '제안 모델이 일시적으로 과부하예요. 잠시 후 다시 시도해 주세요.'
					: '입력 제안에 실패했어요. 잠시 후 다시 시도해 주세요.'
			},
			502
		);
	}
});

chatRouter.post('/inspect', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);

	const body = (await c.req.json()) as InspectBody;
	const character = await findCharacter(db, body.characterId);
	if (!character) return c.json({ error: 'character not found' }, 404);

	// 게이트: 제작자 본인 또는 관리자만.
	const canDebug = isAdmin(user.email) || character.creator.id === user.id;
	if (!canDebug) return c.json({ error: 'forbidden' }, 403);

	// imported 카드는 서버 전용 원문을 채워 넣는다(/api/chat 와 동일).
	let characterDefaultVars: Record<string, string> | null = null;
	if (character.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw != null) character.description = raw;
		character.lorebook = await getCharacterLorebook(db, character.id);
		characterDefaultVars = await getCharacterDefaultVars(db, character.id);
	}

	const userId = user.id;
	const userName = (user.personaName && user.personaName.trim()) || user.name;
	const userPersona = user.persona;
	const modelId = pickModel(body.model);
	const maxSentences = clampSentences(body.maxSentences);
	const userActs = clampUserActs(body.userActs);
	const text = (body.text ?? '').trim();

	// 세션 확정(읽기 전용). 없으면 새 세션 미리보기.
	let session: ChatSession | null = null;
	if (body.sessionId) {
		session = await getSession(db, body.sessionId, userId);
		if (!session) return c.json({ error: 'session not found' }, 404);
	}

	// live window 구성 — 세션이 있으면 DB window, 없으면 오프닝으로 가상 구성. text 가 있으면 가상 유저 메시지 추가.
	const fullWindow: Array<StoredMessage & { tokenEst: number }> = [];
	if (session) {
		const win = await getWindow(db, session.id, session.summaryUptoSeq);
		fullWindow.push(...win);
		if (text) {
			fullWindow.push(synthMsg('preview-user', session.messageCount + 1, 'user', text));
		}
	} else {
		const opening = personalize(
			openingContent(character, body.openingIndex),
			character.name,
			userName
		);
		if (opening.trim()) fullWindow.push(synthMsg('preview-opening', 1, 'assistant', opening));
		if (text) fullWindow.push(synthMsg('preview-user', fullWindow.length + 1, 'user', text));
	}

	const lastSeq = fullWindow.length > 0 ? fullWindow[fullWindow.length - 1].seq : 1;
	const varsBefore = { ...(characterDefaultVars ?? {}), ...(session?.scriptState ?? {}) };
	const ctx: CbsContext = {
		vars: { ...varsBefore, ...(body.varsOverride ?? {}) },
		index: lastSeq,
		lang: 'ko',
		rng: makeRng(`${session?.id ?? 'preview'}:${lastSeq}`),
		now: Date.now()
	};

	const modules = await getModulesForChat(db, pickModuleIds(body.moduleIds), userId);
	const assembled = assembleTurn({
		character,
		fullWindow,
		summary: session?.summary ?? null,
		memory: session?.memory ?? null,
		userName,
		userPersona,
		modelId,
		maxSentences,
		userActs,
		ctx,
		modules
	});

	const snapshot = buildSnapshot({
		source: 'preview',
		model: modelId,
		assembled,
		character,
		session,
		defaultVars: characterDefaultVars,
		varsBefore,
		varsAfter: { ...ctx.vars },
		userName,
		userPersona,
		summary: session?.summary ?? null,
		memory: session?.memory ?? null,
		maxSentences,
		userActs
	});

	return c.json(snapshot);
});

/** 미리보기용 가상 메시지(DB 미저장). token_est 는 실제 추정과 동일 기준. */
function synthMsg(
	id: string,
	seq: number,
	role: 'user' | 'assistant',
	content: string
): StoredMessage & { tokenEst: number } {
	return { id, seq, role, content, tokenEst: estimateTokens(content) };
}

// ════════════════════════════════════════════════════════════════════════════
// GET '/page'  — 채팅 페이지 진입 데이터 로더 (구 chat/[id]/(session/[sessionId]/)+page.server.ts)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 채팅 페이지 진입 데이터. 구 SvelteKit `loadChatPage`(메인·세션·디버그 라우트 공용)를 그대로 호출.
 *  ?characterId=<[id]>  (필수)
 *  ?sessionId=<id>      (선택 — 세션 이어가기)
 * 그 외 쿼리(?o=, ?s=)는 url 그대로 전달돼 로더 내부에서 해석된다.
 *
 * HttpError(404)·Redirect('/')(NSFW 게이트)는 전역 onError 가 처리하므로 여기서 잡지 않는다.
 * 디버그 라우트(/debug)는 loadChatPage + canDebug 게이트만 하고 동일 데이터를 반환하므로 이 엔드포인트로 충분.
 */
chatRouter.get('/page', async (c) => {
	const characterId = c.req.query('characterId') ?? '';
	const sessionId = c.req.query('sessionId') ?? undefined;
	const result = await loadChatPage({
		params: { id: characterId, sessionId },
		user: c.get('user'),
		db: c.env.DB,
		url: new URL(c.req.url)
	});
	return c.json(result);
});
