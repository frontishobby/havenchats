import type {
	CharacterImageSet,
	GridImageSet,
	ImageAxis,
	ImageEntry,
	NamedImage,
	NamedImageSet
} from '$lib/types';
import { imgSrc } from './imageBase';

/**
 * 장면 이미지 코드 유틸 (순수 함수 — 클라이언트·서버 공용).
 *
 * 두 가지 이미지 방식을 kind 판별자로 공존시킨다:
 *  - grid  : 축×조합. 모델이 **위치코드**({AAB})를 출력. 프롬프트 카탈로그가 축만 나열해
 *            조합 수에 안 휘둘림. 네이티브 제작 기본.
 *  - named : 플랫 이름 토큰. 모델이 본문에 `<img="name">` 을 출력. charx import·불규칙 세트용.
 *
 * 저장 포맷 통일: 메시지를 DB 에 저장할 때 두 방식 모두 **고정 토큰** {#<id>} 로 굳힌다
 *  → 이후 제작자가 축/값 순서나 이름을 바꿔도 과거 메시지가 안 흔들림.
 * 렌더러는 위치코드({AAB})·이미지 토큰(`<img="name">`)·고정 토큰({#id}) 을 모두 해석한다.
 */

/**
 * 축 값 코드 = 대문자 base-26, 축마다 고정 폭. 값이 26개 이하면 한 글자(A–Z),
 * 676개 이하면 두 글자(AA–ZZ). 폭은 값 개수에서 결정되므로 기존 세트(≤26)는 코드가 그대로다.
 * 위치코드 = 축 순서대로 각 축 코드를 이어 붙인 것({AAB}, {ABCD}…).
 */
const MAX_AXIS_VALUES = 26 * 26; // 최대 두 글자(AA–ZZ)

/** 장면 이미지 세트 제약(그리드 방식 — 클라이언트·서버 공용). */
export const IMAGE_LIMITS = {
	MAX_AXES: 4,
	MAX_AXIS_VALUES, // 축 값 = 최대 676개(코드 두 글자)
	AXIS_LABEL_MAX: 20,
	VALUE_LABEL_MAX: 20,
	MAX_ENTRIES: 6000 // 인물×상황 대량 세트(리리스 류 3,878장) 수용. named 와 동일 상한
} as const;

/** 값 개수에 따른 축 코드 폭(글자 수). */
export function axisWidth(valueCount: number): number {
	return valueCount > 26 ? 2 : 1;
}

/** 축 안의 value index → 고정 폭 base-26 코드("A", "AB"…). 범위 밖이면 '?' 반복. */
export function valueCode(valueCount: number, index: number): string {
	const w = axisWidth(valueCount);
	if (index < 0 || index >= valueCount || index >= 26 ** w) return '?'.repeat(w);
	let n = index;
	let s = '';
	for (let i = 0; i < w; i++) {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26);
	}
	return s;
}

/** 고정 폭 base-26 코드 → index. 대문자가 아니면 -1. */
function parseValueCode(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const d = s.charCodeAt(i) - 65;
		if (d < 0 || d > 25) return -1;
		n = n * 26 + d;
	}
	return n;
}

/** 플랫 네임드 방식 제약. import(charx) 는 대량 갤러리라 상한이 넉넉하다. */
export const NAMED_LIMITS = {
	MAX_IMAGES: 6000,
	NAME_MAX: 80
} as const;

// ─────────────────────────────────────────────────────────────
// 세트 종류 판별 (가드)
// ─────────────────────────────────────────────────────────────

/** 그리드 세트이고 실제로 쓸 만한지(축·조합 최소 1개씩). */
export function isGrid(set: CharacterImageSet | null | undefined): set is GridImageSet {
	return !!set && set.kind === 'grid' && set.axes.length > 0 && set.entries.length > 0;
}

