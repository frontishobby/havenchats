/**
 * imported 카드(RisuAI charx)의 **editdisplay 정규식**(표시용 HTML 치환) 추출·적용 + 에셋 리졸버.
 *
 * 일부 수입 카드는 모델이 출력한 `<img="감정">` 마커를 editdisplay 정규식으로 `<style>`+`<div>`+`<img>`
 * 생 HTML(감정 스프라이트)로 바꾼다. out 템플릿엔 CBS(`{{raw::name}}`/`{{#each {{assetlist}}…}}`)가
 * 박혀 있어, 적용 순서는 **① 정규식 in→out 치환($캡처) → ② CBS 평가(에셋 리졸브) → ③ HTML 세정**.
 * (③ 은 htmlRender.ts) 원본: RisuAI process/scripts.ts(정규식)·parser.svelte.ts(에셋).
 *
 * editdisplay 만 다룬다 — editoutput/editprocess(텍스트 가공)·HTML 없는 치환은 범위 밖.
 */
import { evalCBS, makeRng, type CbsContext } from '../cbs';
import { isNamed, namedUrl } from '../imageCodes';
import type { CharacterImageSet, DisplayScript, NamedImage } from '../types';
import type { RisuModuleMeta } from './risum';

export type { DisplayScript };

/** RisuAI flag 정규화(scripts.ts:156-174): ableFlag 면 flag, 아니면 'g'. 미지원 flag 제거·중복 제거. */
function normFlags(r: { flag?: unknown; ableFlag?: unknown }): string {
	let flag = 'g';
	if (r.ableFlag && typeof r.flag === 'string') flag = r.flag;
	flag = flag.trim().replace(/[^dgimsuvy]/g, '');
	flag = [...flag].filter((v, i, a) => a.indexOf(v) === i).join('');
	return flag || 'u';
}

/** module.risum 의 regex[] 에서 editdisplay 만 뽑아 DisplayScript[] 로. (import 시 1회) */
export function extractDisplayScripts(module: RisuModuleMeta | null): DisplayScript[] {
	const out: DisplayScript[] = [];
	for (const raw of (module?.regex ?? []) as Array<Record<string, unknown>>) {
		if (!raw || raw.type !== 'editdisplay') continue;
		const inPat = typeof raw.in === 'string' ? raw.in : '';
		const outTpl = typeof raw.out === 'string' ? raw.out : '';
		if (!inPat) continue; // 빈 in(에디터 구분선 등) 스킵
		out.push({ in: inPat, out: outTpl, flags: normFlags(raw) });
	}
	return out;
}

/** 컴파일된 스크립트(런타임). 잘못된 정규식은 컴파일 단계에서 탈락. */
export interface CompiledScript {
	re: RegExp;
	out: string;
}

export function compileScripts(scripts: DisplayScript[] | null | undefined): CompiledScript[] {
	const out: CompiledScript[] = [];
	for (const s of scripts ?? []) {
		try {
			out.push({ re: new RegExp(s.in, s.flags), out: s.out.replaceAll('$n', '\n') });
		} catch {
			// 손상/미지원 정규식 → 무시
		}
	}
	return out;
}

/** ReDoS 방어: 너무 긴 입력엔 정규식을 돌리지 않는다(Workers/브라우저 동기 타임아웃 부재 대비). */
const MAX_DISPLAY_INPUT = 8000;

/**
 * 한 줄에 표시 스크립트들을 순서대로 적용. 하나라도 매칭돼 바뀌면 changed=true.
 * 반환 text 는 아직 CBS 미평가 상태(out 템플릿). JS 정규식이 `$1`/`$&`/`$<name>` 치환을 담당.
 */
export function applyDisplayScripts(
	text: string,
	compiled: CompiledScript[]
): { text: string; changed: boolean } {
	if (text.length > MAX_DISPLAY_INPUT) return { text, changed: false };
	let changed = false;
	for (const c of compiled) {
		c.re.lastIndex = 0;
		if (!c.re.test(text)) continue;
		c.re.lastIndex = 0;
		text = text.replace(c.re, c.out);
		changed = true;
	}
	return { text, changed };
}

// ── 에셋 리졸버 (NamedImageSet name → /img URL) ──

const IMG_EXT = /\.(webp|png|jpe?g|gif|avif|bmp)$/i;

/** 간단 편집거리(퍼지 폴백용). a,b 짧을 때만 호출. */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (Math.abs(m - n) > 6) return 99; // 길이 차 크면 후보 제외(조기 컷)
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let cur = new Array(n + 1);
	for (let i = 1; i <= m; i++) {
		cur[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, cur] = [cur, prev];
	}
	return prev[n];
}

export interface AssetResolver {
	/** assetlist 용 이름 목록(원본 케이스). */
	names: string[];
	/** raw/path → URL, img/asset/emotion → `<img>`. 못 찾으면 ''. */
	resolve: (name: string, type: string) => string;
}

/** NamedImageSet 기반 에셋 리졸버. exact → 확장자 제거 → 퍼지(편집거리) 순으로 매칭(대소문자 무시). */
export function makeAssetResolver(set: CharacterImageSet | null, charId: string): AssetResolver {
	if (!isNamed(set)) return { names: [], resolve: () => '' };
	const byName = new Map<string, NamedImage>();
	for (const img of set.images) byName.set(img.name.toLowerCase(), img);
	const names = set.images.map((i) => i.name);

	const find = (rawName: string): NamedImage | null => {
		const name = rawName.trim().toLowerCase();
		if (!name) return null;
		let img = byName.get(name) ?? byName.get(name.replace(IMG_EXT, ''));
		if (img) return img;
		// 퍼지 폴백 — 가장 가까운 이름(거리 ≤ 3).
		let best: NamedImage | null = null;
		let bestDist = 4;
		const target = name.replace(IMG_EXT, '');
		for (const [key, candidate] of byName) {
			const d = levenshtein(target, key);
			if (d < bestDist) {
				bestDist = d;
				best = candidate;
			}
		}
		return best;
	};

	return {
		names,
		resolve: (rawName, type) => {
			const img = find(rawName);
			if (!img) return '';
			const url = namedUrl(charId, img);
			if (type === 'raw' || type === 'path' || type === 'bg' || type === 'bgm') return url;
			return `<img src="${url}" alt="" loading="lazy">`;
		}
	};
}

/**
 * 표시 스크립트 한 줄 처리: 정규식 적용 → (매칭 시) CBS 평가까지. CBS 결과 HTML 문자열 반환(미매칭이면 null).
 * 세정(renderCardHtml)은 호출부에서. seed 로 변형 랜덤이 결정적이 된다(재렌더 안정).
 */
export function evalDisplayLine(
	line: string,
	compiled: CompiledScript[],
	resolver: AssetResolver,
	seed: string,
	now: number
): string | null {
	if (!compiled.length) return null;
	const applied = applyDisplayScripts(line, compiled);
	if (!applied.changed) return null;
	const ctx: CbsContext = {
		vars: {},
		index: 0,
		lang: 'ko',
		rng: makeRng(seed),
		now,
		assets: resolver.names,
		resolveAsset: resolver.resolve,
		temp: {}
	};
	return evalCBS(applied.text, ctx).text;
}
