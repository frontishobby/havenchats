/**
 * 백업 zip 내보내기/가져오기 — Drive 와 무관하게 전체 데이터를 파일 하나로.
 * 구조: `haven.sqlite`(DB 스냅샷) + `images/<R2 키>`(이미지 원본).
 * `scripts/export-legacy.mjs` 가 만드는 구 D1/R2 이전용 zip 과 같은 형식이다.
 *
 * 데이터가 GB 단위(장면 이미지 수천 장)일 수 있어 **스트리밍**으로 처리한다:
 *  - 가져오기: fflate `Unzip` 에 파일 청크를 흘려 넣고 엔트리마다 IndexedDB 에 바로 저장.
 *  - 내보내기: fflate `Zip` 출력 청크를 File System Access 의 writable(가능하면)로 바로 쓰고,
 *    없으면(사파리 등) Blob 으로 모아 내려받는다.
 */
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipPassThrough } from 'fflate';
import { getLocalRuntime } from './runtime';
import { objClear, objGet, objKeys, objPut } from './idb';
import { reconcileAfterImport } from './sync.svelte';

const DB_NAME = 'haven.sqlite';

export interface BackupProgress {
	phase: string;
	done: number;
	total: number;
}

type Sink = { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };

declare global {
	interface Window {
		showSaveFilePicker?: (opts?: {
			suggestedName?: string;
			types?: { description?: string; accept: Record<string, string[]> }[];
		}) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
	}
}

/**
 * 전체 백업을 zip 으로 내보낸다. 파일 저장 위치는 브라우저가 지원하면 저장 대화상자(스트리밍),
 * 아니면 Blob 다운로드. 반환: 쓴 바이트 수.
 */
export async function exportBackup(onProgress?: (p: BackupProgress) => void): Promise<number> {
	const rt = getLocalRuntime();
	await rt.flush();
	const keys = await objKeys();
	const name = `haven-backup-${new Date().toISOString().slice(0, 10)}.zip`;

	let sink: Sink;
	let finalize: () => Promise<void> = async () => {};
	if (window.showSaveFilePicker) {
		const handle = await window.showSaveFilePicker({
			suggestedName: name,
			types: [{ description: 'zip', accept: { 'application/zip': ['.zip'] } }]
		});
		const w = (await handle.createWritable()).getWriter();
		sink = { write: (c) => w.write(c), close: () => w.close() };
	} else {
		const parts: Uint8Array[] = [];
		sink = {
			write: async (c) => {
				parts.push(c);
			},
			close: async () => {}
		};
		finalize = async () => {
			const blob = new Blob(parts as BlobPart[], { type: 'application/zip' });
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = name;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
		};
	}

	let written = 0;
	let pendingWrite: Promise<void> = Promise.resolve();
	let zipError: Error | null = null;
	const zip = new Zip((err, chunk, final) => {
		if (err) {
			zipError = err;
			return;
		}
		written += chunk.length;
		pendingWrite = pendingWrite.then(() => sink.write(chunk));
		if (final) pendingWrite = pendingWrite.then(() => sink.close());
	});

	const addFile = async (path: string, data: Uint8Array) => {
		const f = new ZipPassThrough(path);
		zip.add(f);
		f.push(data, true);
		await pendingWrite; // 백프레셔: 청크가 디스크에 써진 뒤 다음 파일
		if (zipError) throw zipError;
	};

	onProgress?.({ phase: 'DB', done: 0, total: keys.length + 1 });
	await addFile(DB_NAME, rt.exportDatabase());
	let n = 0;
	for (const key of keys) {
		const o = await objGet(key);
		if (o) await addFile(`images/${key}`, new Uint8Array(await o.blob.arrayBuffer()));
		n++;
		if (n % 10 === 0) onProgress?.({ phase: '이미지', done: n, total: keys.length });
	}
	zip.end();
	await pendingWrite;
	if (zipError) throw zipError;
	await finalize();
	return written;
}

export interface ImportResult {
	images: number;
}

/** zip 을 스트리밍으로 풀어 **기존 이미지를 전부 지우고** zip 의 이미지를 넣은 뒤 DB 를 교체한다. Drive 모드면 원격도 zip 기준으로 정리. */
export async function importBackup(
	file: Blob,
	onProgress?: (p: BackupProgress) => void
): Promise<ImportResult> {
	let dbBytes: Uint8Array | null = null;
	let images = 0;
	let chain: Promise<void> = Promise.resolve();
	let failure: Error | null = null;
	onProgress?.({ phase: '기존 이미지 정리', done: 0, total: 0 });
	await objClear();

	const unzip = new Unzip((entry) => {
		const name = entry.name;
		const isDb = name === DB_NAME;
		const isImage = name.startsWith('images/') && !name.endsWith('/');
		if (!isDb && !isImage) return; // 관심 없는 엔트리는 ondata 를 안 달면 건너뜀
		const parts: Uint8Array[] = [];
		entry.ondata = (err, chunk, final) => {
			if (err) {
				failure ??= err;
				return;
			}
			parts.push(chunk);
			if (!final) return;
			const data = concat(parts);
			if (isDb) {
				dbBytes = data;
				return;
			}
			const key = name.slice('images/'.length);
			const contentType = guessType(key);
			chain = chain.then(() =>
				objPut({
					key,
					blob: new Blob([data as BlobPart], { type: contentType }),
					contentType,
					size: data.byteLength,
					uploaded: Date.now(),
					etag: crypto.randomUUID().replace(/-/g, '')
				}).then(() => {
					images++;
					if (images % 20 === 0) onProgress?.({ phase: '이미지', done: images, total: 0 });
				})
			);
		};
		entry.start();
	});
	unzip.register(UnzipPassThrough);
	unzip.register(UnzipInflate);

	const reader = file.stream().getReader();
	let read = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		unzip.push(value, false);
		read += value.byteLength;
		onProgress?.({ phase: '읽는 중', done: read, total: file.size });
		// 저장 대기열이 쌓이지 않게 IndexedDB 쓰기를 따라잡는다.
		await chain;
		if (failure) throw failure;
	}
	unzip.push(new Uint8Array(0), true);
	await chain;
	if (failure) throw failure;
	if (!dbBytes) throw new Error('zip 안에 haven.sqlite 가 없어요.');

	onProgress?.({ phase: 'DB 교체', done: 0, total: 0 });
	await getLocalRuntime().replaceDatabase(dbBytes);
	await reconcileAfterImport();
	return { images };
}

function concat(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0];
	const total = parts.reduce((a, p) => a + p.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out;
}

function guessType(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase();
	if (ext === 'png') return 'image/png';
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'avif') return 'image/avif';
	if (ext === 'webp') return 'image/webp';
	return 'application/octet-stream';
}