/** 플랫 네임드 세트이고 실제로 쓸 만한지(이미지 최소 1장). */
export function isNamed(set: CharacterImageSet | null | undefined): set is NamedImageSet {
	return !!set && set.kind === 'named' && set.images.length > 0;
}

/** image_set 가 실제로 쓸 만한지(grid·named 무엇이든). */
export function hasScenes(set: CharacterImageSet | null | undefined): set is CharacterImageSet {
	return isGrid(set) || isNamed(set);
}

/**
 * 바이트가 로컬(브라우저 IndexedDB)에만 있는 세트인지(charx import 직후).
 * true 면 R2(/img) 가 아니라 IndexedDB 에서 blob 을 읽어 렌더해야 한다.
 */
export function isLocalSet(set: CharacterImageSet | null | undefined): boolean {
	return !!set && set.storage === 'local';
}

/**
 * 로컬(IndexedDB) 장면 이미지 키 — `<characterId>/<id>`.
 * localImages.ts 의 localSceneKey 와 동일 포맷(순수 함수라 여기에 둬 클라/서버 공용 해석).
 */
export function localSceneKey(characterId: string, id: string): string {
	return `${characterId}/${id}`;
}

// ─────────────────────────────────────────────────────────────
// 그리드(축×조합) — 위치코드
// ─────────────────────────────────────────────────────────────

/**
 * combo(축별 index) → 위치코드("AAB"). 축 정의를 주면 축별 폭(1~2글자)을 반영한다.
 * axes 를 생략하면 모든 축을 한 글자로 취급(값 26개 이하인 레거시 세트용). 범위 밖 index 는 '?'.
 */
export function comboToCode(combo: number[], axes?: ImageAxis[]): string {
	return combo.map((idx, ai) => valueCode(axes?.[ai]?.values.length ?? 26, idx)).join('');
}

/** 위치코드 → combo. 총 글자 수가 축 폭 합과 다르거나 범위를 벗어나면 null. */
export function codeToCombo(code: string, axes: GridImageSet['axes']): number[] | null {
	const total = axes.reduce((n, a) => n + axisWidth(a.values.length), 0);
	if (code.length !== total) return null;
	const combo: number[] = [];
	let pos = 0;
	for (const axis of axes) {
		const w = axisWidth(axis.values.length);
		const idx = parseValueCode(code.slice(pos, pos + w));
		if (idx < 0 || idx >= axis.values.length) return null;
		combo.push(idx);
		pos += w;
	}
	return combo;
}

/** id 로 조합 조회. */
export function findEntryById(set: GridImageSet, id: string): ImageEntry | null {
	return set.entries.find((e) => e.id === id) ?? null;
}

function findEntryByCombo(set: GridImageSet, combo: number[]): ImageEntry | null {
	const key = combo.join(',');
	return set.entries.find((e) => e.combo.join(',') === key) ?? null;
}

/** 위치코드로 조합 조회(현재 축/값 기준, 정확히 일치하는 조합만). */
export function findEntryByCode(set: GridImageSet, code: string): ImageEntry | null {
	const combo = codeToCombo(code, set.axes);
	if (!combo) return null;
	return findEntryByCombo(set, combo);
}

/**
 * 위치코드 조회 + 폴백. 정확한 조합이 없으면 `fallback` 이 지정된 축을 뒤에서부터
 * 하나씩 기본값으로 바꿔 가며 재시도한다(예: [인물][상황] 세트에서 그 인물의 해당 상황이
 * 없으면 상황=기본 으로). 희소 그리드(인물마다 상황 일부만 존재)에서 토큰이 숨겨지는 것 방지.
 */
export function findEntryByCodeWithFallback(set: GridImageSet, code: string): ImageEntry | null {
	const combo = codeToCombo(code, set.axes);
	if (!combo) return null;
	const exact = findEntryByCombo(set, combo);
	if (exact) return exact;
	const cur = [...combo];
	for (let ai = set.axes.length - 1; ai >= 0; ai--) {
		const fb = set.axes[ai].fallback;
		if (fb == null || fb < 0 || fb >= set.axes[ai].values.length || cur[ai] === fb) continue;
		cur[ai] = fb;
		const hit = findEntryByCombo(set, cur);
		if (hit) return hit;
	}
	return null;
}

