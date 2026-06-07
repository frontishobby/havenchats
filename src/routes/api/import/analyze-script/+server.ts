import { json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';

/**
 * 실험적: charx 가져오기에서 재현 안 되는 **스크립트가 실제로 뭘 하는지** LLM 으로 분석.
 *
 * Haven 엔 트리거/스크립트 엔진이 없어 그냥 누락된다. 사용자가 "이 카드가 뭘 하려던 거지?"를
 * 알 수 있게, 원본(트리거 JSON·Lua/JS 코드·정규식)을 LLM(Gemini)에게 보내 사람이 읽는 설명으로 바꾼다.
 * 실행이 아니라 **읽고 설명만** 한다(코드는 모델에 텍스트로만 전달).
 */

/** 분석 모델 — 빠르고 저렴한 Gemini Flash 고정(사용자 선택 아님). */
const ANALYZE_MODEL = 'google/gemini-3.5-flash';

/** 입력 가드: 스크립트 1개당·전체 문자 상한(과금·지연·컨텍스트 보호). */
const PER_SCRIPT_CHARS = 12_000;
const TOTAL_CHARS = 60_000;
const MAX_SCRIPTS = 40;

const SYSTEM = [
	`너는 RisuAI 캐릭터 카드의 스크립트·트리거를 분석하는 사람이다.`,
	`주어진 항목(트리거 정의 JSON, Lua/JS 코드, 정규식 치환)을 읽고 "실제로 무엇을 하는지" 한국어로 설명하라.`,
	`독자는 비개발자다. 전문 용어는 최소화하고 쉽게 풀어 써라.`,
	``,
	`형식은 마크다운(제목·불릿·굵게·표) 쓰지 말고, 그냥 읽기 편한 줄글(문단)로 쓴다.`,
	`항목이 여러 개면 각 항목을 짧은 문단으로 나눠 자연스럽게 설명하라. 기호·머리표 없이 문장으로.`,
	`각 항목에서 그 스크립트가 하려는 일과 구체적인 동작을 풀어 쓰고, 위험·부작용이 있으면 문장 안에서 짚어줘라`,
	`(특히 AI 모델을 추가로 호출해 비용이 드는지, 외부 네트워크로 요청을 보내는지, 저장소·로어북에 접근하는지, 무한 반복 위험이 있는지).`,
	``,
	`이 스크립트들은 Haven 에서 실행되지 않는다(엔진 없음). 그래서 가장 중요한 건, 이 기능이 안 돌아도 챗봇을 즐기는 데`,
	`무리가 없는지 판단하는 것이다. 핵심 기믹(스탯·호감도·게임 진행·분기처럼 카드의 정체성)이면 빠지면 껍데기가 되고,`,
	`곁다리(자동 이미지·부가 연출·사소한 서식 정리)면 빠져도 일반 롤플레이로 즐기는 데 문제없다.`,
	``,
	`마지막 문단은 종합 판정으로, "무리 없음" / "일부 아쉬움" / "핵심 기능 손실" 중 하나를 먼저 밝히고,`,
	`이 카드가 어떤 기믹을 노린 것인지, 스크립트가 빠지면 구체적으로 무엇이 달라지는지(예: 호감도 수치가 안 변함, 자동 이미지가 안 뜸)를 줄글로 정리하라.`,
	`코드에 근거해 설명하고, 확신 못 하는 부분은 "추정"이라고 밝혀라. 코드 원문을 그대로 길게 옮기지 마라.`
].join('\n');

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	requireAdmin(locals.user.email); // charx import(스크립트 분석)는 관리자 전용

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: '요청 형식이 올바르지 않아요.' }, { status: 400 });
	}

	const raw = (body as { scripts?: unknown })?.scripts;
	if (!Array.isArray(raw) || raw.length === 0) {
		return json({ error: '분석할 스크립트가 없어요.' }, { status: 400 });
	}

	// 정규화 + 입력 가드(라벨/소스만, 길이 제한).
	let total = 0;
	const items: { label: string; source: string }[] = [];
	for (const s of raw.slice(0, MAX_SCRIPTS)) {
		const label = String((s as { label?: unknown })?.label ?? '').slice(0, 120);
		let source = String((s as { source?: unknown })?.source ?? '');
		if (!source.trim()) continue;
		if (source.length > PER_SCRIPT_CHARS) {
			source = source.slice(0, PER_SCRIPT_CHARS) + '\n…(생략됨)';
		}
		if (total + source.length > TOTAL_CHARS) break;
		total += source.length;
		items.push({ label, source });
	}
	if (items.length === 0) {
		return json({ error: '분석할 내용이 비어있어요.' }, { status: 400 });
	}

	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });
	const apiKey = await getDecryptedKey(db, locals.user.id, 'gateway');
	if (!apiKey) {
		return json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			{ status: 400 }
		);
	}

	const prompt = items
		.map((it, i) => `### [${i + 1}] ${it.label}\n\`\`\`\n${it.source}\n\`\`\``)
		.join('\n\n');

	try {
		const { text } = await generateText({
			model: createGateway({ apiKey })(ANALYZE_MODEL),
			system: SYSTEM,
			prompt: `다음 ${items.length}개 항목을 분석해줘.\n\n${prompt}`,
			temperature: 0.3,
			// Gemini 는 추론이 출력 예산을 먹으므로 thinking 을 작게 제한.
			maxOutputTokens: 4000,
			providerOptions: {
				gateway: { caching: 'auto' },
				google: { thinkingConfig: { thinkingBudget: 256, includeThoughts: false } }
			}
		});

		const analysis = text.trim();
		if (!analysis) {
			return json({ error: '분석 결과가 비어있어요. 다시 시도해 주세요.' }, { status: 502 });
		}
		return json({ analysis, model: ANALYZE_MODEL, analyzed: items.length });
	} catch (err) {
		console.error('[analyze-script] error:', err);
		return json({ error: '분석 중 오류가 났어요. 잠시 후 다시 시도해 주세요.' }, { status: 502 });
	}
};
