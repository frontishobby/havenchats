import type { CharacterImageSet, ImageEntry } from '$lib/types';

/**
 * 장면 이미지 코드 유틸 (순수 함수 — 클라이언트·서버 공용).
 *
 * 용어
 *  - 위치코드(positional code): "AAB" 같은 축 개수만큼의 고정폭 문자열. 각 글자가
 *    해당 축에서 몇 번째 값인지를 A=0, B=1 … 로 가리킨다. 모델이 출력하는 형식.
 *  - 고정 토큰(pinned token): "{#<entryId>}". 메시지를 DB 에 저장할 때 위치코드를
 *    조합의 불변 id 로 굳혀 둔 형식 → 이후 제작자가 값 순서·축을 바꿔도 안 흔들림.
 *
 * 렌더러는 두 형식을 모두 해석한다(스트리밍=위치코드, 재로드=고정 토큰).
 */

const MAX_AXIS_VALUES = 26; // A–Z

/** 장면 이미지 세트 제약(클라이언트·서버 공용). */
export const IMAGE_LIMITS = {
	MAX_AXES: 4,
	MAX_AXIS_VALUES, // 코드 한 글자 = A–Z
	AXIS_LABEL_MAX: 20,
	VALUE_LABEL_MAX: 20,
	MAX_ENTRIES: 50
} as const;

/** combo(축별 index) → 위치코드("AAB"). 범위 밖 index 는 '?' 로(방어적). */
export function comboToCode(combo: number[]): string {
	return combo
		.map((i) => (i >= 0 && i < MAX_AXIS_VALUES ? String.fromCharCode(65 + i) : '?'))
		.join('');
}

/** 위치코드 → combo. 글자 수가 축 개수와 다르거나 범위를 벗어나면 null. */
export function codeToCombo(code: string, axes: CharacterImageSet['axes']): number[] | null {
	if (code.length !== axes.length) return null;
	const combo: number[] = [];
	for (let i = 0; i < code.length; i++) {
		const idx = code.charCodeAt(i) - 65; // 'A' → 0
		if (idx < 0 || idx >= axes[i].values.length) return null;
		combo.push(idx);
	}
	return combo;
}

/** id 로 조합 조회. */
export function findEntryById(set: CharacterImageSet, id: string): ImageEntry | null {
	return set.entries.find((e) => e.id === id) ?? null;
}

/** 위치코드로 조합 조회(현재 축/값 기준). */
export function findEntryByCode(set: CharacterImageSet, code: string): ImageEntry | null {
	const combo = codeToCombo(code, set.axes);
	if (!combo) return null;
	const key = combo.join(',');
	return set.entries.find((e) => e.combo.join(',') === key) ?? null;
}

/** R2 오브젝트 키: charimg/<characterId>/<entryId>.<ext> */
export function entryKey(characterId: string, entry: ImageEntry): string {
	return `charimg/${characterId}/${entry.id}.${entry.ext}`;
}

/** 조합 이미지 URL (기존 /img/[...key] 라우트로 서빙). */
export function entryUrl(characterId: string, entry: ImageEntry): string {
	return `/img/${entryKey(characterId, entry)}`;
}

/** 조합의 사람이 읽는 설명("홍길동 · 한복 · 화남"). alt/툴팁용. 범위 밖이면 '?'. */
export function entryAlt(set: CharacterImageSet, entry: ImageEntry): string {
	return entry.combo
		.map((vi, ai) => set.axes[ai]?.values[vi] ?? '?')
		.join(' · ');
}

/** image_set 가 실제로 쓸 만한지(축·조합 최소 1개씩). */
export function hasScenes(set: CharacterImageSet | null | undefined): set is CharacterImageSet {
	return !!set && set.axes.length > 0 && set.entries.length > 0;
}

/**
 * 시스템 프롬프트에 붙일 장면 이미지 카탈로그. 캐릭터 단위로 고정(캐싱 prefix 유지).
 * 조합(행)을 전부 나열하지 않고 **축의 의미만** 설명한다 — 조합이 수천 개까지
 * 늘어도 인풋이 폭증하지 않게. 모델은 각 축에서 하나씩 골라 코드를 조립한다.
 * 존재하지 않는 조합을 출력하면 프론트가 조용히 무시한다(렌더 시 숨김).
 * 쓸 조합이 없으면 빈 문자열.
 */