/** R2 오브젝트 키: charimg/<characterId>/<entryId>.<ext> */
export function entryKey(characterId: string, entry: ImageEntry): string {
	return `charimg/${characterId}/${entry.id}.${entry.ext}`;
}

/**
 * 캐시 버스팅용 버전 쿼리(`?v=`) 부착. version 이 있을 때만 붙인다.
 * 같은 키(엔티티 id 고정)라도 재업로드 시 updatedAt 이 바뀌면 URL 이 달라져
 * → /img 라우트가 immutable 캐시를 안전하게 걸 수 있다. (url 은 쿼리 없는 /img/ 경로 가정)
 */
export function withVersion(url: string, version?: number | string | null): string {
	return version != null && version !== '' ? `${url}?v=${version}` : url;
}

/** 조합 이미지 URL (기존 /img/[...key] 라우트로 서빙). */
export function entryUrl(characterId: string, entry: ImageEntry, version?: number | string | null): string {
	return withVersion(imgSrc(entryKey(characterId, entry)), version);
}

/** 조합의 사람이 읽는 설명("홍길동 · 한복 · 화남"). alt/툴팁용. 범위 밖이면 '?'. */
export function entryAlt(set: GridImageSet, entry: ImageEntry): string {
	return entry.combo.map((vi, ai) => set.axes[ai]?.values[vi] ?? '?').join(' · ');
}

/**
 * 그리드 카탈로그. 조합(행)을 전부 나열하지 않고 **축의 의미만** 설명한다 — 조합이
 * 수천 개로 늘어도 인풋이 안 폭증하게. 모델은 각 축에서 하나씩 골라 코드를 조립한다.
 */
function buildGridCatalog(set: GridImageSet): string {
	const axisOrder = set.axes.map((a) => a.label).join('][');
	const axisLines = set.axes.map((a) => {
		const w = axisWidth(a.values.length);
		const vals = a.values.map((v, i) => `${valueCode(a.values.length, i)}=${v}`).join(', ');
		return `  - ${a.label}(${w}글자): ${vals}`;
	});
	return [
		`# 장면 이미지 (선택적 출력)`,
		`이야기 흐름상 한 장면이 떠오르면, 각 축에서 값을 하나씩 골라 그 코드를 [${axisOrder}] 순서로 이어 붙인 뒤 중괄호로 감싸 한 줄에 단독으로 출력하라. 예: {${comboToCode(set.entries[0].combo, set.axes)}}`,
		`- 축과 값(코드): 축마다 코드 글자 수가 정해져 있다(괄호 안).`,
		...axisLines,
		`규칙: 위 축 값 중에서만 골라 코드를 만들고, 장면이 실제로 바뀔 때만 출력한다. 본문 서술·대사는 평소대로 이어가라.`
	].join('\n');
}

// ─────────────────────────────────────────────────────────────
// 플랫 네임드 — `<img="name">`
// ─────────────────────────────────────────────────────────────

/** R2 오브젝트 키: charimg/<characterId>/<imageId>.<ext> (그리드와 동일 prefix). */
export function namedKey(characterId: string, img: NamedImage): string {
	return `charimg/${characterId}/${img.id}.${img.ext}`;
}

/** 네임드 이미지 URL. */
export function namedUrl(characterId: string, img: NamedImage, version?: number | string | null): string {
	return withVersion(imgSrc(namedKey(characterId, img)), version);
}

/** id 로 네임드 이미지 조회. */
export function findNamedById(set: NamedImageSet, id: string): NamedImage | null {
	return set.images.find((i) => i.id === id) ?? null;
}

