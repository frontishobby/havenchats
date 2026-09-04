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
 * 캐릭터 제작 보조(assist)에 허용하는 모델 — 구조화 출력(generateObject)이 안정적인
 * Gemini 계열만. (다른 모델은 JSON 출력이 불안정해 제외)
 */
export const ASSIST_MODELS: ModelOption[] = MODELS.filter((m) => m.id.startsWith('google/gemini'));
export const ASSIST_MODEL_IDS: Set<string> = new Set(ASSIST_MODELS.map((m) => m.id));
/** assist 기본 모델(허용목록에 있어야 함). */
export const DEFAULT_ASSIST_MODEL_ID = 'google/gemini-3.8-flash';

/**
 * 실시간 이미지 상황 프롬프트(generateObject 구조화 출력)에 허용하는 모델 — assist 와 동일하게
 * 구조화 출력이 안정적인 Gemini 계열만. (다른 모델은 JSON 출력이 불안정)
 */
export const IMAGE_PROMPT_MODELS: ModelOption[] = ASSIST_MODELS;
export const IMAGE_PROMPT_MODEL_IDS: Set<string> = new Set(IMAGE_PROMPT_MODELS.map((m) => m.id));
/** 이미지 상황 프롬프트 기본 모델 — 빠른 Gemini Flash. */
export const DEFAULT_IMAGE_PROMPT_MODEL_ID = 'google/gemini-3.8-flash';

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
	return getModel(id)?.reasoning === true;
}
