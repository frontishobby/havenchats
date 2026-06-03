export interface ModelOption {
	id: string;
	label: string;
	/** static/ 기준 아이콘 경로 */
	icon: string;
}

export const MODELS: ModelOption[] = [
	{ id: 'meta/llama-3.1-8b', label: 'Llama 3.1 8B', icon: '/models/meta.avif' },
	{ id: 'alibaba/qwen3.7-max', label: 'Qwen 3.7 Max', icon: '/models/qwen.avif' },
	{ id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', icon: '/models/gemini.avif' },
	{ id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', icon: '/models/deepseek.avif' },
	{ id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', icon: '/models/claude.avif' }
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

/** 서버 검증용 허용 모델 ID 집합 (임의 모델 주입 방지) */
export const MODEL_IDS: Set<string> = new Set(MODELS.map((m) => m.id));

export function getModel(id: string): ModelOption | undefined {
	return MODELS.find((m) => m.id === id);
}