/** 매칭 토큰(name)으로 네임드 이미지 조회. */
export function findNamedByName(set: NamedImageSet, name: string): NamedImage | null {
	return set.images.find((i) => i.name === name) ?? null;
}

/**
 * 네임드 카탈로그. 사용 가능한 이름을 그대로 나열해 모델이 정확한 토큰을 고르게 한다.
 * (import 카드의 경우 description 에 이미 출력 문법이 들어있을 수 있으나, 정확한 이름
 *  목록을 못박아 환각 토큰을 줄인다.)
 */
function buildNamedCatalog(set: NamedImageSet): string {
	const names = set.images.map((i) => i.name).join(', ');
	return [
		`# 장면 이미지 (선택적 출력)`,
		`이야기 흐름상 한 장면이 떠오르면, 아래 목록에서 알맞은 이름을 하나 골라 그 줄에 단독으로 \`<img="이름">\` 형식으로 출력하라. 장면이 실제로 바뀔 때만, 본문 서술·대사는 평소대로 이어가라.`,
		`목록에 **없는** 이름은 절대 만들지 말 것.`,
		`- 사용 가능한 이름: ${names}`
	].join('\n');
}

// ─────────────────────────────────────────────────────────────
// 통합 디스패처 (kind 분기)
// ─────────────────────────────────────────────────────────────

/**
 * 시스템 프롬프트에 붙일 장면 이미지 카탈로그. 캐릭터 단위로 고정(캐싱 prefix 유지).
 * 쓸 이미지가 없으면 빈 문자열.
 */
export function buildImageCatalog(set: CharacterImageSet | null | undefined): string {
	if (isGrid(set)) return buildGridCatalog(set);
	if (isNamed(set)) return buildNamedCatalog(set);
	return '';
}

