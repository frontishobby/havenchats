export interface ModelOption {
	id: string;
	label: string;
	/** static/ 기준 아이콘 경로 */
	icon: string;
	/** 모델의 컨텍스트 윈도우(input+output 토큰 총 상한). input 가드 계산의 기준. */
	contextLimit: number;
}

// contextLimit = Vercel AI Gateway 표시 max context(input+output 합산 총 컨텍스트).
export const MODELS: ModelOption[] = [
	{ id: 'meta/llama-3.1-8b', label: 'Llama 3.1 8B', icon: '/models/meta.avif', contextLimit: 131_072 },
	{ id: 'alibaba/qwen3.7-max', label: 'Qwen 3.7 Max', icon: '/models/qwen.avif', contextLimit: 991_000 },
	{ id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', icon: '/models/gemini.avif', contextLimit: 1_000_000 },
	{ id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', icon: '/models/deepseek.avif', contextLimit: 1_000_000 },
	{ id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', icon: '/models/claude.avif', contextLimit: 1_000_000 }
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

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
