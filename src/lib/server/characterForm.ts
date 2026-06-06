import type {
	Audience,
	CharacterLorebook,
	CharacterScriptData,
	ContentRating,
	ImageAxis,
	Opening,
	Visibility
} from '$lib/types';
import { IMAGE_LIMITS, NAMED_LIMITS, comboToCode } from '$lib/imageCodes';
import { normalizeLoreEntries } from '$lib/lorebook';
import { estimatePromptTokens } from '$lib/tokens';

/** 허용 이미지 타입 → 확장자. (webp/avif 만) */
export const ALLOWED_IMAGE: Record<string, string> = {
	'image/webp': 'webp',
	'image/avif': 'avif'
};
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB

const NAME_MAX = 15;
const TAGLINE_MAX = 100;
const INTRO_MAX = 3000;
// 프롬프트 제한은 글자가 아니라 추정 토큰 기준(영어가 글자 수로 불이익 안 받게). $lib/tokens 참고.
// charx import 한 대형 카드도 편집 가능하도록 넉넉히.
const DESC_TOKEN_MAX = 8000;
const TAGS_MAX = 5;
const GREETING_MAX = 4000;
const GREETING_NAME_MAX = 30;
const GREETINGS_MAX = 5;
// 스크립트 기본 변수(import 캐릭터): 관리자 편집 전용. 폭주 방지용 상한.
const SCRIPT_VARS_MAX = 100;
const SCRIPT_VAR_KEY_MAX = 80;
const SCRIPT_VAR_VALUE_MAX = 4000;

export interface ParsedCharacterForm {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	audience: Audience;
	contentRating: ContentRating;
	visibility: Visibility;
	tags: string[];
	greetings: Opening[];
	/** 로어북(키워드 동적 설정). 없으면 null. */
	lorebook: CharacterLorebook | null;
	/** 스크립트 기본 변수(import 캐릭터의 defaultVariables). 폼에 없거나 비면 null. */
	scriptData: CharacterScriptData | null;
	/** 제작자 추천 그림체 id(선택). 없으면 null. */
	recommendedStyleId: string | null;
	/** 업로드된 이미지(있으면). 없으면 null. */
	image: File | null;
}

type ParseResult =
	| { ok: true; data: ParsedCharacterForm }
	| { ok: false; error: string };

/**
 * /api/characters POST·PUT 공용 폼 파싱 + 검증.
 * 이미지 필수 여부는 호출부에서 판단한다(생성=필수, 수정=선택).
 * 이미지가 들어온 경우 타입·용량은 여기서 검증한다.
 */
