/** 요청 수명 너머로 백그라운드 작업을 살려두는 핸들. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * 백그라운드 작업 스케줄러를 돌려준다(드롭인: 기존 `platform.context.waitUntil` 자리).
 *  - CF Pages/Workers: platform.context.waitUntil 로 워커 생존 보장.
 *  - 그 외(Vercel 등): best-effort fire-and-forget(에러는 잡아 로깅).
 *
 * Vercel 이주 시 아래 fallback 을 `@vercel/functions` 의 waitUntil 로 교체하면
 * 모든 호출부가 자동으로 생존 보장을 받는다(이 함수 한 곳만 고치면 됨).
 *
 * 항상 함수를 반환하며, 넘긴 promise 의 rejection 을 삼켜(unhandled 방지) 준다.
 */
export function getWaitUntil(platform: Readonly<App.Platform> | undefined): WaitUntil {
	const native = platform?.context?.waitUntil
		? platform.context.waitUntil.bind(platform.context)
		: null;
	return (promise) => {
		const guarded = Promise.resolve(promise).catch((e) =>
			console.error('[waitUntil] background task error:', e)
		);
		if (native) native(guarded);
		// native 가 없으면(Vercel 등) guarded 가 이미 실행 중 → best-effort.
	};
}
