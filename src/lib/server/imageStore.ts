import type { CharacterImageSet, ImageEntry, NamedImage } from '$lib/types';
import { entryKey, isGrid, isNamed, namedKey } from '$lib/imageCodes';
import {
	ALLOWED_IMAGE,
	parseImageSet,
	parseNamedImageSet,
	type ParsedImageSet,
	type ParsedNamedSet
} from './characterForm';

/** 세트(grid|named)의 모든 R2 키. kind 전환 시 옛 키 전부 정리하는 용도. */
function allKeysOf(set: CharacterImageSet | null, characterId: string): string[] {
	if (isGrid(set)) return set.entries.map((e) => entryKey(characterId, e));
	if (isNamed(set)) return set.images.map((i) => namedKey(characterId, i));
	return [];
}

/**
 * 장면 이미지 세트를 R2 에 반영하고 최종 CharacterImageSet 을 만든다.
 *
 * 동작
 *  - file 이 있는 엔트리 → R2 에 업로드(charimg/<cid>/<id>.<ext>).
 *  - file 이 없는 엔트리 → 기존 이미지 유지(ext 는 parsed.ext, 없으면 oldSet 에서 조회).
 *  - 업로드한 키는 uploadedKeys 로 반환 → DB 실패 시 호출부가 롤백 삭제.
 *  - 더 이상 참조되지 않는 옛 키(삭제된 엔트리·확장자 변경 전 키)는 staleKeys 로 반환
 *    → 호출부가 DB 성공 후 삭제(고아 정리).
 *
 * 반환 imageSet 이 null 이면 장면 이미지 미사용(기존이 있었다면 전부 stale).
 */
export interface CommitResult {
	imageSet: CharacterImageSet | null;
	uploadedKeys: string[];
	staleKeys: string[];
}

type Commit =
	| { ok: true; result: CommitResult }
	| { ok: false; error: string };

export async function commitImageSet(
	bucket: R2Bucket,
	characterId: string,
	parsed: ParsedImageSet | null,
	oldSet: CharacterImageSet | null
): Promise<Commit> {
	// 그리드 커밋 경로 — 직전 세트가 named 였다면 그 키는 전부 정리 대상(kind 전환).
	const oldEntries = isGrid(oldSet) ? oldSet.entries : [];
	const oldById = new Map<string, ImageEntry>(oldEntries.map((e) => [e.id, e]));
	const switchedKindKeys = isNamed(oldSet) ? allKeysOf(oldSet, characterId) : [];

	// 장면 이미지 미사용 → 기존 엔트리 전부 정리 대상.
	if (!parsed || parsed.entries.length === 0) {
		const staleKeys = [...oldEntries.map((e) => entryKey(characterId, e)), ...switchedKindKeys];
		return { ok: true, result: { imageSet: null, uploadedKeys: [], staleKeys } };
	}

	const uploadedKeys: string[] = [];
	const staleKeys: string[] = [...switchedKindKeys];
	const finalEntries: ImageEntry[] = [];
	const keptIds = new Set<string>();

	for (const entry of parsed.entries) {
		keptIds.add(entry.id);
		const old = oldById.get(entry.id);

		let ext: string;
		if (entry.file) {
			ext = ALLOWED_IMAGE[entry.file.type]; // parseImageSet 에서 타입 검증됨
		} else {
			const keep = entry.ext ?? old?.ext ?? null;
			if (!keep) {
				return { ok: false, error: '모든 조합에 이미지를 추가해 주세요.' };
			}
			ext = keep;
		}

		const finalEntry: ImageEntry = { id: entry.id, combo: entry.combo, ext };

		if (entry.file) {
			const key = entryKey(characterId, finalEntry);
			await bucket.put(key, await entry.file.arrayBuffer(), {
				httpMetadata: { contentType: entry.file.type }
			});
			uploadedKeys.push(key);
			// 같은 엔트리인데 확장자가 바뀌면 옛 키는 정리 대상.
			if (old && old.ext !== ext) staleKeys.push(entryKey(characterId, old));
		}

		finalEntries.push(finalEntry);
	}

	// 새 세트에서 빠진 옛 엔트리 → 정리 대상.
	for (const old of oldEntries) {
		if (!keptIds.has(old.id)) staleKeys.push(entryKey(characterId, old));
	}

	return {
		ok: true,
		result: {
			imageSet: { kind: 'grid', axes: parsed.axes, entries: finalEntries },
			uploadedKeys,
			staleKeys
		}
	};
}

