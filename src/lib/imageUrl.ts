import { dev } from '$app/environment';
import { IMAGE_BASE } from './imageBase';

/**
 * CF Image Transformations 리사이즈 URL.
 * servable URL 에 `/cdn-cgi/image/<옵션>` 프리픽스를 붙여 width 기반 리사이즈 +
 * format=auto(브라우저별 AVIF/WebP) 변환본을 서빙한다.
 *
 * - 로컬 `/img/<key>`(CF 존) 또는 공개 도메인 `https://img.havenchats.com/<key>`(R2 존) 모두 지원.
 *   둘 다 CF 존이라 /cdn-cgi/image 변환이 엣지에서 처리된다. 대시보드 Images > Transformations 활성화 필요.
 * - dev(vite)엔 /cdn-cgi 경로가 없으므로 원본 URL 그대로 반환.
 * - blob:/data:/외부(dicebear) 등 위 베이스가 아닌 소스도 그대로 통과.
 * - fit 기본값(scale-down)이라 원본보다 큰 width 를 줘도 업스케일되지 않는다.
 * - 과금: unique(원본×옵션) 월 5,000개 무료 → width 값은 티어로 통일해 조합 수를 억제.
 *   64(아이콘 ≤32px) / 96(33~48px) / 128(~52px) / 160(~76px) / 480(카드 그리드)
 * - 작은 썸네일에만 적용한다. 원본 감상용(상세 모달·채팅 장면·실시간 생성)은 원본 서빙.
 */
export function resized(url: string, width: number): string;
export function resized(url: string | null, width: number): string | null;
export function resized(url: string | null, width: number): string | null {
	if (!url || dev) return url;
	const opts = `/cdn-cgi/image/width=${width},quality=80,format=auto`;
	// 로컬 /img 라우트(상대 경로)
	if (url.startsWith('/img/')) return `${opts}${url}`;
	// 공개 도메인(절대 URL) — origin 뒤에 변환 옵션을 삽입
	if (IMAGE_BASE.startsWith('http') && url.startsWith(`${IMAGE_BASE}/`)) {
		return `${IMAGE_BASE}${opts}${url.slice(IMAGE_BASE.length)}`;
	}
	return url;
}
