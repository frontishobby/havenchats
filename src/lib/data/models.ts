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
	// 구독 — homebox 브릿지(bridge/haven-bridge.mjs)가 Claude Code CLI(`claude -p`, 구독 OAuth)를 OpenAI 호환으로
	// 노출. 비용 0(구독 한도에서 차감), 캐시·멀티턴은 브릿지의 --resume 이 담당. API 키 관리에서 브릿지 URL 등록 필요.
	// id 의 `bridge/` 뒤가 CLI --model 값. contextLimit 은 Claude Code 기본 200k.
	{ id: 'bridge/claude-opus-4-6', label: 'Opus 4.6 Subscription', icon: '/models/claude.avif', contextLimit: 200_000 },
	// $5 / $25 — Opus 4.6. RP 커뮤니티(아카라이브 AI채팅챈·레딧 프리셋 제작자 티어표) 합의로 Claude 중 RP 최고 +
	// 최신 세대 중 검열 최약. Opus 4.8·5 는 하드검열 강화·창의성 저하 평이라 목록에서 제외(2026-09-07).
	// 게이트웨이 라우팅은 buildProviderOptions 에서 anthropic 직결 고정(Bedrock 경유는 정책 위반 차단이 엄격).
	{ id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6', icon: '/models/claude.avif', contextLimit: 1_000_000 },
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
 * 캐릭터 제작 보조(assist)에 허용하는 모델 — 구조화 출력(streamObject)이 안정적인 것만.
 * Claude Opus 4.6 · GPT-5.6 Sol · DeepSeek V4 Pro · GLM 5.3 Flash. (Gemini Flash 는 제외 — NSFW 설정 입력을
 * content-filter 로 빈 응답 처리하는 경우가 있음.)
 * DeepSeek V4 Pro 는 NSFW 설정을 거부하지 않는 상위 모델로 추가(2026-09-07 실측: NSFW 러프 입력 4/4 정상 JSON,
 * 30~35s, thinking 끔·스키마는 시스템 주입 호환 모드). Opus·Sol 은 NSFW 설정 입력을 거부하는 경우가 있어
 * 검열 회피용 대안. DeepSeek V4 Flash 는 length 실패가 잦아 제외.
 * MODELS(채팅 목록)의 부분집합이므로 getModel 로 조회 가능.
 */
const ASSIST_MODEL_ID_LIST = [
	'anthropic/claude-opus-4.6',
	'openai/gpt-5.6-sol',
	'deepseek/deepseek-v4-pro-0813',
	'zai/glm-5.3-flash'
];
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
 * 조건: ① 구조화 출력이 안정적 ② 빠르고 저렴 ③ 노골적 장면 거부가 드물 것.
 * Gemini 3.8 Flash 는 safetySettings BLOCK_NONE 을 줘도 노골적 장면을 content-filter 로 빈 응답 처리하는
 * 경우가 있어(2026-09 실측) 한동안 제외했다가, /api/chat/image/prepare 에 **검열 감지 + 최대 3회 재시도**
 * (isCensoredSituation — 채팅의 isCensoredTurn 과 같은 판정)를 넣으면서 기본 모델로 복귀(2026-09-09).
 * 3회 모두 막히면 'censored' 에러로 실패를 알린다. DeepSeek V4 Flash 는 거부는 안 하지만 30~45s 지연·
 * length 실패가 잦아 제외. 채팅 모델 목록(MODELS)과 별개 목록이므로 getModel 로 조회하지 말고
 * findImagePromptModel 을 쓴다.
 */
export const IMAGE_PROMPT_MODELS: ModelOption[] = [
	// $0.75 / $3.75 — 구조화 출력·장면 이해 가장 정확. 검열 시 재시도(위 주석)
	{ id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', icon: '/models/gemini.avif', contextLimit: 1_000_000, reasoning: true },
	// $0.15 / $0.50 — 2~3s, char/user 분리·인원수 태그 정확(실측 4/4)
	{ id: 'zai/glm-5.3-flash', label: 'GLM 5.3 Flash', icon: '/models/zai.avif', contextLimit: 1_000_000, reasoning: true },
	// $0.30 / $1.20 — 2~3s(실측 4/4)
	{ id: 'minimax/minimax-m3', label: 'MiniMax M3', icon: '/models/minimax.avif', contextLimit: 512_000, reasoning: true }
];
export const IMAGE_PROMPT_MODEL_IDS: Set<string> = new Set(IMAGE_PROMPT_MODELS.map((m) => m.id));
/** 이미지 상황 프롬프트 기본 모델 — Gemini 3.8 Flash(2026-09-09, 검열 재시도 도입과 함께). */
export const DEFAULT_IMAGE_PROMPT_MODEL_ID = 'google/gemini-3.8-flash';
/** 캐릭터 썸네일 상황 프롬프트 기본 모델 — 검열 재시도가 없는 경로라 GLM 5.3 Flash 유지. */
export const DEFAULT_THUMBNAIL_PROMPT_MODEL_ID = 'zai/glm-5.3-flash';

export function findImagePromptModel(id: string): ModelOption | undefined {
	return IMAGE_PROMPT_MODELS.find((m) => m.id === id);
}

/** 알 수 없는 모델의 보수적 기본 컨텍스트 상한. */
const FALLBACK_CONTEXT_LIMIT = 128_000;

/** 구독 브릿지 경유 모델(`bridge/<cli model>`) — Vercel AI Gateway 대신 homebox 브릿지로 호출. */
export const BRIDGE_MODEL_PREFIX = 'bridge/';
export function isBridgeModel(id: string): boolean {
	return id.startsWith(BRIDGE_MODEL_PREFIX);
}
/** 브릿지에 보낼 CLI 모델명(`bridge/claude-opus-4-6` → `claude-opus-4-6`). */
export function bridgeModelName(id: string): string {
	return id.slice(BRIDGE_MODEL_PREFIX.length);
}

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
