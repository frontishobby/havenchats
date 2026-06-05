/**
 * 가져온(charx) 캐릭터에 **장면 이미지 에셋을 추가**한다 — 클라이언트 전용.
 *
 * 사용처: 유저 프로필의 '가져온 캐릭터' 행에서 `.zip`(이미지 묶음)을 골라 기존 named 세트에 덧붙인다.
 * charx 최초 import 와 동일한 원칙:
 *  - 로컬(storage:'local') 세트면 바이트를 **브라우저 IndexedDB** 에 저장(서버엔 메타만).
 *  - 클라우드(promote 된) 세트면 바이트를 **R2** 로 올린다(기존 일반 이미지처럼).
 * 어느 쪽이든 마지막에 finalize 로 image_set(kind:'named') 을 **병합본**으로 다시 확정한다.
 *
 * zip 파싱은 charx 와 같은 fflate + 폴리글랏 prefix 보정(stripZipPrefix)을 재사용한다.
 * 매칭 토큰(name) = 파일명에서 경로·트레일링 확장자를 떼어낸 것.
 */

import { unzip, type Unzipped } from 'fflate';
import { stripZipPrefix } from './charx';
import { IMPORT_IMAGE_EXT } from './cardToCharacter';
import { putLocalScene, requestPersist } from './localImages';
import { isLocalSet, NAMED_LIMITS } from '$lib/imageCodes';
import type { CharacterImageSet, NamedImage, NamedImageSet } from '$lib/types';

const MIME: Record<string, string> = {
	webp: 'image/webp',
	avif: 'image/avif',
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif'
};

/** R2 업로드 배치 크기(서브리퀘스트·본문 한계 고려). */
const UPLOAD_BATCH = 20;

export interface AddAssetsResult {
	/** 새로 추가된 이미지 수. */
	added: number;
	/** 건너뛴 항목 수(이미지 아님 · 이름 중복 · 저장 실패). */
	skipped: number;
	/** 추가 후 세트의 총 이미지 수. */
	total: number;
	/** 갱신된 세트(UI 상태 반영용). */
	newSet: NamedImageSet;
}

export interface AddAssetsProgress {
	uploaded: number;
	total: number;
}

