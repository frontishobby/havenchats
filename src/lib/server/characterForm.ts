import type { Audience, ContentRating, Opening } from '$lib/types';

/** 허용 이미지 타입 → 확장자. (webp/avif 만) */
export const ALLOWED_IMAGE: Record<string, string> = {
	'image/webp': 'webp',
	'image/avif': 'avif'
};
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB

const NAME_MAX = 15;
const TAGLINE_MAX = 100;
const INTRO_MAX = 3000;
const DESC_MAX = 6000;
const TAGS_MAX = 5;
const GREETING_MAX = 2000;
const GREETING_NAME_MAX = 30;
const GREETINGS_MAX = 5;

export interface ParsedCharacterForm {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	audience: Audience;
	contentRating: ContentRating;
	tags: string[];
	greetings: Opening[];
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

	// ── 검증 ──
	if (!name) return { ok: false, error: '제목을 입력해 주세요.' };
	if (name.length > NAME_MAX) return { ok: false, error: `제목은 ${NAME_MAX}자 이내로 입력해 주세요.` };
	if (!tagline) return { ok: false, error: '소개를 입력해 주세요.' };
	if (tagline.length > TAGLINE_MAX)
		return { ok: false, error: `소개는 ${TAGLINE_MAX}자 이내로 입력해 주세요.` };
	if (intro.length > INTRO_MAX) return { ok: false, error: `설명은 ${INTRO_MAX}자 이내로 입력해 주세요.` };
	if (!description) return { ok: false, error: '프롬프트를 입력해 주세요.' };
	if (description.length > DESC_MAX)
		return { ok: false, error: `프롬프트는 ${DESC_MAX}자 이내로 입력해 주세요.` };

	const audience: Audience =
		audienceRaw === 'male' || audienceRaw === 'female' ? audienceRaw : 'all';
	const contentRating: ContentRating = nsfw ? 'nsfw' : 'sfw';

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
		data: { name, tagline, intro, description, audience, contentRating, tags: tagsClean, greetings, image }
	};
}