export function buildImageCatalog(set: CharacterImageSet | null | undefined): string {
	if (!hasScenes(set)) return '';
	const axisOrder = set.axes.map((a) => a.label).join('][');
	// 축별 값 → 글자 매핑. (values 순서가 곧 코드 글자: 0→A, 1→B …)
	const axisLines = set.axes.map((a) => {
		const vals = a.values.map((v, i) => `${String.fromCharCode(65 + i)}=${v}`).join(', ');
		return `  - ${a.label}: ${vals}`;
	});
	return [
		`# 장면 이미지 (선택적 출력)`,
		`이야기 흐름상 한 장면이 떠오르면, 각 축에서 값을 하나씩 골라 그 글자들을 [${axisOrder}] 순서로 이어 붙인 코드를 중괄호로 감싸 한 줄에 단독으로 출력하라. 예: {${comboToCode(set.entries[0].combo)}}`,
		`- 축과 값(글자):`,
		...axisLines,
		`규칙: 위 축 값 중에서만 골라 코드를 만들고, 장면이 실제로 바뀔 때만 출력한다. 본문 서술·대사는 평소대로 이어가라.`
	].join('\n');
}

// 위치코드 토큰(한 줄 단독): {ABC} — 대문자 1~8글자.
const POSITIONAL_LINE = /^\{([A-Z]{1,8})\}$/;
// 고정 토큰(한 줄 단독): {#<id>}
const PINNED_LINE = /^\{#([A-Za-z0-9_-]+)\}$/;
// 위치코드(본문 내 치환용, 전역).
const POSITIONAL_GLOBAL = /\{([A-Z]{1,8})\}/g;

/**
 * 메시지 저장 직전: 본문의 위치코드 {AAB} 중 현재 image_set 으로 해석되는 것을
 * 불변 토큰 {#<id>} 로 치환한다. 해석 안 되는 코드는 그대로 둔다(렌더 시 숨김).
 */
export function pinSceneCodes(text: string, set: CharacterImageSet | null | undefined): string {
	if (!hasScenes(set)) return text;
	return text.replace(POSITIONAL_GLOBAL, (whole, code: string) => {
		const entry = findEntryByCode(set, code);
		return entry ? `{#${entry.id}}` : whole;
	});
}

/** 해석된 장면 이미지 한 장(렌더용). */
export interface ResolvedScene {
	url: string;
	alt: string;
}

/**
 * 한 줄이 장면 이미지 토큰이면 해석해 반환, 아니면 null.
 * 고정 토큰({#id})·위치코드({AAB}) 모두 처리. 알 수 없는 토큰은 null(=숨김).
 */
export function resolveSceneLine(
	line: string,
	characterId: string,
	set: CharacterImageSet | null | undefined
): ResolvedScene | null {
	if (!hasScenes(set)) return null;
	const pinned = PINNED_LINE.exec(line);
	if (pinned) {
		const entry = findEntryById(set, pinned[1]);
		return entry ? { url: entryUrl(characterId, entry), alt: entryAlt(set, entry) } : null;
	}
	const pos = POSITIONAL_LINE.exec(line);
	if (pos) {
		const entry = findEntryByCode(set, pos[1]);
		return entry ? { url: entryUrl(characterId, entry), alt: entryAlt(set, entry) } : null;
	}
	return null;
}

/**
 * 한 줄이 장면 토큰처럼 보이는지(완성/미완성 모두). resolveSceneLine 이 null 을 줬는데
 * 이게 true 면 = 알 수 없거나 스트리밍 중 미완성 토큰 → 텍스트로 노출하지 말고 숨긴다.
 * 예: "{AAB}", "{#e1a2}", "{AA"(스트리밍 중), "{XYZ}"(알 수 없는 코드), "{".
 */
export function looksLikeSceneToken(line: string): boolean {
	return /^\{#?[A-Za-z0-9_-]*\}?$/.test(line);
}
