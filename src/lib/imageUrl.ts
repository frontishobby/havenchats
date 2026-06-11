import { dev } from '$app/environment';

/**
 * CF Image Transformations 리사이즈 URL.
 * `/img/<key>?v=...` servable URL 에 `/cdn-cgi/image/<옵션>` 프리픽스를 붙여
 * width 기반 리사이즈 + format=auto(브라우저별 AVIF/WebP) 변환본을 서빙한다.
 *
 * - prod 존(havenchats.com)에서만 동작 — 대시보드 Images > Transformations 활성화 필요.
 *   /cdn-cgi/image/* 는 엣지가 가로채 처리하므로 Worker 코드에는 도달하지 않는다.
 * - dev(vite)엔 /cdn-cgi 경로가 없으므로 원본 URL 그대로 반환.
 * - blob:/data:/외부 URL 등 /img/ 가 아닌 소스도 그대로 통과.
 * - fit 기본값(scale-down)이라 원본보다 큰 width 를 줘도 업스케일되지 않는다.
 * - 과금: unique(원본×옵션) 월 5,000개 무료 → width 값은 아래 티어로 통일해 조합 수를 억제.
 *   64(아이콘 ≤32px) / 96(33~48px) / 128(~52px) / 160(~76px) / 480(카드 그리드)
 * - 작은 썸네일에만 적용한다. 이미지를 그 자체로 감상하는 곳(상세 모달 미리보기,
 *   채팅 장면 이미지·실시간 생성 결과)은 원본을 그대로 서빙.
 */
export function resized(url: string, width: number): string;
export function resized(url: string | null, width: number): string | null;
export function resized(url: string | null, width: number): string | null {
	if (!url || dev || !url.startsWith('/img/')) return url;
	return `/cdn-cgi/image/width=${width},quality=80,format=auto${url}`;
}
