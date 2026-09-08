/**
 * 브라우저에서 도는 Hono 앱 — 구 Cloudflare Worker(`worker/src/index.ts`)의 브라우저판.
 *
 * SPA 가 `fetch('/api/..')`/`fetch('/img/..')` 를 부르면 `app.html` 의 fetch 래퍼가 네트워크 대신
 * 여기 `localFetch` 로 넘긴다 → 같은 라우트 핸들러가 로컬 SQLite(D1 shim)·IndexedDB(R2 shim)로 응답.
 * 스트리밍 응답(채팅)도 ReadableStream 그대로 통과한다.
 *
 * 유저: 로그인 없음. `users` 테이블의 유일한 행이 곧 '나'(runtime 이 보장).
 */
import { Hono } from 'hono';
import { setRuntime, type WorkerEnv } from '$lib/backend/env';
import { getUserProfile } from '$lib/backend/db/users';
import { HttpError, Redirect } from '$lib/backend/httpError';
import type { AppEnv } from '$lib/backend/context';
import { imgRouter } from '$lib/backend/routes/img';
import { apiRouter } from '$lib/backend/routes/api';

export interface LocalRuntimeCtx extends ExecutionContext {
	/** waitUntil 로 등록된 미완료 백그라운드 작업(저장 전 대기용). */
	pending: Set<Promise<unknown>>;
}

export function createLocalCtx(): LocalRuntimeCtx {
	const pending = new Set<Promise<unknown>>();
	return {
		pending,
		waitUntil(p: Promise<unknown>) {
			pending.add(p);
			p.finally(() => pending.delete(p)).catch(() => {});
		},
		passThroughOnException() {},
		props: {}
	} as unknown as LocalRuntimeCtx;
}

export function createLocalApp(env: WorkerEnv, ctx: LocalRuntimeCtx, getUserId: () => string) {
	const app = new Hono<AppEnv>();

	app.use('*', async (c, next) => {
		setRuntime(env, ctx);
		c.set('user', await getUserProfile(env.DB, getUserId()));
		await next();
	});

	app.route('/img', imgRouter);
	app.route('/api', apiRouter);

	app.onError((err, c) => {
		if (err instanceof Redirect) return c.json({ redirect: err.location });
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as never);
		console.error('[local] unhandled error:', err);
		return c.json({ error: '오류가 발생했습니다.' }, 500);
	});

	app.notFound((c) => c.json({ error: 'not found' }, 404));

	return {
		fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			return Promise.resolve(app.fetch(new Request(input, init), env, ctx));
		}
	};
}
