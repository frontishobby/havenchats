/**
 * Character Card V3 (charx `card.json`) → Haven 캐릭터 필드 매핑 (순수 함수).
 *
 * 클라이언트에서 charx 언집 직후 실행 → 서버엔 정제된 필드만 전송한다.
 * CBS 매크로는 베스트에포트로 해소($lib/import/cbs), 못 푼 게 있으면 warnings 에 남긴다.
 * 이미지는 named 방식 manifest 로 뽑아낸다(매칭 토큰 = asset 이름에서 트레일링 확장자 제거).
 */

import type { LoreEntry } from '$lib/types';
import { resolveCBSStatic } from '$lib/cbs';
import type { RisuLoreEntry } from './risum';
import type { ScriptArtifact } from './capabilities';

/** import 단계 상한 — 네이티브 폼(짧은 제약)과 달리 외부 카드라 넉넉하게. */
export const IMPORT_LIMITS = {
	NAME_MAX: 40,
	TAGLINE_MAX: 100,
	INTRO_MAX: 8000,
	DESC_MAX: 200000,
	GREETING_MAX: 50000,
	GREETINGS_MAX: 20,
	TAGS_MAX: 10
} as const;

/** import 시 허용하는 이미지 MIME (네이티브 폼보다 넓게 — 카드 원본 보존). */
export const IMPORT_IMAGE_EXT: Record<string, string> = {
	webp: 'webp',
	avif: 'avif',
	png: 'png',
	jpg: 'jpg',
	jpeg: 'jpg',
	gif: 'gif'
};

/** named 이미지 한 장의 출처(클라가 zip 에서 바이트를 꺼낼 때 사용). */
export interface ImportImage {
	/** 모델이 출력하는 매칭 토큰(asset 이름에서 트레일링 확장자 제거). */
	name: string;
	/** zip 내부 경로(uri 에서 embeded:// 제거). */
	srcPath: string;
	/** 확장자(webp|avif|png|jpg|gif). */
	ext: string;
}

export interface MappedCard {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	greetings: { name: string; content: string }[];
	tags: string[];
	/** 썸네일(icon) zip 경로. 없으면 null. */
	iconPath: string | null;
	iconExt: string | null;
	/** named 장면 이미지 manifest. */
	images: ImportImage[];
	/** card.json character_book 에서 추출한 로어북(키워드 동적 설정). 서버에서 module.risum 과 머지. */
	lorebook: LoreEntry[];
	/** 기본 변수(extensions.risuai.defaultVariables) → 세션 변수 시딩. 없으면 빈 객체. */
	defaultVariables: Record<string, string>;
	/** 수동 확인 권장 경고(스크립팅 손실 등). */
	warnings: string[];
	/** 재현 안 되는 원본 스크립트(트리거/정규식/코드) — '스크립트 분석'(실험적) 입력. charx 에서 채움. */
	scripts: ScriptArtifact[];
}

// ── V3 입력(느슨한 타입) ──
interface V3Asset {
	type?: string;
	uri?: string;
	name?: string;
	ext?: string;
}
interface V3BookEntry {
	keys?: unknown;
	secondary_keys?: unknown;
	content?: string;
	enabled?: boolean;
	constant?: boolean;
	insertion_order?: number;
	name?: string;
	comment?: string;
}
interface V3Data {
	name?: string;
	nickname?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	system_prompt?: string;
	post_history_instructions?: string;
	mes_example?: string;
	first_mes?: string;
	alternate_greetings?: unknown;
	creator_notes?: string;
	tags?: unknown;
	assets?: unknown;
	character_book?: { entries?: unknown };
	extensions?: { risuai?: { defaultVariables?: unknown } };
}
export interface V3Card {
	spec?: string;
	data?: V3Data;
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/** unknown(문자열 또는 문자열 배열)을 문자열 배열로. RisuAI 는 콤마 문자열, V3 는 배열을 쓴다. */
function strArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
	if (typeof v === 'string') return v.split(',').map((s) => s.trim());
	return [];
}

