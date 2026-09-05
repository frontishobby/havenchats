export interface ModelOption {
	id: string;
	label: string;
	/** static/ 기준 아이콘 경로 */
	icon: string;
	/** 모델의 컨텍스트 윈도우(input+output 토큰 총 상한). input 가드 계산의 기준. */
	contextLimit: number;
	/**
	 * 기본적으로 내부 추론(thinking/reasoning) 토큰을 출력 예산에서 소비하는 모델인지.
	 * true 면 maxOutputTokens 에 reasoning headroom 을 더해 본문이 잘리지 않게 한다.
	 * (Google 계열은 추론을 비활성화하지만, 무시될 경우의 안전망으로 headroom 도 함께 둠)
	 */
	reasoning?: boolean;
}

// contextLimit = Vercel AI Gateway 표시 max context(input+output 합산 총 컨텍스트).
// 순서 = 가격 내림차순(게이트웨이 표준 단가, input/output $ per 1M tokens, 2026-09 기준).
export const MODELS: ModelOption[] = [
	// $5 / $25
	{ id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', icon: '/models/claude.avif', contextLimit: 1_000_000 },
	// $3 / $15 — Moonshot 플래그십. 창작 글쓰기 벤치 Opus 5 다음(2026-09). 1M 컨텍스트·캐시 입력 90% 할인
	{ id: 'moonshotai/kimi-k3', label: 'Kimi K3', icon: '/models/moonshotai.avif', contextLimit: 1_000_000, reasoning: true },
	// $2 / $10 — GPT-5.6 시리즈 플래그십
	{ id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', icon: '/models/openai.avif', contextLimit: 1_050_000, reasoning: true },
	// $0.75 / $3.75
	{ id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', icon: '/models/gemini.avif', contextLimit: 1_000_000, reasoning: true },
	// $0.66 / $1.98
	{ id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', icon: '/models/deepseek.avif', contextLimit: 1_000_000, reasoning: true },
	// $0.15 / $0.50
	{ id: 'zai/glm-5.3-flash', label: 'GLM 5.3 Flash', icon: '/models/zai.avif', contextLimit: 1_000_000, reasoning: true },
	// $0.076 / $0.153
	{ id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', icon: '/models/deepseek.avif', contextLimit: 1_000_000, reasoning: true }
];

/** 채팅 기본 모델 — 가장 저렴한 DeepSeek V4 Flash(목록 순서와 무관하게 고정). */
export const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash-0731';

/**
 * 캐릭터 제작 보조(assist)에 허용하는 모델 — 구조화 출력(generateObject)이 안정적인 것만.
 * Claude Opus 5 · GPT-5.6 Sol · GLM 5.3 Flash. (Gemini Flash 는 제외 — NSFW 설정 입력을
 * content-filter 로 빈 응답 처리하는 경우가 있음. DeepSeek 계열은 긴 JSON 출력이 불안정)
 * MODELS(채팅 목록)의 부분집합이므로 getModel 로 조회 가능.
 */
const ASSIST_MODEL_ID_LIST = ['anthropic/claude-opus-5', 'openai/gpt-5.6-sol', 'zai/glm-5.3-flash'];
export const ASSIST_MODELS: ModelOption[] = ASSIST_MODEL_ID_LIST.map((id) => {
	const m = MODELS.find((x) => x.id === id);
	if (!m) throw new Error(`assist 모델이 MODELS 에 없음: ${id}`);
	return m;
});
export const ASSIST_MODEL_IDS: Set<string> = new Set(ASSIST_MODELS.map((m) => m.id));
/** assist 기본 모델(허용목록에 있어야 함) — 가장 저렴한 GLM 5.3 Flash. */
export const DEFAULT_ASSIST_MODEL_ID = 'zai/glm-5.3-flash';

/**
 * 실시간 이미지 상황 프롬프트(generateObject 구조화 출력)에 허용하는 모델.
 * 조건: ① 구조화 출력이 안정적 ② 노골적 성행위 장면도 거부하지 않음 ③ 빠르고 저렴.
 * Gemini Flash 계열은 safetySettings BLOCK_NONE 을 줘도 노골적 장면을 content-filter 로
 * 빈 응답 처리해 제외(2026-09 실측 0/4). DeepSeek V4 Flash 는 거부는 안 하지만 30~45s 지연·
 * length 실패가 잦아 제외. 채팅 모델 목록(MODELS)과 별개 목록이므로 getModel 로 조회하지 말고
 * findImagePromptModel 을 쓴다.
 */
export const IMAGE_PROMPT_MODELS: ModelOption[] = [
	// $0.15 / $0.50 — 2~3s, char/user 분리·인원수 태그 정확(실측 4/4)
	{ id: 'zai/glm-5.3-flash', label: 'GLM 5.3 Flash', icon: '/models/zai.avif', contextLimit: 1_000_000, reasoning: true },
	// $0.30 / $1.20 — 2~3s(실측 4/4)
	{ id: 'minimax/minimax-m3', label: 'MiniMax M3', icon: '/models/minimax.avif', contextLimit: 512_000, reasoning: true }
];
export const IMAGE_PROMPT_MODEL_IDS: Set<string> = new Set(IMAGE_PROMPT_MODELS.map((m) => m.id));
/** 이미지 상황 프롬프트 기본 모델 — GLM 5.3 Flash. */
export const DEFAULT_IMAGE_PROMPT_MODEL_ID = 'zai/glm-5.3-flash';

export function findImagePromptModel(id: string): ModelOption | undefined {
	return IMAGE_PROMPT_MODELS.find((m) => m.id === id);
}

/** 알 수 없는 모델의 보수적 기본 컨텍스트 상한. */
const FALLBACK_CONTEXT_LIMIT = 128_000;

/** 서버 검증용 허용 모델 ID 집합 (임의 모델 주입 방지) */
export const MODEL_IDS: Set<string> = new Set(MODELS.map((m) => m.id));

export function getModel(id: string): ModelOption | undefined {
	return MODELS.find((m) => m.id === id);
}

/** 모델의 컨텍스트 상한(없으면 보수적 폴백). */
export function getContextLimit(id: string): number {
	return getModel(id)?.contextLimit ?? FALLBACK_CONTEXT_LIMIT;
}

/** 기본적으로 thinking/reasoning 토큰을 쓰는 모델인지(출력 예산 보정용). */
export function isReasoningModel(id: string): boolean {
	return (getModel(id) ?? findImagePromptModel(id))?.reasoning === true;
}
