/**
 * 서버 에러 알림 — 정적(브라우저) 런타임에선 콘솔 로그로만 남긴다.
 * (구 Discord 웹훅 알림은 Worker 폐기와 함께 제거. 호출부 시그니처는 유지.)
 */
export interface NotifyOptions {
	context: string;
	error: unknown;
	extra?: Record<string, unknown>;
	waitUntil?: (p: Promise<unknown>) => void;
}

export function notifyServerError(opts: NotifyOptions): Promise<void> {
	console.error(`[error] ${opts.context}`, opts.error, opts.extra ?? '');
	return Promise.resolve();
}
