import { getRuntimeEnv } from '$lib/server/env';

/**
 * R2 핸들 획득.
 *
 * (구) Vercel 시절엔 HTTP 프록시 Worker 로 R2 put/delete/list 를 미러링했지만,
 * 이제는 앱이 Cloudflare Worker 라 `env.IMAGES` 네이티브 바인딩을 직접 쓴다.
 *
 * 시그니처는 기존 호출부(`getImages(platform)`) 호환을 위해 optional 인자를 받지만 무시한다.
 */
export function getImages(_platform?: unknown): R2Bucket | undefined {
	return getRuntimeEnv().IMAGES;
}