function genId(): string {
	return typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** zip 내부 경로 → 매칭 토큰: 디렉토리·트레일링 확장자 제거. */
function tokenFromPath(path: string): { token: string; ext: string } | null {
	const base = path.split('/').pop() ?? path;
	const dot = base.lastIndexOf('.');
	if (dot <= 0) return null;
	const ext = IMPORT_IMAGE_EXT[base.slice(dot + 1).toLowerCase()];
	if (!ext) return null;
	const token = base.slice(0, dot).trim();
	if (!token) return null;
	return { token, ext };
}

/**
 * `.zip`(이미지 묶음) → 기존 named 세트에 병합. currentSet 이 null 이면 새 named 세트를 만든다.
 * grid 세트엔 추가할 수 없다(가져온 캐릭터는 항상 named).
 */
export async function addAssetsFromZip(
	characterId: string,
	currentSet: CharacterImageSet | null | undefined,
	file: File,
	onProgress?: (p: AddAssetsProgress) => void
): Promise<AddAssetsResult> {
	if (currentSet && currentSet.kind !== 'named') {
		throw new Error('이 캐릭터의 이미지 방식엔 zip 추가를 지원하지 않아요.');
	}

	const existing: NamedImage[] = currentSet?.images ? [...currentSet.images] : [];
	// 바이트 위치: 기존이 로컬이면 로컬, 클라우드면 클라우드. 비어있으면(가져온 캐릭터 기본) 로컬.
	const local = currentSet ? isLocalSet(currentSet) : true;

	if (existing.length >= NAMED_LIMITS.MAX_IMAGES) {
		throw new Error(`이미 최대 ${NAMED_LIMITS.MAX_IMAGES}장까지 등록돼 있어요.`);
	}

	// ── zip 풀기(폴리글랏 prefix 보정 포함) ──
	const buf = stripZipPrefix(new Uint8Array(await file.arrayBuffer()));
	const files = await new Promise<Unzipped>((resolve, reject) => {
		unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
	});

	const takenNames = new Set(existing.map((i) => i.name.toLowerCase()));
	const room = NAMED_LIMITS.MAX_IMAGES - existing.length;

	// 추가 후보 수집(이미지 확장자 · 새 이름만, zip 내부 중복도 제거).
	const candidates: { id: string; name: string; ext: string; bytes: Uint8Array }[] = [];
	let skipped = 0;
	for (const [path, bytes] of Object.entries(files)) {
		if (path.endsWith('/') || bytes.length === 0) continue; // 디렉토리·빈 엔트리
		const parsed = tokenFromPath(path);
		if (!parsed) {
			skipped++;
			continue;
		}
		const key = parsed.token.toLowerCase();
		if (takenNames.has(key)) {
			skipped++;
			continue;
		}
		if (candidates.length >= room) {
			skipped++;
			continue;
		}
		takenNames.add(key);
		candidates.push({ id: genId(), name: parsed.token, ext: parsed.ext, bytes });
	}

	if (candidates.length === 0) {
		throw new Error(
			skipped > 0 ? '추가할 새 이미지가 없어요(이미 있거나 이미지가 아니에요).' : 'zip 에서 이미지를 찾지 못했어요.'
		);
	}

	const total = candidates.length;
	onProgress?.({ uploaded: 0, total });

	const storedOk: NamedImage[] = [];

	if (local) {
		// ── 로컬: IndexedDB 에 저장(네트워크 없음) ──
		await requestPersist();
		let done = 0;
		for (const c of candidates) {
			try {
				const blob = new Blob([c.bytes as BlobPart], {
					type: MIME[c.ext] ?? 'application/octet-stream'
				});
				await putLocalScene(characterId, c.id, blob);
				storedOk.push({ id: c.id, name: c.name, ext: c.ext });
			} catch {
				skipped++;
			}
			onProgress?.({ uploaded: ++done, total });
		}
	} else {
		// ── 클라우드: R2 배치 업로드(img:<id>.<ext> 폼 필드) ──
		let done = 0;
		for (let i = 0; i < candidates.length; i += UPLOAD_BATCH) {
			const batch = candidates.slice(i, i + UPLOAD_BATCH);
			const form = new FormData();
			for (const c of batch) {
				const blob = new Blob([c.bytes as BlobPart], {
					type: MIME[c.ext] ?? 'application/octet-stream'
				});
				form.set(`img:${c.id}.${c.ext}`, new File([blob], `${c.id}.${c.ext}`, { type: blob.type }));
			}
			const res = await fetch(`/api/import/charx/${characterId}/assets`, {
				method: 'POST',
				body: form
			});
			const out = (await res.json().catch(() => ({}))) as { uploaded?: string[] };
			const okIds = new Set(out.uploaded ?? []);
			for (const c of batch) {
				if (okIds.has(c.id)) storedOk.push({ id: c.id, name: c.name, ext: c.ext });
				else skipped++;
				done++;
			}
			onProgress?.({ uploaded: done, total });
		}
	}

	if (storedOk.length === 0) throw new Error('이미지 저장에 실패했어요.');

	// ── finalize: 기존 + 신규 병합본으로 image_set 재확정 ──
	const merged = [...existing, ...storedOk];
	const newSet: NamedImageSet = {
		kind: 'named',
		images: merged,
		...(local ? { storage: 'local' as const } : {})
	};
	const res = await fetch(`/api/import/charx/${characterId}/finalize`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ images: merged, storage: local ? 'local' : undefined })
	});
	if (!res.ok) throw new Error('이미지 정보 저장에 실패했어요.');

	return { added: storedOk.length, skipped, total: merged.length, newSet };
}
