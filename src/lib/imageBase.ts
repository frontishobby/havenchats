import { env } from '$env/dynamic/public';

/**
 * 이미지 서빙 베이스 URL(끝 슬래시 없음).
 *  - 비어 있으면 로컬 `/img/[...key]` 라우트(CF 네이티브 바인딩으로 R2 서빙).
 *  - 공개 도메인(예: https://img.havenchats.com)을 주면 R2 공개 커스텀 도메인으로 직접 서빙.
 * 호스팅 전환(CF↔Vercel)은 PUBLIC_IMAGE_BASE env 만 바꾸면 됨. 클라/서버 공용.
 */
export const IMAGE_BASE = (env.PUBLIC_IMAGE_BASE || '/img').replace(/\/+$/, '');

/** R2 오브젝트 키 → 서빙 URL(쿼리 없음). 캐시버스팅(`?v=`)은 withVersion 으로 별도 부착. */
export function imgSrc(key: string): string {
	return `${IMAGE_BASE}/${key}`;
}