export function parseCharacterForm(form: FormData): ParseResult {
	const name = String(form.get('name') ?? '').trim();
	const tagline = String(form.get('tagline') ?? '').trim();
	const intro = String(form.get('intro') ?? '').trim();
	const description = String(form.get('description') ?? '').trim();
	const audienceRaw = String(form.get('audience') ?? 'all');
	const nsfw = String(form.get('contentRating') ?? 'sfw') === 'nsfw';
	const isPrivate = String(form.get('visibility') ?? 'public') === 'private';
	const recommendedStyleId = String(form.get('recommendedStyleId') ?? '').trim() || null;
	const imageRaw = form.get('image');

	let tags: string[] = [];
	try {
		const parsed = JSON.parse(String(form.get('tags') ?? '[]'));
		if (Array.isArray(parsed)) tags = parsed;
	} catch {
		// 무시 — 빈 배열로 처리
	}

	let greetingsRaw: unknown[] = [];
	try {
		const parsed = JSON.parse(String(form.get('greetings') ?? '[]'));
		if (Array.isArray(parsed)) greetingsRaw = parsed;
	} catch {
		// 무시 — 아래 검증에서 걸러짐
	}

	// 로어북(선택): JSON 배열 → 정규화(키워드·길이·개수 clamp). 손상/빈값이면 null.
	let lorebook: CharacterLorebook | null = null;
	try {
		lorebook = normalizeLoreEntries(JSON.parse(String(form.get('lorebook') ?? '[]')));
	} catch {
		// 무시 — null 유지
	}

	// 스크립트 기본 변수(선택, 관리자 import 편집 전용): {defaultVariables:{key:value}}.
	// 필드가 아예 없으면 null(=호출부에서 기존 값 보존), 있으면 키 정규화·clamp 후 반영.
	const scriptData = parseScriptDataField(form.get('scriptData'));

	// ── 검증 ──
	if (!name) return { ok: false, error: '제목을 입력해 주세요.' };
	if (name.length > NAME_MAX) return { ok: false, error: `제목은 ${NAME_MAX}자 이내로 입력해 주세요.` };
	if (!tagline) return { ok: false, error: '소개를 입력해 주세요.' };
	if (tagline.length > TAGLINE_MAX)
		return { ok: false, error: `소개는 ${TAGLINE_MAX}자 이내로 입력해 주세요.` };
	if (intro.length > INTRO_MAX) return { ok: false, error: `설명은 ${INTRO_MAX}자 이내로 입력해 주세요.` };
	if (!description) return { ok: false, error: '프롬프트를 입력해 주세요.' };
	if (estimatePromptTokens(description) > DESC_TOKEN_MAX)
		return { ok: false, error: `프롬프트가 너무 길어요 (약 ${DESC_TOKEN_MAX} 토큰 이내).` };

	const audience: Audience =
		audienceRaw === 'male' || audienceRaw === 'female' ? audienceRaw : 'all';
	const contentRating: ContentRating = nsfw ? 'nsfw' : 'sfw';
	const visibility: Visibility = isPrivate ? 'private' : 'public';

	const tagsClean = tags
		.filter((t): t is string => typeof t === 'string')
		.map((t) => t.trim().replace(/^#/, ''))
		.filter(Boolean)
		.slice(0, TAGS_MAX);

	const mappedGreetings = greetingsRaw.map((g) => {
		const o = (g ?? {}) as { name?: unknown; content?: unknown };
		return {
			name: (typeof o.name === 'string' ? o.name : '').trim().slice(0, GREETING_NAME_MAX),
			content: (typeof o.content === 'string' ? o.content : '').trim()
		};
	});
	const filledGreetings = mappedGreetings.filter((g) => g.name || g.content);
	if (filledGreetings.length === 0)
		return { ok: false, error: '기본 첫 상황을 1개 이상 입력해 주세요.' };
	if (filledGreetings.some((g) => !g.content))
		return { ok: false, error: '첫 상황 본문을 입력해 주세요.' };
	if (filledGreetings.some((g) => !g.name))
		return { ok: false, error: '각 첫 상황의 이름을 입력해 주세요.' };
	if (filledGreetings.some((g) => g.content.length > GREETING_MAX))
		return { ok: false, error: `첫 상황은 각각 ${GREETING_MAX}자 이내로 입력해 주세요.` };
	const greetings = filledGreetings.slice(0, GREETINGS_MAX);

	// 이미지(선택): 들어왔으면 타입·용량 검증.
	let image: File | null = null;
	if (imageRaw instanceof File && imageRaw.size > 0) {
		if (!ALLOWED_IMAGE[imageRaw.type])
			return { ok: false, error: '썸네일은 webp 또는 avif 이미지만 가능합니다.' };
		if (imageRaw.size > MAX_IMAGE_BYTES)
			return { ok: false, error: '이미지 용량이 너무 큽니다 (최대 3MB).' };
		image = imageRaw;
	}

	return {
		ok: true,
		data: { name, tagline, intro, description, audience, contentRating, visibility, recommendedStyleId, tags: tagsClean, greetings, lorebook, scriptData, image }
	};
}

/** scriptData 폼 필드(JSON) → 기본 변수 맵. 손상/빈값이면 null. 키는 소문자, 길이·개수 clamp. */
function parseScriptDataField(raw: FormDataEntryValue | null): CharacterScriptData | null {
	if (typeof raw !== 'string' || raw.trim() === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const dv = (parsed as { defaultVariables?: unknown } | null)?.defaultVariables;
	if (!dv || typeof dv !== 'object' || Array.isArray(dv)) return null;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(dv as Record<string, unknown>)) {
		const key = k.trim().toLowerCase().slice(0, SCRIPT_VAR_KEY_MAX);
		if (!key) continue;
		const val =
			typeof v === 'string'
				? v
				: typeof v === 'number' || typeof v === 'boolean'
					? String(v)
					: '';
		out[key] = val.slice(0, SCRIPT_VAR_VALUE_MAX);
		if (Object.keys(out).length >= SCRIPT_VARS_MAX) break;
	}
	return Object.keys(out).length > 0 ? { defaultVariables: out } : null;
}

// ─────────────────────────────────────────────────────────────
// 장면 이미지 세트 파싱
// ─────────────────────────────────────────────────────────────

/** 파싱된 조합(행) 하나. file 이 있으면 신규 업로드, 없으면 ext 로 기존 이미지 유지. */
export interface ParsedImageEntry {
	id: string;
	combo: number[];
	/** 새 업로드 파일(타입·용량 검증 완료). 없으면 null. */
	file: File | null;
	/** 기존 이미지 확장자(file 이 null 일 때). 없으면 null. */
	ext: string | null;
}

export interface ParsedImageSet {
	axes: ImageAxis[];
	entries: ParsedImageEntry[];
}

type ImageSetResult =
	| { ok: true; data: ParsedImageSet | null }
	| { ok: false; error: string };

/**
 * 폼의 imageSet(JSON) + imageEntry:<id>(파일들)을 파싱·검증한다.
 * - imageSet 필드가 없거나 비면 data=null(장면 이미지 미사용).
 * - 신규/교체 이미지는 imageEntry:<entryId> 파일 필드로 들어온다.
 * - 기존 이미지를 유지하는 엔트리는 JSON 에 ext 를 담고 파일은 없다(수정 시).
 * 생성 시 "모든 엔트리에 파일 필수" 같은 모드별 규칙은 호출부에서 검사한다.
 */
export function parseImageSet(form: FormData): ImageSetResult {
	const raw = form.get('imageSet');
	if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, data: null };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: '이미지 세트 형식이 올바르지 않습니다.' };
	}
	const obj = (parsed ?? {}) as { axes?: unknown; entries?: unknown };
	const axesRaw = Array.isArray(obj.axes) ? obj.axes : [];
	const entriesRaw = Array.isArray(obj.entries) ? obj.entries : [];

	// 축이 없으면 장면 이미지 미사용으로 간주.
	if (axesRaw.length === 0) return { ok: true, data: null };
	if (axesRaw.length > IMAGE_LIMITS.MAX_AXES)
		return { ok: false, error: `축은 최대 ${IMAGE_LIMITS.MAX_AXES}개까지 가능합니다.` };

	// ── 축·값 검증 ──
	const axes: ImageAxis[] = [];
	for (const a of axesRaw) {
		const o = (a ?? {}) as { label?: unknown; values?: unknown };
		const label = (typeof o.label === 'string' ? o.label : '').trim();
		if (!label) return { ok: false, error: '축 이름을 입력해 주세요.' };
		if (label.length > IMAGE_LIMITS.AXIS_LABEL_MAX)
			return { ok: false, error: `축 이름은 ${IMAGE_LIMITS.AXIS_LABEL_MAX}자 이내로 입력해 주세요.` };
		const valuesRaw = Array.isArray(o.values) ? o.values : [];
		const values = valuesRaw
			.map((v) => (typeof v === 'string' ? v.trim() : ''))
			.filter(Boolean);
		if (values.length === 0)
			return { ok: false, error: `"${label}" 축에 값을 1개 이상 추가해 주세요.` };
		if (values.length > IMAGE_LIMITS.MAX_AXIS_VALUES)
			return {
				ok: false,
				error: `"${label}" 축의 값은 최대 ${IMAGE_LIMITS.MAX_AXIS_VALUES}개까지 가능합니다.`
			};
		if (values.some((v) => v.length > IMAGE_LIMITS.VALUE_LABEL_MAX))
			return {
				ok: false,
				error: `값 이름은 ${IMAGE_LIMITS.VALUE_LABEL_MAX}자 이내로 입력해 주세요.`
			};
		axes.push({ label, values });
	}

	// ── 조합(행) 검증 ──
	if (entriesRaw.length > IMAGE_LIMITS.MAX_ENTRIES)
		return { ok: false, error: `조합은 최대 ${IMAGE_LIMITS.MAX_ENTRIES}개까지 가능합니다.` };

	const entries: ParsedImageEntry[] = [];
	const seenCombo = new Set<string>();
	const seenId = new Set<string>();
	for (const e of entriesRaw) {
		const o = (e ?? {}) as { id?: unknown; combo?: unknown; ext?: unknown };
		const id = typeof o.id === 'string' ? o.id : '';
		if (!id || seenId.has(id))
			return { ok: false, error: '조합 식별자가 올바르지 않습니다.' };
		seenId.add(id);

		const comboRaw = Array.isArray(o.combo) ? o.combo : [];
		if (comboRaw.length !== axes.length)
			return { ok: false, error: '각 조합은 모든 축의 값을 선택해야 합니다.' };
		const combo: number[] = [];
		for (let ai = 0; ai < axes.length; ai++) {
			const vi = comboRaw[ai];
			if (typeof vi !== 'number' || vi < 0 || vi >= axes[ai].values.length)
				return { ok: false, error: '조합에 올바르지 않은 값이 있습니다.' };
			combo.push(vi);
		}
		const comboKey = combo.join(',');
		if (seenCombo.has(comboKey))
			return { ok: false, error: `중복된 조합이 있습니다: {${comboToCode(combo)}}` };
		seenCombo.add(comboKey);

		// 파일(신규/교체) 또는 기존 ext(유지) 중 하나.
		const fileRaw = form.get(`imageEntry:${id}`);
		let file: File | null = null;
		let ext: string | null = null;
		if (fileRaw instanceof File && fileRaw.size > 0) {
			if (!ALLOWED_IMAGE[fileRaw.type])
				return { ok: false, error: '장면 이미지는 webp 또는 avif 만 가능합니다.' };
			if (fileRaw.size > MAX_IMAGE_BYTES)
				return { ok: false, error: '장면 이미지 용량이 너무 큽니다 (최대 3MB).' };
			file = fileRaw;
		} else {
			const keepExt = typeof o.ext === 'string' ? o.ext : '';
			if (keepExt === 'webp' || keepExt === 'avif') ext = keepExt;
		}

		entries.push({ id, combo, file, ext });
	}

	return { ok: true, data: { axes, entries } };
}

