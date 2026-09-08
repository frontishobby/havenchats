/**
 * 백업 zip 내보내기/가져오기 — Drive 와 무관하게 전체 데이터를 파일 하나로.
 * 구조: `haven.sqlite`(DB 스냅샷) + `images/<R2 키>`(이미지 원본).
 * `scripts/export-legacy.mjs` 가 만드는 구 D1/R2 이전용 zip 과 같은 형식이다.
 */
import { zipSync, unzipSync } from 'fflate';
import { getLocalRuntime } from './runtime';
import { objGet, objKeys, objPut } from './idb';

const DB_NAME = 'haven.sqlite';

export async function exportBackup(): Promise<Blob> {
	const rt = getLocalRuntime();
	await rt.flush();
	const files: Record<string, Uint8Array> = { [DB_NAME]: rt.exportDatabase() };
	for (const key of await objKeys()) {
		const o = await objGet(key);
		if (o) files[`images/${key}`] = new Uint8Array(await o.blob.arrayBuffer());
	}
	// 이미지는 이미 압축 포맷 → 무압축(level 0)으로 빠르게.
	const zipped = zipSync(files, { level: 0 });
	return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

export interface ImportResult {
	images: number;
}

/** zip 을 풀어 DB 를 교체하고 이미지를 IndexedDB 에 넣는다(기존 이미지는 유지·같은 키는 덮어씀). */
export async function importBackup(file: Blob): Promise<ImportResult> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const entries = unzipSync(bytes);
	const db = entries[DB_NAME];
	if (!db) throw new Error('zip 안에 haven.sqlite 가 없어요.');

	let images = 0;
	for (const [name, data] of Object.entries(entries)) {
		if (!name.startsWith('images/') || name.endsWith('/')) continue;
		const key = name.slice('images/'.length);
		const contentType = guessType(key);
		await objPut({
			key,
			blob: new Blob([data as BlobPart], { type: contentType }),
			contentType,
			size: data.byteLength,
			uploaded: Date.now(),
			etag: crypto.randomUUID().replace(/-/g, '')
		});
		images++;
	}
	await getLocalRuntime().replaceDatabase(db);
	return { images };
}

function guessType(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase();
	if (ext === 'png') return 'image/png';
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'avif') return 'image/avif';
	if (ext === 'webp') return 'image/webp';
	return 'application/octet-stream';
}
