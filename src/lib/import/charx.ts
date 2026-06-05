/**
 * charx(브라우저) 파싱·업로드 오케스트레이션 — 클라이언트 전용.
 *
 * 아키텍처: 압축 해제를 **브라우저에서** 한다(Workers 의 128MB 메모리·1000 서브리퀘스트·
 * 100MB 본문 한계 회피). 클라가 zip 을 풀어 card.json 매핑 + 에셋 바이트를 손에 들고,
 * 서버엔 ① 메타+썸네일+manifest 로 생성 → ② 에셋을 배치로 업로드 → ③ finalize 한다.
 */

import { unzip, strFromU8, type Unzipped } from 'fflate';
import {
	mapCardToCharacter,
	isV3Card,
	moduleLorebookToEntries,
	mergeLorebook,
	type MappedCard
} from './cardToCharacter';
import { readModuleMeta } from './risum';
import { scanUnsupported } from './capabilities';
import { putLocalScene, requestPersist } from './localImages';

export interface ParsedCharx {
	card: MappedCard;
	files: Unzipped; // zip 내부경로 → 바이트
}

/** zip 내부경로를 files 키와 매칭(정확 일치 우선, 아니면 끝부분 일치). */
function getFile(files: Unzipped, path: string): Uint8Array | null {
	if (files[path]) return files[path];
	const norm = path.replace(/^\.?\//, '');
	if (files[norm]) return files[norm];
	const hit = Object.keys(files).find((k) => k === norm || k.endsWith('/' + norm));
	return hit ? files[hit] : null;
}

/** charx(File) → 매핑된 카드 + 풀린 파일들. */
export async function parseCharx(file: File): Promise<ParsedCharx> {
	const buf = new Uint8Array(await file.arrayBuffer());
	const files = await new Promise<Unzipped>((resolve, reject) => {
		unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
	});

	const cardKey = Object.keys(files).find((k) => k === 'card.json' || k.endsWith('/card.json'));
	if (!cardKey) throw new Error('card.json 을 찾을 수 없어요. 올바른 charx 파일인가요?');

	let cardJson: unknown;
	try {
		cardJson = JSON.parse(strFromU8(files[cardKey]));
	} catch {
		throw new Error('card.json 을 읽지 못했어요(JSON 손상).');
	}
	if (!isV3Card(cardJson)) throw new Error('지원하지 않는 카드 형식이에요 (Character Card V3 아님).');

	const card = mapCardToCharacter(cardJson);

	// module.risum(있으면) + extensions 스캔 → 재현 안 되는 동적 기능(트리거/정규식/CJS/모듈로어북)
	// 을 경고로 노출한다. charx 는 트리거/정규식을 risum 으로 옮기므로 디코드가 필수.
	const moduleKey = Object.keys(files).find(
		(k) => k === 'module.risum' || k.endsWith('/module.risum')
	);
	const moduleMeta = moduleKey ? readModuleMeta(files[moduleKey]) : null;
	card.warnings.push(...scanUnsupported(cardJson, moduleMeta));

	// 로어북: card.json(character_book) + module.risum(loreBook) 을 머지·디둡해 확정.
	card.lorebook = mergeLorebook(card.lorebook, moduleLorebookToEntries(moduleMeta?.lorebook));

	return { card, files };
}

const MIME: Record<string, string> = {
	webp: 'image/webp',
	avif: 'image/avif',
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif'
};

function fileFrom(bytes: Uint8Array, name: string, ext: string): File {
	// Uint8Array(ArrayBufferView)는 BlobPart 로 그대로 사용 — byteOffset/length 범위 유지.
	return new File([bytes as BlobPart], name, { type: MIME[ext] ?? 'application/octet-stream' });
}

export interface ImportProgress {
	phase: 'creating' | 'storing' | 'finalizing' | 'done';
	uploaded: number;
	total: number;
}

export interface ImportResult {
	id: string;
	uploadedImages: number;
	totalImages: number;
	failed: number;
	warnings: string[];
}

/**
 * 파싱 결과를 import 한다(생성 → 장면 이미지 로컬 저장 → finalize). onProgress 로 진행률 보고.
 * contentRating/audience 는 UI 선택값을 override 로 받는다.
 *
 * 장면 이미지는 **R2 에 올리지 않고 브라우저 IndexedDB 에 저장**한다(charx 는 비공개·기기 한정).
 * 서버엔 메타(id·name·ext)만 storage:'local' 로 기록. → import 가 빠르고 R2 중복이 없다.
 * 이후 '기기간 공유'(promote)를 누르면 그때 R2 로 올려 일반 캐릭터처럼 전환한다(lib/import/promote.ts).
 */
export async function runImport(
	parsed: ParsedCharx,
	opts: { contentRating: 'sfw' | 'nsfw'; audience: 'all' | 'male' | 'female' },
	onProgress?: (p: ImportProgress) => void
): Promise<ImportResult> {
	const { card, files } = parsed;

	// 썸네일 바이트.
	if (!card.iconPath || !card.iconExt) throw new Error('카드에 썸네일(icon) 이 없어요.');
	const iconBytes = getFile(files, card.iconPath);
	if (!iconBytes) throw new Error('썸네일 파일을 zip 에서 찾지 못했어요.');

	// 실제 zip 에 존재하는 이미지만 manifest 로.
	const present = card.images.filter((img) => getFile(files, img.srcPath));
	const total = present.length;

	onProgress?.({ phase: 'creating', uploaded: 0, total });

	// ① 생성.
	const createForm = new FormData();
	createForm.set(
		'meta',
		JSON.stringify({
			name: card.name,
			tagline: card.tagline,
			intro: card.intro,
			description: card.description,
			greetings: card.greetings,
			tags: card.tags,
			lorebook: card.lorebook,
			contentRating: opts.contentRating,
			audience: opts.audience
		})
	);
	createForm.set('manifest', JSON.stringify(present.map((i) => ({ name: i.name, ext: i.ext }))));
	createForm.set('thumbnail', fileFrom(iconBytes, `icon.${card.iconExt}`, card.iconExt));

	const createRes = await fetch('/api/import/charx', { method: 'POST', body: createForm });
	const created = (await createRes.json().catch(() => ({}))) as {
		id?: string;
		images?: { id: string; name: string; ext: string }[];
		error?: string;
	};
	if (!createRes.ok || !created.id) throw new Error(created.error || '캐릭터 생성에 실패했어요.');
	const cid = created.id;
	const assigned = created.images ?? [];

	// name → srcPath 매핑(바이트 조회용).
	const pathByName = new Map(present.map((i) => [i.name, i.srcPath]));

	// ② 장면 이미지를 로컬(IndexedDB)에 저장 — 네트워크 없음. 키 = `<cid>/<id>`.
	await requestPersist(); // 용량 압박 시 비워지지 않도록(best-effort).
	const storedOk: { id: string; name: string; ext: string }[] = [];
	let failed = 0;
	let done = 0;

	for (const img of assigned) {
		const srcPath = pathByName.get(img.name);
		const bytes = srcPath ? getFile(files, srcPath) : null;
		if (bytes) {
			try {
				const blob = new Blob([bytes as BlobPart], {
					type: MIME[img.ext] ?? 'application/octet-stream'
				});
				await putLocalScene(cid, img.id, blob);
				storedOk.push(img);
			} catch {
				failed++;
			}
		} else {
			failed++;
		}
		done++;
		onProgress?.({ phase: 'storing', uploaded: done, total });
	}

	// ③ finalize — storage:'local' 로 image_set 확정(메타만 서버에 기록).
	onProgress?.({ phase: 'finalizing', uploaded: done, total });
	await fetch(`/api/import/charx/${cid}/finalize`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ images: storedOk, storage: 'local' })
	});

	onProgress?.({ phase: 'done', uploaded: storedOk.length, total });
	return {
		id: cid,
		uploadedImages: storedOk.length,
		totalImages: total,
		failed,
		warnings: card.warnings
	};
}
