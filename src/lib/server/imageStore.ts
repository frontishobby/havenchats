import type { CharacterImageSet, ImageEntry } from '$lib/types';
import { entryKey } from '$lib/imageCodes';
import { ALLOWED_IMAGE, type ParsedImageSet } from './characterForm';

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
	const oldById = new Map<string, ImageEntry>((oldSet?.entries ?? []).map((e) => [e.id, e]));

	// 장면 이미지 미사용 → 기존 엔트리 전부 정리 대상.
	if (!parsed || parsed.entries.length === 0) {
		const staleKeys = (oldSet?.entries ?? []).map((e) => entryKey(characterId, e));
		return { ok: true, result: { imageSet: null, uploadedKeys: [], staleKeys } };
	}

	const uploadedKeys: string[] = [];
	const staleKeys: string[] = [];
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
	for (const old of oldSet?.entries ?? []) {
		if (!keptIds.has(old.id)) staleKeys.push(entryKey(characterId, old));
	}

	return {
		ok: true,
		result: { imageSet: { axes: parsed.axes, entries: finalEntries }, uploadedKeys, staleKeys }
	};
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
