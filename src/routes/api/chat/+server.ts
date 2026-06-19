import { getWaitUntil } from '$lib/server/waitUntil';
import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { streamText, generateText } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
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
	estimateTokens
} from '$lib/server/db/chats';
import type { Character, ChatSession, StoredMessage } from '$lib/types';
import { pinSceneCodes } from '$lib/imageCodes';
import { personalize } from '$lib/placeholders';
import { notifyServerError } from '$lib/server/notify';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import {
	assembleTurn,
	buildSnapshot,
	buildProviderOptions,
	clampSentences,
	clampUserActs,
	openingContent,
	pickModel,
	reasoningHeadroom,
	WINDOW_TOKEN_BUDGET,
	KEEP_RECENT,
	MAX_USER_MSG_TOKENS,
	type ChatDebugSnapshot
} from '$lib/server/chatAssembly';

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
	/** 디버그 모드: 응답 메타 프레임에 조립 내부(system/messages/변수/토큰) 스냅샷을 함께 내려준다. */
	debug?: boolean;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	// 로그인 필수 (클라이언트 가드 우회 방지)
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	const db = getDB(platform);
	if (!db) {
		return json({ error: 'db unavailable' }, { status: 500 });
	}

	// 챗은 유저 본인 Vercel AI Gateway 키로 호출(BYO). 키 없으면 차단(예외 없음).
	const gatewayKey = await getDecryptedKey(db, locals.user.id, 'gateway');
	if (!gatewayKey) {
		return json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			{ status: 400 }
		);
	}

	const body = (await request.json()) as ChatRequestBody;
	const character = await findCharacter(db, body.characterId);
	if (!character) {
		return json({ error: 'character not found' }, { status: 404 });
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
	// 채팅에서 AI 가 부르는 이름: 대화용 이름(persona_name) 우선, 없으면 노출용 이름(display_name)으로 폴백.
	const userName = (locals.user.personaName && locals.user.personaName.trim()) || locals.user.name;
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
			memory: body.memory,
			defaultVariables: characterDefaultVars
		});
	}

	// 유저 메시지 즉시 영속화 (스트림 끊겨도 유실 방지) + 세션 모델 갱신
	const userSeq = await appendMessage(db, session.id, 'user', text, modelId, undefined, undefined, userMsgId);

	// live window(seq > summary_upto_seq) — 방금 넣은 유저 메시지·오프닝 포함
	const fullWindow = await getWindow(db, session.id, session.summaryUptoSeq);

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
		ctx
	});
	const { systemPrompt, window, messages, inputTokensEst, outputReserve, inputLimit } = assembled;
	if (assembled.windowTrimmed) {
		console.warn(
			`[chat] input guard trimmed window ${fullWindow.length}→${window.length} (model=${modelId}, limit=${inputLimit})`
		);
	}

	// 디버그 모드면 조립 내부 전체를 스냅샷으로 만들어 메타 프레임에 동봉(아래). varsAfter 는 CBS 평가 직후 상태.
	// 시스템 프롬프트·숨김 카드 내부가 드러나므로 **제작자 본인 또는 관리자**에게만 스냅샷을 내려준다.
	const canDebug = isAdmin(locals.user.email) || character.creator.id === userId;
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
	const after = getWaitUntil(platform);

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
				waitUntil: getWaitUntil(platform)
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
					waitUntil: getWaitUntil(platform)
				});
			}
			if (streamError) {
				// 상세 에러는 서버 로그(onError)에만 남기고, 사용자에겐 일반 메시지만 노출.
				// 단, 공급자 일시 과부하(503/"temporarily unavailable")는 모델 교체를 유도하는 안내로 구분.
				controller.enqueue(
					encoder.encode(
						isOverloadError(streamError)
							? '⚠️ 지금 이 모델(AI 공급자)이 일시적으로 과부하 상태예요. 잠시 후 다시 보내거나, 설정(⚙)에서 다른 모델로 바꿔보세요.'
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
