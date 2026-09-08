/**
 * 이미지 리사이즈 URL — 정적 1인 모드에선 변환 서버(CF Image Transformations)가 없으므로 원본 URL 그대로.
 * 호출부(카드·아바타 썸네일)의 `resized(url, width)` 시그니처는 유지한다.
 */
export function resized(url: string, width: number): string;
export function resized(url: string | null, width: number): string | null;
export function resized(url: string | null, _width: number): string | null {
	return url;
}
