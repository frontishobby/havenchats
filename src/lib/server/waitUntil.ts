import { getExecutionCtx } from '$lib/server/env';

/** 요청 수명 너머로 백그라운드 작업을 살려두는 핸들. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * 백그라운드 작업 스케줄러를 돌려준다.
 * Cloudflare Worker 의 ExecutionContext.waitUntil 로 워커 생존을 보장한다.
 * ctx 가 없으면(요청 컨텍스트 밖) best-effort fire-and-forget.
 *
 * 시그니처는 기존 호출부(`getWaitUntil(platform)`) 호환을 위해 optional 인자를 받지만 무시한다.
 */
export function getWaitUntil(_platform?: unknown): WaitUntil {
	const ctx = getExecutionCtx();
	return (promise) => {
		const guarded = Promise.resolve(promise).catch((e) =>
			console.error('[waitUntil] background task error:', e)
		);
		if (ctx) {
			ctx.waitUntil(guarded);
		}
		// ctx 없으면 guarded 가 이미 실행 중 → fire-and-forget.
	};
}