/**
 * 플랫 네임드 세트를 R2 에 반영(네이티브 제작 — 단일 요청). commitImageSet 의 named 판.
 * 대량 import 는 별도 배치 경로(/api/import/charx)를 쓴다.
 */
export async function commitNamedSet(
	bucket: R2Bucket,
	characterId: string,
	parsed: ParsedNamedSet | null,
	oldSet: CharacterImageSet | null
): Promise<Commit> {
	const oldImages = isNamed(oldSet) ? oldSet.images : [];
	const oldById = new Map<string, NamedImage>(oldImages.map((i) => [i.id, i]));
	// 직전이 grid 였다면 그 키는 전부 정리 대상(kind 전환).
	const switchedKindKeys = isGrid(oldSet) ? allKeysOf(oldSet, characterId) : [];

	if (!parsed || parsed.images.length === 0) {
		const staleKeys = [...oldImages.map((i) => namedKey(characterId, i)), ...switchedKindKeys];
		return { ok: true, result: { imageSet: null, uploadedKeys: [], staleKeys } };
	}

	const uploadedKeys: string[] = [];
	const staleKeys: string[] = [...switchedKindKeys];
	const finalImages: NamedImage[] = [];
	const keptIds = new Set<string>();

	for (const img of parsed.images) {
		keptIds.add(img.id);
		const old = oldById.get(img.id);

		let ext: string;
		if (img.file) {
			ext = ALLOWED_IMAGE[img.file.type];
		} else {
			const keep = img.ext ?? old?.ext ?? null;
			if (!keep) return { ok: false, error: '모든 이미지에 파일을 추가해 주세요.' };
			ext = keep;
		}

		const finalImage: NamedImage = { id: img.id, name: img.name, ext };

		if (img.file) {
			const key = namedKey(characterId, finalImage);
			await bucket.put(key, await img.file.arrayBuffer(), {
				httpMetadata: { contentType: img.file.type }
			});
			uploadedKeys.push(key);
			if (old && old.ext !== ext) staleKeys.push(namedKey(characterId, old));
		}

		finalImages.push(finalImage);
	}

	// 빠진 옛 이미지 → 정리.
	for (const old of oldImages) {
		if (!keptIds.has(old.id)) staleKeys.push(namedKey(characterId, old));
	}

	return {
		ok: true,
		result: { imageSet: { kind: 'named', images: finalImages }, uploadedKeys, staleKeys }
	};
}

/**
 * 폼의 이미지 방식(imageMode=grid|named)에 따라 파싱·검증·R2 반영을 디스패치.
 * 캐릭터 생성/수정 라우트 공용.
 */
export async function commitSceneImages(
	form: FormData,
	bucket: R2Bucket,
	characterId: string,
	oldSet: CharacterImageSet | null
): Promise<Commit> {
	const mode = String(form.get('imageMode') ?? 'grid');
	if (mode === 'named') {
		const parsed = parseNamedImageSet(form);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		return commitNamedSet(bucket, characterId, parsed.data, oldSet);
	}
	const parsed = parseImageSet(form);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	return commitImageSet(bucket, characterId, parsed.data, oldSet);
}

/** 키 목록을 best-effort 삭제(실패 무시). 롤백·고아 정리용. */
export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
	await Promise.all(keys.map((k) => bucket.delete(k).catch(() => {})));
}

/** 캐릭터의 모든 장면 이미지 삭제(캐릭터 삭제 시). */
export async function deleteAllSceneImages(bucket: R2Bucket, characterId: string): Promise<void> {
	try {
		const listed = await bucket.list({ prefix: `charimg/${characterId}/` });
		await deleteKeys(bucket, listed.objects.map((o) => o.key));
	} catch {
		// 무시 — 고아가 남아도 치명적이지 않음.
	}
}
