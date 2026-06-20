/**
 * `$env/dynamic/private` 호환 shim — 독립 Hono Worker 용.
 *
 * wrangler.jsonc 의 `alias` 로 `"$env/dynamic/private"` → 이 파일에 매핑된다.
 * 따라서 `import { env } from '$env/dynamic/private'` 를 쓰던 기존 server 코드는 무수정 재사용된다.
 *
 * Workers 런타임에선 vars·secrets·바인딩(DB/IMAGES/ASSETS)이 모두 fetch(req, env, ctx) 의
 * 단일 `env` 객체에 들어온다. 그래서 이 proxy 하나로 `env.AUTH_SECRET`(문자열)과
 * `env.DB`(D1Database) 를 모두 읽을 수 있다. 값은 배포 단위로 고정이라(요청별로 안 바뀜)
 * 모듈 전역에 담아도 동시요청 간 안전하다.
 */

export interface WorkerEnv {
	DB: D1Database;
	IMAGES: R2Bucket;
	ASSETS: Fetcher;
	[key: string]: unknown;
}

let _env: Record<string, unknown> = {};
let _ctx: ExecutionContext | null = null;

/** Worker fetch 핸들러 시작 시 1회 호출 — env/ctx 를 요청 컨텍스트에 연결. */
export function setRuntime(workerEnv: Record<string, unknown>, ctx: ExecutionContext): void {
	_env = workerEnv;
	_ctx = ctx;
}

/** 백그라운드 작업 생존용 ExecutionContext (waitUntil.ts 에서 사용). */
export function getExecutionCtx(): ExecutionContext | null {
	return _ctx;
}

/** 바인딩까지 포함한 raw worker env (DB/IMAGES 핸들 획득용). */
export function getRuntimeEnv(): WorkerEnv {
	return _env as WorkerEnv;
}

/**
 * SvelteKit `$env/dynamic/private` 의 `env` 와 동일한 형태(Record<string,string>) 로 노출.
 * 실제론 바인딩 객체도 그대로 통과시키므로 호출부에서 필요 시 캐스팅한다.
 */
export const env = new Proxy({} as Record<string, string>, {
	get: (_t, prop: string) => _env[prop] as string,
	has: (_t, prop: string) => prop in _env,
	ownKeys: () => Reflect.ownKeys(_env),
	getOwnPropertyDescriptor: (_t, prop) => ({
		enumerable: true,
		configurable: true,
		value: _env[prop as string]
	})
});
