/**
 * 클라 전용 — 스트리밍 이미지 프리뷰 헬퍼.
 * 서버가 NDJSON 으로 흘려보내는 base64 프레임을 Blob/object URL 로 바꿔 <img> 에 띄운다.
 */

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
 * 이미지 Blob → webp Blob(canvas 변환, 클라 전용).
 * NovelAI 생성 결과(보통 PNG)를 썸네일 업로드용 webp 로 바꾼다(폼은 webp/avif 만 허용).
 * 해상도는 보존한다(832×1216 등). canvas 미지원/디코드 실패 시 throw.
 */
export async function blobToWebp(blob: Blob, quality = 0.9): Promise<Blob> {
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('canvas 컨텍스트를 만들 수 없습니다.');
		ctx.drawImage(bitmap, 0, 0);
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error('webp 변환에 실패했습니다.'))),
				'image/webp',
				quality
			);
		});
	} finally {
		bitmap.close?.();
	}
}
