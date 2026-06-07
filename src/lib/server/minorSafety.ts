/**
 * 미성년/아동 코드 용어 하드 차단(클라·LLM 무관, 서버 최종 게이트).
 *
 * 한국법상 가상 아동성착취물은 형사처벌 대상이라, 모델 지시(소프트)만으론 부족하다.
 * 이미지 최종 positive 프롬프트를 보내기 직전에 이 검사로 **fail-closed**(감지 시 생성 거부)한다.
 * 오탐(드문 SFW 문장)으로 인한 거부 비용 < 미탐으로 인한 형사 리스크 → 거부 쪽으로 편향.
 */

/** 아동/미성년 코드 용어(영문 이미지 프롬프트 기준). danbooru 태그 + 자연어 혼합. */
const MINOR_TERMS = [
	'loli',
	'lolicon',
	'shota',
	'shotacon',
	'toddlercon',
	'toddler',
	'infant',
	'newborn',
	'baby',
	'child',
	'children',
	'kid',
	'kids',
	'preteen',
	'pre-teen',
	'underage',
	'minor',
	'little girl',
	'little boy',
	'young girl',
	'young boy',
	'elementary school',
	'kindergarten',
	'age regression',
	'age regressed',
	'age-regressed',
	'aged down',
	'aged-down'
];

function escapeRe(s: string): string {
	return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\s+/g, '\\s+');
}

const MINOR_RE = new RegExp(`\\b(?:${MINOR_TERMS.map(escapeRe).join('|')})\\b`, 'i');

/** 이미지 프롬프트에 아동/미성년 코드 용어가 들어있으면 true(생성 거부 대상). */
export function containsMinorTerms(prompt: string): boolean {
	return MINOR_RE.test(prompt);
}