// 위치코드 토큰(한 줄 단독): {ABC} — 대문자 1~8글자(축 4개 × 최대 2글자).
const POSITIONAL_LINE = /^\{([A-Z]{1,8})\}$/;
// 고정 토큰(한 줄 단독): {#<id>}
const PINNED_LINE = /^\{#([A-Za-z0-9_-]+)\}$/;
// 위치코드(본문 내 치환용, 전역).
const POSITIONAL_GLOBAL = /\{([A-Z]{1,8})\}/g;
// 이미지 토큰: <img="name"> (속성 사이 공백·self-closing 허용). name 캡처.
const IMG_LINE = /^<img\s*=\s*"([^"]+)"\s*\/?>$/i;
const IMG_GLOBAL = /<img\s*=\s*"([^"]+)"\s*\/?>/gi;
// 고정 토큰(본문 내, 전역).
const PINNED_GLOBAL = /\{#[A-Za-z0-9_-]+\}/g;

/**
 * 본문 내 장면 토큰을 제거한다 — 한 줄 단독이 아니라 문장 안에 박힌 토큰
 * ({#id}/{ABC}/`<img="name">`)이 산문으로 그대로 노출되는 것 방지.
 * (pinSceneCodes 가 전역 치환이라 인라인 토큰도 {#id} 로 굳어질 수 있음.)
 * 토큰만 지우고 주변 공백은 정리한다.
 */
export function stripSceneTokens(line: string): string {
	return line
		.replace(PINNED_GLOBAL, '')
		.replace(POSITIONAL_GLOBAL, '')
		.replace(IMG_GLOBAL, '')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/**
 * 메시지 저장 직전: 본문의 가변 토큰을 불변 토큰 {#<id>} 로 굳힌다.
 *  - grid  : 위치코드 {AAB} → {#id} (현재 축/값으로 해석되는 것만)
 *  - named : `<img="name">` → {#id} (이름이 매칭되는 것만)
 * 해석 안 되는 토큰은 그대로 둔다(렌더 시 숨김).
 */
export function pinSceneCodes(text: string, set: CharacterImageSet | null | undefined): string {
	if (isGrid(set)) {
		return text.replace(POSITIONAL_GLOBAL, (whole, code: string) => {
			const entry = findEntryByCodeWithFallback(set, code);
			return entry ? `{#${entry.id}}` : whole;
		});
	}
	if (isNamed(set)) {
		return text.replace(IMG_GLOBAL, (whole, name: string) => {
			const img = findNamedByName(set, name.trim());
			return img ? `{#${img.id}}` : whole;
		});
	}
	return text;
}

/** 해석된 장면 이미지 한 장(렌더용). */
export interface ResolvedScene {
	/** R2 servable URL. 로컬 세트면 빈 문자열(대신 localKey 로 IndexedDB 에서 읽는다). */
	url: string;
	alt: string;
	/** 로컬(IndexedDB) 세트일 때만 — blob 조회 키(`<characterId>/<id>`). */
	localKey?: string;
}

/** R2 URL 기반 ResolvedScene 을 로컬 세트면 localKey 형태로 보정. */
function decorateScene(
	scene: ResolvedScene,
	id: string,
	characterId: string,
	set: CharacterImageSet
): ResolvedScene {
	return isLocalSet(set)
		? { url: '', alt: scene.alt, localKey: localSceneKey(characterId, id) }
		: scene;
}

/** 고정 토큰 {#id} 해석(grid·named 공용). */
function resolvePinned(
	id: string,
	characterId: string,
	set: CharacterImageSet,
	version?: number | string | null
): ResolvedScene | null {
	if (isGrid(set)) {
		const entry = findEntryById(set, id);
		if (!entry) return null;
		return decorateScene({ url: entryUrl(characterId, entry, version), alt: entryAlt(set, entry) }, id, characterId, set);
	}
	if (isNamed(set)) {
		const img = findNamedById(set, id);
		if (!img) return null;
		return decorateScene({ url: namedUrl(characterId, img, version), alt: img.name }, id, characterId, set);
	}
	return null;
}

/**
 * 한 줄이 장면 이미지 토큰이면 해석해 반환, 아니면 null.
 * 고정 토큰({#id})·위치코드({AAB})·이미지 토큰(`<img="name">`) 모두 처리.
 * 알 수 없는 토큰은 null(=숨김).
 */
export function resolveSceneLine(
	line: string,
	characterId: string,
	set: CharacterImageSet | null | undefined,
	version?: number | string | null
): ResolvedScene | null {
	if (!hasScenes(set)) return null;

	const pinned = PINNED_LINE.exec(line);
	if (pinned) return resolvePinned(pinned[1], characterId, set, version);

	if (isGrid(set)) {
		const pos = POSITIONAL_LINE.exec(line);
		if (pos) {
			const entry = findEntryByCodeWithFallback(set, pos[1]);
			if (!entry) return null;
			return decorateScene({ url: entryUrl(characterId, entry, version), alt: entryAlt(set, entry) }, entry.id, characterId, set);
		}
	}

	if (isNamed(set)) {
		const img = IMG_LINE.exec(line);
		if (img) {
			const found = findNamedByName(set, img[1].trim());
			if (!found) return null;
			return decorateScene({ url: namedUrl(characterId, found, version), alt: found.name }, found.id, characterId, set);
		}
	}

	return null;
}

/**
 * 한 줄이 장면 토큰처럼 보이는지(완성/미완성 모두). resolveSceneLine 이 null 을 줬는데
 * 이게 true 면 = 알 수 없거나 스트리밍 중 미완성 토큰 → 텍스트로 노출하지 말고 숨긴다.
 * 예: "{AAB}", "{#e1a2}", "{AA"(스트리밍 중), `<img="...`(스트리밍 중), `<img="X">`(알 수 없는 이름).
 */
export function looksLikeSceneToken(line: string): boolean {
	return /^\{#?[A-Za-z0-9_-]*\}?$/.test(line) || /^<img\b/i.test(line);
}
