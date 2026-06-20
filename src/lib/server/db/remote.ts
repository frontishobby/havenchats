import { getRuntimeEnv } from '$lib/server/env';

/**
 * D1 핸들 획득.
 *
 * (구) Vercel 호스팅 시절엔 HTTP 프록시 Worker(haven-d1-api)로 D1 을 미러링했지만,
 * 이제는 앱 자체가 Cloudflare Worker 라 `env.DB` 네이티브 바인딩을 직접 쓴다 — 오버헤드 0.
 *
 * 시그니처는 기존 호출부(`getDB(platform)`) 호환을 위해 optional 인자를 받지만 무시한다.
 */
export function getDB(_platform?: unknown): D1Database | undefined {
	return getRuntimeEnv().DB;
}