function genId(): string {
	return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Math.random()}`;
}

/**
 * RisuAI defaultVariables 파싱 → 변수 맵. 포맷이 제각각이라 방어적으로:
 *  - JSON 객체 → 그대로
 *  - 줄단위 문자열 → 각 줄 `name::value` / `name=value` (첫 구분자 기준)
 * 키는 소문자 정규화. 값은 문자열.
 */
function parseDefaultVars(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) return out;
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			const key = k.trim().toLowerCase();
			if (key && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
				out[key] = String(v);
			}
		}
		return out;
	}
	if (typeof raw === 'string') {
		for (const line of raw.split('\n')) {
			const m = line.match(/^\s*([^=:]+?)\s*(?:::|=)\s*(.*)$/);
			if (m) {
				const key = m[1].trim().toLowerCase();
				if (key) out[key] = m[2].trim();
			}
		}
	}
	return out;
}

function clip(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) : s;
}

/** 카드가 V3(chara_card_v3)인지 가볍게 확인. */
export function isV3Card(card: unknown): card is V3Card {
	const c = card as V3Card | null;
	return !!c && typeof c === 'object' && !!c.data && typeof c.data === 'object';
}

/** asset 이름 → 매칭 토큰: 트레일링 ".<ext>" 가 있으면 떼어낸다. */
function matchToken(name: string, ext: string): string {
	const suffix = `.${ext}`.toLowerCase();
	return name.toLowerCase().endsWith(suffix) ? name.slice(0, name.length - suffix.length) : name;
}

/** uri("embeded://assets/...") → zip 내부 경로. */
function uriToPath(uri: string): string {
	return uri.replace(/^embeded:\/\//i, '').replace(/^\.?\//, '');
}

/** V3 card.json → Haven 매핑. */
export function mapCardToCharacter(card: V3Card): MappedCard {
	const d = card.data ?? {};
	const warnings: string[] = [];

	// ── 이름 ──
	const name = clip(str(d.name) || str(d.nickname) || 'Unnamed', IMPORT_LIMITS.NAME_MAX).trim();

	// ── description(시스템 프롬프트) = persona + personality + scenario + system_prompt
	//    + post_history(이미지 문법·규칙) + 예시 대화 ──
	//    CBS 매크로는 **원시 그대로 보존**한다(평탄화 X) → 채팅 시 evalCBS 가 세션 변수로 동적 평가.
	//    (로어북은 description 에 접지 않고 별도 lorebook 으로 추출)
	const parts: string[] = [];
	const push = (header: string, body: string) => {
		const t = body.trim();
		if (t) parts.push(header ? `# ${header}\n${t}` : t);
	};
	push('', str(d.description));
	push('성격', str(d.personality));
	push('상황', str(d.scenario));
	if (str(d.system_prompt).trim()) push('시스템 지침', str(d.system_prompt));

	// 로어북: enabled 인 모든 항목을 LoreEntry 로 추출(constant + 키워드형 모두). content 는 원시 CBS 보존.
	const bookEntries = Array.isArray(d.character_book?.entries)
		? (d.character_book!.entries as V3BookEntry[])
		: [];
	const lorebook: LoreEntry[] = [];
	for (const e of bookEntries) {
		if (!e || e.enabled === false) continue;
		const content = str(e.content).trim();
		if (!content) continue;
		const constant = e.constant === true;
		const keys = [...strArray(e.keys), ...strArray(e.secondary_keys)].map((k) => k.trim());
		const cleanKeys = keys.filter(Boolean);
		if (!constant && cleanKeys.length === 0) continue; // 영영 안 켜지는 항목은 버림
		lorebook.push({
			id: genId(),
			keys: cleanKeys,
			content: clip(content, IMPORT_LIMITS.GREETING_MAX),
			constant,
			order: typeof e.insertion_order === 'number' ? e.insertion_order : 0
		});
	}

	if (str(d.post_history_instructions).trim()) push('이미지·출력 규칙', str(d.post_history_instructions));
	if (str(d.mes_example).trim()) push('예시 대화', str(d.mes_example));

	const description = clip(parts.join('\n\n').trim(), IMPORT_LIMITS.DESC_MAX);

	// 기본 변수(extensions.risuai.defaultVariables) → 세션 변수 시딩.
	const defaultVariables = parseDefaultVars(d.extensions?.risuai?.defaultVariables);

	// ── 소개/설명(표시용 — 정적 평탄화) ──
	const notes = resolveCBSStatic(str(d.creator_notes)).trim();
	const intro = clip(notes, IMPORT_LIMITS.INTRO_MAX);
	// tagline: 마크업(헤더/코드/인용/리스트/표)·짧은 줄을 건너뛰고 첫 산문 줄. 없으면 기본값.
	const prose = notes
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length >= 12 && !/^[#>\-*|`~=]/.test(l) && !/^```/.test(l));
	const tagline = clip(prose || name, IMPORT_LIMITS.TAGLINE_MAX);

	// ── 오프닝(first_mes + alternate_greetings) ──
	const rawGreetings: string[] = [str(d.first_mes)];
	if (Array.isArray(d.alternate_greetings)) {
		for (const g of d.alternate_greetings) rawGreetings.push(str(g));
	}
	const greetings = rawGreetings
		// 오프닝은 세션 시작 시 seq=1 로 박제 → 정적 평탄화(현재 상태 없음).
		.map((g) => clip(resolveCBSStatic(g).trim(), IMPORT_LIMITS.GREETING_MAX))
		.filter((g) => g.length >= 20) // CBS 분기 후 빈/잔여 오프닝 제거
		.slice(0, IMPORT_LIMITS.GREETINGS_MAX)
		.map((content, i) => ({ name: i === 0 ? '기본' : `상황 ${i + 1}`, content }));

	// ── 태그 ──
	const tags = (Array.isArray(d.tags) ? d.tags : [])
		.filter((t): t is string => typeof t === 'string')
		.map((t) => t.trim().replace(/^#/, ''))
		.filter(Boolean)
		.slice(0, IMPORT_LIMITS.TAGS_MAX);

	// ── 에셋: icon(썸네일) + 장면 이미지(named) ──
	const assets = (Array.isArray(d.assets) ? d.assets : []) as V3Asset[];
	let iconPath: string | null = null;
	let iconExt: string | null = null;
	const images: ImportImage[] = [];
	const seen = new Set<string>();

	for (const a of assets) {
		const uri = str(a.uri);
		const ext = (str(a.ext) || uri.split('.').pop() || '').toLowerCase();
		if (!uri) continue;
		const path = uriToPath(uri);

		if (a.type === 'icon') {
			if (!iconPath) {
				iconPath = path;
				iconExt = IMPORT_IMAGE_EXT[ext] ?? 'png';
			}
			continue;
		}
		// 장면 이미지(x-risu-asset 등). 이미지 확장자만.
		const normExt = IMPORT_IMAGE_EXT[ext];
		if (!normExt) continue;
		const token = matchToken(str(a.name), ext);
		if (!token || seen.has(token)) continue;
		seen.add(token);
		images.push({ name: token, srcPath: path, ext: normExt });
	}

	// CBS(변수/조건/랜덤)는 이제 채팅 시 동적 평가되므로 별도 경고 없음(트리거/정규식/CJS 경고는 capabilities 가 담당).

	return {
		name,
		tagline,
		intro,
		description,
		greetings,
		tags,
		iconPath,
		iconExt,
		images,
		lorebook,
		defaultVariables,
		warnings,
		scripts: []
	};
}

/** RisuAI module.risum 의 loreBook 항목들을 LoreEntry[] 로 변환. key 는 콤마 구분, mode/alwaysActive 로 상시 판단. */
export function moduleLorebookToEntries(entries: RisuLoreEntry[] | undefined): LoreEntry[] {
	if (!Array.isArray(entries)) return [];
	const out: LoreEntry[] = [];
	for (const e of entries) {
		const content = str(e?.content).trim();
		if (!content) continue;
		const constant = e.constant === true || e.alwaysActive === true || e.mode === 'constant';
		const keys = [...strArray(e.key), ...strArray(e.secondkey)].map((k) => k.trim()).filter(Boolean);
		if (!constant && keys.length === 0) continue;
		out.push({
			id: genId(),
			keys,
			content: clip(content, IMPORT_LIMITS.GREETING_MAX),
			constant,
			order: typeof e.insertorder === 'number' ? e.insertorder : 0
		});
	}
	return out;
}

/** 두 로어북을 합치고 content(정규화) 기준 중복 제거. card.json 항목을 우선(앞)에 둔다. */
export function mergeLorebook(a: LoreEntry[], b: LoreEntry[]): LoreEntry[] {
	const seen = new Set<string>();
	const out: LoreEntry[] = [];
	for (const e of [...a, ...b]) {
		const k = e.content.replace(/\s+/g, ' ').trim().toLowerCase();
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(e);
	}
	return out;
}
