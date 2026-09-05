/**
 * 클라 전용 — 스트리밍 이미지 프리뷰 헬퍼.
 * 서버가 NDJSON 으로 흘려보내는 base64 프레임을 Blob/object URL 로 바꿔 <img> 에 띄운다.
 */

import type { WebpEncodeRequest, WebpEncodeResponse } from './webpEncode.worker';

/** base64(또는 data URL) → Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
	const clean = (b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64).replace(/\s/g, '');
	const bin = atob(clean);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** 매직바이트로 이미지 MIME 판별(webp/png/jpeg). 모르면 png. */
export function sniffImageMime(b: Uint8Array): string {
	if (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	)
		return 'image/webp';
	if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
	return 'image/png';
}

/** base64 → Blob(올바른 MIME). 워크숍 공유 업로드·프리뷰 공용. */
export function base64ToBlob(b64: string): Blob {
	const bytes = base64ToBytes(b64);
	return new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) });
}

/** Blob → base64 문자열(data URL 접두 없이). 업로드/업스케일 전송용. */
export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

/**
 * 이미지 Blob → webp Blob(클라 전용). 항상 image/webp 를 돌려주거나 throw 한다.
 * NovelAI 생성 결과(보통 PNG)를 업로드용 webp 로 바꾼다. 해상도는 보존(832×1216 등).
 *
 * 1) canvas.toBlob('image/webp') — Blink/Gecko(데스크톱·안드로이드 크롬 등)는 네이티브 인코딩.
 * 2) WebKit(사파리·iOS 의 모든 브라우저 — iOS 크롬 포함)은 webp 인코딩 미지원이라 PNG 를 돌려준다
 *    → libwebp WASM 워커(`webpEncode.worker.ts`)로 인코딩. WASM 은 이 경로에서만 로드된다.
 */
export async function blobToWebp(blob: Blob, quality = 0.9): Promise<Blob> {
	if (blob.type === 'image/webp') return blob;
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('canvas 컨텍스트를 만들 수 없습니다.');
		ctx.drawImage(bitmap, 0, 0);
		const native = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/webp', quality)
		);
		if (native && native.type === 'image/webp' && native.size > 0) return native;

		// WebKit 폴백 — 픽셀을 워커로 넘겨 libwebp WASM 인코딩.
		const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const buf = await encodeWebpInWorker(img, Math.round(quality * 100));
		if (buf.byteLength === 0) throw new Error('webp 변환에 실패했습니다.');
		return new Blob([buf], { type: 'image/webp' });
	} finally {
		bitmap.close?.();
	}
}

// ── WASM webp 워커(지연 생성 싱글턴) ────────────────────────────────────────
let webpWorker: Worker | null = null;
let webpReqSeq = 0;
const webpPending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();

function getWebpWorker(): Worker {
	if (webpWorker) return webpWorker;
	const w = new Worker(new URL('./webpEncode.worker.ts', import.meta.url), { type: 'module' });
	w.onmessage = (e: MessageEvent<WebpEncodeResponse>) => {
		const p = webpPending.get(e.data.id);
		if (!p) return;
		webpPending.delete(e.data.id);
		if ('error' in e.data) p.reject(new Error(e.data.error));
		else p.resolve(e.data.buf);
	};
	w.onerror = (ev) => {
		// 워커 자체가 죽으면 대기 중인 요청을 전부 실패 처리하고 다음 호출에서 새로 만든다.
		const err = new Error(ev.message || 'webp 워커 오류');
		for (const p of webpPending.values()) p.reject(err);
		webpPending.clear();
		w.terminate();
		if (webpWorker === w) webpWorker = null;
	};
	webpWorker = w;
	return w;
}

function encodeWebpInWorker(img: ImageData, quality: number): Promise<ArrayBuffer> {
	const id = ++webpReqSeq;
	const worker = getWebpWorker();
	return new Promise<ArrayBuffer>((resolve, reject) => {
		webpPending.set(id, { resolve, reject });
		const req: WebpEncodeRequest = {
			id,
			data: img.data,
			width: img.width,
			height: img.height,
			quality
		};
		worker.postMessage(req, [img.data.buffer as ArrayBuffer]);
	});
}
