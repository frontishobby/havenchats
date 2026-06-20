import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { generateState, generateCodeVerifier, decodeIdToken } from 'arctic';
import {
	createGoogle,
	createSessionToken,
	isEmailAllowed,
	SESSION_COOKIE,
	SESSION_TTL,
	STATE_COOKIE,
	VERIFIER_COOKIE,
	type SessionIdentity
} from '$lib/server/auth';
import { findOrCreateOAuthUser } from '$lib/server/db/users';
import type { AppEnv, AppContext } from '../context';

export const authRouter = new Hono<AppEnv>();

// ── Google OAuth 시작 ──────────────────────────────────────────
authRouter.get('/google', (c) => {
	const url = new URL(c.req.url);
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const google = createGoogle(url.origin);
	// id(sub) + email 만 요청 (이름/사진 미수집)
	const authUrl = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email']);

	const opts = {
		path: '/',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'Lax' as const,
		maxAge: 60 * 10 // 10분
	};
	setCookie(c, STATE_COOKIE, state, opts);
	setCookie(c, VERIFIER_COOKIE, codeVerifier, opts);

	return c.redirect(authUrl.toString(), 302);
});

// ── Google OAuth 콜백 ──────────────────────────────────────────
authRouter.get('/google/callback', async (c) => {
	const url = new URL(c.req.url);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = getCookie(c, STATE_COOKIE);
	const codeVerifier = getCookie(c, VERIFIER_COOKIE);

	if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
		return c.redirect('/?auth=error', 302);
	}

	let claims: Record<string, unknown>;
	try {
		const google = createGoogle(url.origin);
		const tokens = await google.validateAuthorizationCode(code, codeVerifier);
		claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
	} catch (e) {
		console.error('[auth] google callback error:', e);
		return c.redirect('/?auth=error', 302);
	}

	const providerUserId = String(claims.sub ?? '');
	const email = String(claims.email ?? '');
	if (!providerUserId) return c.redirect('/?auth=error', 302);

	// [테스트용] 화이트리스트 외 이메일 차단 (세션·DB 생성 안 함)
	if (!isEmailAllowed(email)) {
		console.warn('[auth] blocked non-allowlisted email:', email);
		deleteCookie(c, STATE_COOKIE, { path: '/' });
		deleteCookie(c, VERIFIER_COOKIE, { path: '/' });
		return c.redirect('/?auth=notallowed', 302);
	}

	// DB에 유저 upsert → 내부 user id 로 세션 발급.
	let identity: SessionIdentity;
	const db = c.env.DB;
	if (db) {
		identity = await findOrCreateOAuthUser(db, { provider: 'google', providerUserId, email });
	} else {
		console.warn('[auth] D1 binding(DB) 없음 — 세션을 google sub 로 폴백');
		identity = { id: providerUserId, email };
	}

	const token = await createSessionToken(identity);
	setCookie(c, SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'Lax',
		maxAge: SESSION_TTL
	});

	deleteCookie(c, STATE_COOKIE, { path: '/' });
	deleteCookie(c, VERIFIER_COOKIE, { path: '/' });

	return c.redirect('/', 302);
});

// ── 로그아웃 ───────────────────────────────────────────────────
function logout(c: AppContext) {
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
	return c.redirect('/', 302);
}
authRouter.post('/logout', (c) => logout(c));
authRouter.get('/logout', (c) => logout(c));
