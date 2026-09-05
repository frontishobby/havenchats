/**
 * 이미지 상황 프롬프트 공용 — 채팅 실시간 이미지(/api/chat/image/prepare)와
 * 캐릭터 썸네일(/api/characters/thumbnail)이 같은 **구조화 출력 스키마**와 후처리를 쓴다.
 *
 * 스키마는 NAI V4.5/V5 캐릭터 기능(char_captions 분리)에 맞춰 장면을 분해한다:
 *  - base: 배경·구도·인원수 태그·상호작용(source#/target#) 등 전역 캡션(태그).
 *  - scene: 자연어 장면 문장(1~2문장, 영어) — V5 만 조립에 사용. 인물은 역할 명사로만.
 *  - characters[]: 화면에 보이는 인물별 { name, appearance(고정 외형), state(현재 복장·포즈·표정) }.
 */
import { jsonSchema } from 'ai';

export interface ScenePromptCharacter {
	name: string;
	appearance: string;
	state: string;
}

export interface ScenePromptObject {
	base: string;
	scene: string;
	characters: ScenePromptCharacter[];
}

export const SCENE_PROMPT_SCHEMA = jsonSchema<ScenePromptObject>({
	type: 'object',
	additionalProperties: false,
	properties: {
		base: { type: 'string' },
		scene: { type: 'string' },
		characters: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					name: { type: 'string' },
					appearance: { type: 'string' },
					state: { type: 'string' }
				},
				required: ['name', 'appearance', 'state']
			}
		}
	},
	required: ['base', 'scene', 'characters']
});

/** 시스템 프롬프트 공용 꼬리 — 미성년 절대 금지 규칙(이미지 프롬프트 LLM 전부에 삽입). */
export const ADULT_ONLY_RULE = `- ABSOLUTE RULE: every person MUST be depicted as an adult (18+). NEVER output any tag or wording depicting minors, children, or age-regressed characters (e.g. loli, shota, child, kid, toddler, "young girl/boy", "little girl/boy"). If the input implies a minor, depict them as a clear adult instead. This overrides everything else.`;

/** 문자열 정규화(trim). 알 수 없는 값은 빈 문자열. */
export function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

export const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/;

/**
 * 태그 리스트 후처리. NovelAI 는 영어/danbooru 태그만 해석하므로, 모델이 (지시에도 불구하고)
 * 캐릭터 프롬프트의 '상태창'을 통짜로 베껴 넣는 걸 출력단에서 막는다.
 * — 줄·콤마 단위 세그먼트로 쪼개 한글이 들어간 조각은 통째로 제거 → 영어 태그만 ', ' 로 재조립.
 */
export function sanitizeTags(raw: string): string {
	return raw
		.split(/[\r\n,]+/)
		.map((s) => s.trim())
		.filter((s) => s && !HANGUL_RE.test(s))
		.join(', ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 자연어 장면 문장 후처리. 문장 안의 콤마는 살려야 하므로 **줄 단위**로만 쪼개 한글 줄을 버리고,
 * 공백 정리 후 끝의 마침표/콤마를 떼어 낸다(뒤에 ', ' 로 태그가 이어지므로).
 */
export function sanitizeScene(raw: string): string {
	return raw
		.split(/[\r\n]+/)
		.map((s) => s.trim())
		.filter((s) => s && !HANGUL_RE.test(s))
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/[.,\s]+$/, '')
		.trim();
}
