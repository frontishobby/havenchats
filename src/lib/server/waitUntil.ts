import { waitUntil as vercelWaitUntil } from '@vercel/functions';

/** 요청 수명 너머로 백그라운드 작업을 살려두는 핸들. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * 백그라운드 작업 스케줄러를 돌려준다(드롭인: 기존 `platform.context.waitUntil` 자리).
 *  - CF Pages/Workers: platform.context.waitUntil 로 워커 생존 보장.
 *  - Vercel: @vercel/functions 의 waitUntil 로 함수 생존 보장.
 *  - 그 외/런타임 밖: best-effort fire-and-forget(에러는 잡아 로깅).
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
		if (native) {
			native(guarded);
			return;
		}
		// 비-CF(Vercel 등): @vercel/functions 의 waitUntil 로 생존 보장.
		// 요청 컨텍스트 밖에서 호출되면 throw 할 수 있어 try/catch → fire-and-forget 폴백.
		try {
			vercelWaitUntil(guarded);
		} catch {
			// guarded 는 이미 실행 중 → best-effort.
		}
	};
}
