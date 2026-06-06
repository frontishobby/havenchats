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
