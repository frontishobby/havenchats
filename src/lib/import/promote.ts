/**
 * '기기간 공유'(promote) — 로컬(IndexedDB) charx 캐릭터를 R2 로 올려 일반 캐릭터로 전환. 클라 전용.
 *
 * 흐름: ① IndexedDB 에서 장면 이미지 blob 을 모두 읽음 → ② /api/import/charx/<id>/assets 로
 *  배치 업로드(서버가 charimg/<id>/<imgId>.<ext> 로 적재) → ③ /api/characters/<id>/promote 로
 *  storage 플래그 제거(클라우드 전환) → ④ 로컬 사본 정리.
 * 가져온 그 기기에서만 가능(다른 기기엔 blob 이 없어 일부 누락 → 에러).
 */

import type { CharacterImageSet } from '$lib/types';
import { isNamed } from '$lib/imageCodes';
import { getLocalSceneBlob, localSceneKey, deleteLocalScenes } from './localImages';

const MIME: Record<string, string> = {
	webp: 'image/webp',
	avif: 'image/avif',
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif'
};

export interface PromoteProgress {
	uploaded: number;
	total: number;
}

// 한 번에 보내는 이미지 수(서버가 배치 안에서 병렬 put).
const BATCH = 12;

/**
 * 로컬 캐릭터를 클라우드로 전환. 진행률은 onProgress 로 보고.
 * 실패 시 throw(메시지는 사용자 노출용).
 */
export async function promoteLocalCharacter(
	characterId: string,
	set: CharacterImageSet,
	onProgress?: (p: PromoteProgress) => void
): Promise<void> {
	if (!isNamed(set) || set.storage !== 'local') {
		throw new Error('클라우드로 올릴 수 있는 캐릭터가 아니에요.');
	}

	// ① 로컬 blob 수집(하나라도 없으면 이 기기에선 전환 불가).
	const items: { id: string; ext: string; blob: Blob }[] = [];
	for (const img of set.images) {
		const blob = await getLocalSceneBlob(localSceneKey(characterId, img.id));
		if (!blob) {
			throw new Error('이 기기에 일부 이미지가 없어 올릴 수 없어요. 가져온 기기에서 시도해 주세요.');
		}
		items.push({ id: img.id, ext: img.ext, blob });
	}

	// ② 배치 업로드.
	const total = items.length;
	let done = 0;
	onProgress?.({ uploaded: 0, total });
	for (let i = 0; i < items.length; i += BATCH) {
		const slice = items.slice(i, i + BATCH);
		const form = new FormData();
		for (const it of slice) {
			const file = new File([it.blob], `${it.id}.${it.ext}`, {
				type: it.blob.type || MIME[it.ext] || 'application/octet-stream'
			});
			form.set(`img:${it.id}.${it.ext}`, file);
		}
		const res = await fetch(`/api/import/charx/${characterId}/assets`, {
			method: 'POST',
			body: form
		});
		if (!res.ok) throw new Error('이미지 업로드에 실패했어요. 잠시 후 다시 시도해 주세요.');
		const out = (await res.json().catch(() => ({}))) as { failed?: string[] };
		if (out.failed && out.failed.length > 0) {
			throw new Error('일부 이미지를 올리지 못했어요. 다시 시도해 주세요.');
		}
		done += slice.length;
		onProgress?.({ uploaded: done, total });
	}

	// ③ 클라우드 전환(storage 플래그 제거 + R2 존재 검증).
	const res = await fetch(`/api/characters/${characterId}/promote`, { method: 'POST' });
	if (!res.ok) {
		const e = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(e.error || '전환에 실패했어요. 다시 시도해 주세요.');
	}

	// ④ 로컬 사본 정리(이제 R2 가 원본).
	await deleteLocalScenes(characterId);
}
