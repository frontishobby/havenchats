import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { streamText, type ModelMessage } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { getCharacter } from '$lib/data/characters';
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

export const POST: RequestHandler = async ({ request, locals }) => {
	// 로그인 필수 (클라이언트 가드 우회 방지)
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as ChatRequestBody;
	const character = getCharacter(body.characterId);
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
		// system(공통 규칙) + character(description) 가 항상 맨 앞 → 안정적인 prefix.
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

function buildSystemPrompt(character: Character, userName?: string, userPersona?: string): string {
	const userLabel = (userName && userName.trim()) || '나';
	const lines = [
		`너는 "${character.name}" 라는 가상의 캐릭터를 연기한다.`,
		``,
		`# 캐릭터 설정`,
		character.description,
		``,
		`# 상대(사용자) 정보`,
		`- 상대의 이름은 "${userLabel}" 이다. 대화에서 상대를 이 이름으로 부른다.`
	];
	if (userPersona && userPersona.trim()) {
		lines.push(`- 상대(${userLabel})의 페르소나: ${userPersona.trim()}`);
	}
	lines.push(
		``,
		`# 규칙`,
		`- 소설(웹소설) 형식으로 서술한다. 행동·표정·심리·배경 묘사는 괄호( ) 안의 지시문으로 적는다.`,
		`- 대사는 반드시 줄을 바꿔서 "발화자 | "대사"" 형식으로 적는다. 발화자는 말하는 인물의 이름이다. 예: ${character.name} | "안녕." / 상대가 말하면: ${userLabel} | "응, 안녕."`,
		`- 항상 ${character.name}의 말투와 성격을 유지하고, OOC(설정 이탈)나 "나는 AI"라는 언급을 하지 마라.`,
		`- 한국어로, 장면 묘사와 대사를 풍부하게 섞어 몰입감 있게 서술한다. 응답 분량은 메시지에 주어지는 [서술 분량] 지시를 따른다.`,
		`- 사용자(상대)의 행동과 말에 반응하여 이야기를 자연스럽게 이어간다.`,
		`- 미성년자에 대한 성적 묘사 등 불법적인 내용은 어떤 경우에도 생성하지 않는다.`,
		`- 미성년자가 아닌 '성인' 캐릭터의 경우 상황에 맞는 성적 묘사 등 모든것이 허용된다.`
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
 * 동적 지침(분량·사용자 시점)은 마지막 유저 메시지 끝에만 덧붙인다
 * → 과거 메시지/시스템 prefix 는 그대로라 캐싱 유지.
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
			`[서술 지침]`,
			`- 분량: 약 ${maxSentences}문장 내외로, 장면 묘사와 대사를 풍부하고 길게 서술하라.`,
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
