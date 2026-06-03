import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { streamText, type ModelMessage } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { findCharacter } from '$lib/server/characters';
import { MODEL_IDS, DEFAULT_MODEL_ID } from '$lib/data/models';
import type { Character, ChatMessage } from '$lib/types';

interface ChatRequestBody {
	characterId: string;
	messages: ChatMessage[];
	/** 사용자가 설정에서 선택한 모델 ID (허용목록 검증). */
	model?: string;
	/** 응답 분량(문장 수). 5~30, 기본 12. */
	maxSentences?: number;
	/** '나'(사용자) 행동·대사를 AI가 생성하는 정도. 0=금지, 1=적정, 2=풍부. 기본 1. */
	userActs?: number;
	/** 사용자(상대) 이름 — 프로필에서. */
	userName?: string;
	/** 사용자(상대) 페르소나 — 프로필에서. 모든 대화에 적용. */
	userPersona?: string;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	// 로그인 필수 (클라이언트 가드 우회 방지)
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as ChatRequestBody;
	const character = await findCharacter(platform?.env?.DB, body.characterId);
	if (!character) {
		return json({ error: 'character not found' }, { status: 404 });
	}

	const apiKey = env.AI_GATEWAY_API_KEY;

	// 키가 없으면 mock 스트리머로 폴백 (로컬에서 키 없이도 UI 동작)
	if (!apiKey) {
		return mockStream(character, body.messages);
	}

	const gateway = createGateway({ apiKey });
	const modelId = pickModel(body.model);
	const maxSentences = clampSentences(body.maxSentences);
	const userActs = clampUserActs(body.userActs);
	console.log(
		`[chat] request character=${character.id} rating=${character.contentRating} model=${modelId} sentences=${maxSentences} userActs=${userActs}`
	);

	// AI SDK v6 의 textStream 은 에러를 throw 하지 않고 빈 스트림으로 끝나므로
	// onError 로 에러를 포착한 뒤, 스트림 종료 후 채팅 버블에 노출한다(디버깅용).
	let streamError: unknown = null;

	const result = streamText({
		model: gateway(modelId),
		// system(제작자 프롬프트 + 공통 정보/가드레일) 가 항상 맨 앞 → 안정적인 prefix.
		// 그 뒤에 채팅 기록이 누적되므로 프롬프트 캐싱이 적용된다(비용↓ / TTFT↓).
		system: buildSystemPrompt(character, body.userName, body.userPersona),
		// 길이/시점 지침은 정적 system 이 아니라 "현재 유저 메시지 끝"에 붙여 prefix 캐싱을 보존한다.
		messages: buildMessages(body.messages, maxSentences, userActs),
		// 프로바이더에 맞춰 캐싱 자동 처리:
		// Anthropic/MiniMax → cache_control 자동 삽입, OpenAI/Google/DeepSeek → 암묵적 캐싱.
		providerOptions: {
			gateway: { caching: 'auto' }
		},
		temperature: 0.9,
		maxOutputTokens: sentencesToTokens(maxSentences),
		onError: ({ error }) => {
			streamError = error;
			console.error(`[chat] streamText error (model=${modelId}):`, error);
		}
		// onFinish: ({ text, usage }) => { ... }  // 추후: 메시지/usage 영속화 (waitUntil)
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
			'cache-control': 'no-store'
		}
	});
};

/** 사용자가 설정에서 선택한 모델을 허용목록으로 검증해 반환. 유효하지 않으면 기본 모델. */
function pickModel(requested?: string): string {
	return requested && MODEL_IDS.has(requested) ? requested : DEFAULT_MODEL_ID;
}

/**
 * 시스템 프롬프트 = [제작자 프롬프트(description)] + 공통 정보 + 공통 가드레일.
 *
 * 캐릭터 연기/내레이터/시뮬레이션/어시스턴트 같은 "역할 프레이밍"과 소설·대사 출력 형식,
 * 말투·세계관 등은 전부 제작자가 description 에 직접 작성한다(기호에 맞게).
 * 서버가 더하는 것은 두 가지 "완전 공통" 부분뿐:
 *   ① 상대(사용자) 정보 — 제작자가 작성 시점에 알 수 없는 런타임 정보.
 *   ② 가드레일 — 제작자 설정과 무관하게 항상 강제되는 안전 규칙.
 */
function buildSystemPrompt(character: Character, userName?: string, userPersona?: string): string {
	const userLabel = (userName && userName.trim()) || '나';

	// ① 제작자가 작성한 프롬프트 (전체 프레이밍·설정·형식)
	const lines: string[] = [character.description.trim(), ``];

	// ② 상대(사용자) 정보 — 런타임 정보라 공통으로 주입
	lines.push(
		`# 상대(사용자) 정보`,
		`- 상대의 이름은 "${userLabel}" 이다. 대화에서 상대를 이 이름으로 부른다.`
	);
	if (userPersona && userPersona.trim()) {
		lines.push(`- 상대(${userLabel})의 페르소나: ${userPersona.trim()}`);
	}

	// ③ 가드레일 — 항상 강제되는 안전 규칙
	lines.push(
		``,
		`# 필수 준수`,
		`- 미성년자에 대한 성적 묘사 등 불법적인 내용은 어떤 경우에도 생성하지 않는다.`,
		`- 등장인물이 미성년자가 아닌 '성인'인 경우, 상황에 맞는 성적 묘사 등이 허용된다.`
	);
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
 * 클라이언트 메시지를 AI SDK 메시지로 변환(빈 내용 제거).
 * 유저 설정(분량·'나' 행동 생성 정도)은 마지막 유저 메시지 끝에만 덧붙인다
 * → 과거 메시지/시스템 prefix 는 그대로라 캐싱 유지.
 * (출력 형식 자체는 제작자 프롬프트가 정의하므로 여기서는 분량/시점만 다룬다.)
 */
function buildMessages(
	messages: ChatMessage[],
	maxSentences: number,
	userActs: number
): ModelMessage[] {
	const out: ModelMessage[] = messages
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
// 폴백: AI Gateway 키가 없을 때 사용하는 mock 스트리머
// ─────────────────────────────────────────────────────────────
function mockStream(character: Character, messages: ChatMessage[]): Response {
	const lastUser = [...messages].reverse().find((m) => m.role === 'user');
	const reply = mockReply(character.name, lastUser?.content ?? '');

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const tokens = reply.match(/\S+\s*/g) ?? [reply];
			for (const token of tokens) {
				controller.enqueue(encoder.encode(token));
				await new Promise((r) => setTimeout(r, 35));
			}
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'x-haven-mock': '1'
		}
	});
}

function mockReply(name: string, userText: string): string {
	const t = userText.trim();
	if (!t) return `(${name}이/가 너를 빤히 바라본다) ...뭐야, 할 말 있으면 해.`;
	const samples = [
		`음... "${t}" 라니, 너답네. (${name}이/가 살짝 웃는다) 좀 더 얘기해 줄래?`,
		`그래? 사실 나도 비슷한 생각 하고 있었어. 근데 너는 어떻게 하고 싶은데?`,
		`(${name}이/가 잠시 고민한다) 흠... 솔직히 말하면, 네가 그렇게 말해주니까 좀 기뻐.`,
		`"${t}"... 그 말, 곱씹게 되네. 우리 천천히 같이 풀어보자.`
	];
	return samples[t.length % samples.length];
}
