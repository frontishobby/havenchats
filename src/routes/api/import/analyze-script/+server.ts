import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
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
	`너는 RisuAI 캐릭터 카드의 스크립트·트리거를 분석하는 기능/보안 분석가다.`,
	`주어진 항목(트리거 정의 JSON, Lua/JS 코드, 정규식 치환)을 읽고 "실제로 무엇을 하는지" 한국어로 설명하라.`,
	`독자는 비개발자다. 전문 용어는 최소화하고 쉽게 풀어 써라.`,
	``,
	`각 항목마다:`,
	`- **한 줄 요약**: 이 스크립트가 하려는 일.`,
	`- **동작**: 구체적으로 하는 일을 불릿으로(과정·조건·결과).`,
	`- **주의**: 위험·부작용이 있으면 명시. 특히 아래는 굵게 강조하라 —`,
	`  **AI 모델 추가 호출**(비용↑), **외부 네트워크 요청**(데이터 유출 가능), **저장소/로어북 접근**, **무한 재귀·반복**.`,
	``,
	`규칙:`,
	`- 코드에 근거해 설명하라. 확신 못 하는 추론은 "(추정)"으로 표시.`,
	`- 마지막에 "## 종합" 으로 카드 전체가 어떤 기믹을 노린 것인지 2~3문장 요약.`,
	`- 간결한 마크다운. 코드 원문을 그대로 길게 복붙하지 말 것.`
].join('\n');

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

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

	const apiKey = env.AI_GATEWAY_API_KEY;
	if (!apiKey) {
		return json(
			{ error: 'AI 분석 키가 설정되지 않았어요(AI_GATEWAY_API_KEY).' },
			{ status: 503 }
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
