/**
 * HTTP 상태를 실은 에러 — 기존 SvelteKit `error()` 대체.
 * Hono 전역 onError 핸들러가 이걸 잡아 적절한 Response 로 변환한다.
 */
export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly body?: unknown
	) {
		super(message);
		this.name = 'HttpError';
	}
}

/** SvelteKit `error(status, message)` 와 시그니처를 맞춘 헬퍼. */
export function httpError(status: number, message: string): never {
	throw new HttpError(status, message);
}

/**
 * 데이터 로더의 soft redirect 신호 — 구 SvelteKit `redirect()` 대체.
 * 정적 SPA 는 서버 302 를 따라갈 수 없으므로, 데이터 엔드포인트는 이걸 던지고
 * Worker onError 가 `{ redirect }` JSON(200) 으로 변환 → 클라가 직접 네비게이트한다.
 */
export class Redirect {
	constructor(
		public readonly location: string,
		public readonly status: number = 302
	) {}
}