// ─────────────────────────────────────────────────────────────
// 플랫 네임드 이미지 세트 파싱 (네이티브 제작 — 플랫 방식)
// ─────────────────────────────────────────────────────────────

/** 파싱된 네임드 이미지 한 장. file 있으면 신규/교체, 없으면 ext 로 기존 유지. */
export interface ParsedNamedImage {
	id: string;
	name: string;
	file: File | null;
	ext: string | null;
}

export interface ParsedNamedSet {
	images: ParsedNamedImage[];
}

type NamedSetResult = { ok: true; data: ParsedNamedSet | null } | { ok: false; error: string };

/**
 * 폼의 namedImages(JSON: [{id,name,ext?}]) + namedImage:<id>(파일들)을 파싱·검증.
 * 비거나 이미지가 없으면 data=null(장면 이미지 미사용).
 * 매칭 토큰(name)은 모델이 `<img="name">` 으로 출력하는 값 — 고유·필수.
 */
export function parseNamedImageSet(form: FormData): NamedSetResult {
	const raw = form.get('namedImages');
	if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, data: null };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: '이미지 목록 형식이 올바르지 않습니다.' };
	}
	const arr = Array.isArray(parsed) ? parsed : [];
	if (arr.length === 0) return { ok: true, data: null };
	if (arr.length > NAMED_LIMITS.MAX_IMAGES)
		return { ok: false, error: `이미지는 최대 ${NAMED_LIMITS.MAX_IMAGES}장까지 가능합니다.` };

	const images: ParsedNamedImage[] = [];
	const seenId = new Set<string>();
	const seenName = new Set<string>();
	for (const item of arr) {
		const o = (item ?? {}) as { id?: unknown; name?: unknown; ext?: unknown };
		const id = typeof o.id === 'string' ? o.id : '';
		const name = (typeof o.name === 'string' ? o.name : '').trim();
		if (!id || seenId.has(id)) return { ok: false, error: '이미지 식별자가 올바르지 않습니다.' };
		if (!name) return { ok: false, error: '각 이미지에 이름(토큰)을 입력해 주세요.' };
		if (name.length > NAMED_LIMITS.NAME_MAX)
			return { ok: false, error: `이미지 이름은 ${NAMED_LIMITS.NAME_MAX}자 이내로 입력해 주세요.` };
		if (seenName.has(name)) return { ok: false, error: `이미지 이름이 중복됩니다: ${name}` };
		seenId.add(id);
		seenName.add(name);

		const fileRaw = form.get(`namedImage:${id}`);
		let file: File | null = null;
		let ext: string | null = null;
		if (fileRaw instanceof File && fileRaw.size > 0) {
			if (!ALLOWED_IMAGE[fileRaw.type])
				return { ok: false, error: '장면 이미지는 webp 또는 avif 만 가능합니다.' };
			if (fileRaw.size > MAX_IMAGE_BYTES)
				return { ok: false, error: '장면 이미지 용량이 너무 큽니다 (최대 3MB).' };
			file = fileRaw;
		} else {
			const keepExt = typeof o.ext === 'string' ? o.ext : '';
			if (keepExt === 'webp' || keepExt === 'avif') ext = keepExt;
		}

		images.push({ id, name, file, ext });
	}

	return { ok: true, data: { images } };
}
