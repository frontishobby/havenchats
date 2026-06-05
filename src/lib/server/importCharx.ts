/**
 * charx import 서버 검증·유틸. 클라이언트가 언집·매핑한 결과(정제된 필드)를 받아
 * 검증하고 단계적 업로드(create → assets 배치 → finalize)를 뒷받침한다.
 *
 * 업로드 자체는 클라가 zip 을 풀어 배치로 보내므로(Workers 메모리/서브리퀘스트 한계 회피),
 * 서버는 메타 검증 + R2 put + D1 쓰기만 담당한다.
 */

import type { Audience, CharacterLorebook, ContentRating, NamedImage, Opening } from '$lib/types';
import { IMPORT_LIMITS, IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';
import { normalizeLoreEntries } from '$lib/lorebook';

/** import 이미지 한 장 최대 용량(네이티브 3MB 보다 넉넉 — 카드 원본 보존). */
export const IMPORT_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/** create 단계 메타(클라가 매핑해 보낸 정제 필드). */
export interface ImportMeta {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	greetings: Opening[];
	tags: string[];
	lorebook: CharacterLorebook | null;
	contentRating: ContentRating;
	audience: Audience;
}

/** manifest 한 항목(클라가 보낸 이미지 목록 — 아직 id 미할당). */
export interface ImportManifestItem {
	name: string;
	ext: string;
}

type MetaResult = { ok: true; data: ImportMeta } | { ok: false; error: string };

/** create 요청의 meta JSON 검증. */
export function parseImportMeta(raw: unknown): MetaResult {
	const o = (raw ?? {}) as Record<string, unknown>;
	const name = String(o.name ?? '').trim();
	const tagline = String(o.tagline ?? '').trim();
	const intro = String(o.intro ?? '').trim();
	const description = String(o.description ?? '').trim();

	if (!name) return { ok: false, error: '캐릭터 이름이 비어 있어요.' };
	if (name.length > IMPORT_LIMITS.NAME_MAX)
		return { ok: false, error: `이름이 너무 길어요 (최대 ${IMPORT_LIMITS.NAME_MAX}자).` };
	if (!description) return { ok: false, error: '프롬프트(description)가 비어 있어요.' };
	if (description.length > IMPORT_LIMITS.DESC_MAX)
		return { ok: false, error: '프롬프트가 너무 길어요.' };
	if (intro.length > IMPORT_LIMITS.INTRO_MAX) return { ok: false, error: '설명이 너무 길어요.' };

	const greetingsRaw = Array.isArray(o.greetings) ? o.greetings : [];
	const greetings: Opening[] = greetingsRaw
		.map((g) => {
			const x = (g ?? {}) as { name?: unknown; content?: unknown };
			return {
				name: String(x.name ?? '').trim().slice(0, 40),
				content: String(x.content ?? '').trim()
			};
		})
		.filter((g) => g.content)
		.slice(0, IMPORT_LIMITS.GREETINGS_MAX);
	if (greetings.length === 0) return { ok: false, error: '가져올 오프닝(첫 상황)이 없어요.' };

	const tags = (Array.isArray(o.tags) ? o.tags : [])
		.filter((t): t is string => typeof t === 'string')
		.map((t) => t.trim().replace(/^#/, ''))
		.filter(Boolean)
		.slice(0, IMPORT_LIMITS.TAGS_MAX);

	const contentRating: ContentRating = o.contentRating === 'sfw' ? 'sfw' : 'nsfw';
	const audience: Audience =
		o.audience === 'male' || o.audience === 'female' ? o.audience : 'all';

	const lorebook = normalizeLoreEntries(o.lorebook);

	return {
		ok: true,
		data: {
			name,
			tagline: tagline.slice(0, IMPORT_LIMITS.TAGLINE_MAX),
			intro,
			description,
			greetings,
			tags,
			lorebook,
			contentRating,
			audience
		}
	};
}

/** manifest 검증 + 각 이미지에 불변 id 할당. 중복 name 은 첫 항목만. */
export function assignImageIds(raw: unknown): NamedImage[] {
	const arr = Array.isArray(raw) ? raw : [];
	const out: NamedImage[] = [];
	const seenName = new Set<string>();
	const seenId = new Set<string>();
	for (const item of arr) {
		const x = (item ?? {}) as { name?: unknown; ext?: unknown };
		const name = String(x.name ?? '').trim();
		const ext = IMPORT_IMAGE_EXT[String(x.ext ?? '').toLowerCase()];
		if (!name || !ext || seenName.has(name)) continue;
		seenName.add(name);
		let id = crypto.randomUUID().slice(0, 8);
		while (seenId.has(id)) id = crypto.randomUUID().slice(0, 8);
		seenId.add(id);
		out.push({ id, name, ext });
	}
	return out;
}
