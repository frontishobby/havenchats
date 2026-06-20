import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { setRuntime } from '$lib/server/env';
import { SESSION_COOKIE, verifySessionToken } from '$lib/server/auth';
import { getUserProfile, type UserProfile } from '$lib/server/db/users';
import { HttpError, Redirect } from '$lib/server/httpError';
import { getWaitUntil } from '$lib/server/waitUntil';
import { notifyServerError } from '$lib/server/notify';
import type { AppEnv } from './context';
import { authRouter } from './routes/auth';
import { imgRouter } from './routes/img';
import { apiRouter } from './routes/api';

const CANONICAL_HOST = 'havenchats.com';

const app = new Hono<AppEnv>();

// ── 요청 런타임 연결 + 세션 → 유저 로드 (구 hooks.server.ts) ──────
app.use('*', async (c, next) => {
	setRuntime(c.env, c.executionCtx);

	// workers.dev 등 비표준 호스트 → 커스텀 도메인 301.
	const url = new URL(c.req.url);
	if (url.hostname.endsWith('.workers.dev')) {
		url.hostname = CANONICAL_HOST;
		url.protocol = 'https:';
		url.port = '';
		return c.redirect(url.toString(), 301);
	}

	const token = getCookie(c, SESSION_COOKIE);
	const identity = token ? await verifySessionToken(token) : null;

	if (!identity) {
		c.set('user', null);
	} else {
		const profile = c.env.DB ? await getUserProfile(c.env.DB, identity.id) : null;
		const user: UserProfile = profile ?? {
			id: identity.id,
			email: identity.email,
			name: null,
			personaName: null,
			avatarUrl: null,
			persona: null,
			preference: null,
			country: null,
			profileComplete: false,
			blockedReason: null
		};
		c.set('user', user);

		// 차단된 유저는 변이성 요청(GET/HEAD 외) 차단.
		if (user.blockedReason && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
			return c.json({ error: '차단된 계정입니다.' }, 403);
		}
	}

	await next();
});

app.route('/auth', authRouter);
app.route('/img', imgRouter);
app.route('/api', apiRouter);

// ── 전역 에러 핸들러 (구 handleError) ──────────────────────────
app.onError((err, c) => {
	// 데이터 로더 soft redirect → 정적 SPA 가 따라갈 JSON 힌트(200).
	if (err instanceof Redirect) {
		return c.json({ redirect: err.location });
	}
	if (err instanceof HttpError) {
		return c.json({ error: err.message }, err.status as never);
	}
	console.error('[worker] unhandled error:', err);
	notifyServerError({
		context: `${c.req.method} ${new URL(c.req.url).pathname}`,
		error: err,
		extra: { userId: c.get('user')?.id ?? 'anon' },
		waitUntil: getWaitUntil()
	});
	return c.json({ error: '서버 오류가 발생했습니다.' }, 500);
});

// 안전망: run_worker_first 밖의 경로가 들어오면 정적 SPA(ASSETS)로 폴백.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
