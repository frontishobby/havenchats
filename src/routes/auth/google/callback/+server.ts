import { redirect } from '@sveltejs/kit';
import { decodeIdToken } from 'arctic';
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
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, platform }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get(STATE_COOKIE);
	const codeVerifier = cookies.get(VERIFIER_COOKIE);

	if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
		redirect(302, '/?auth=error');
	}

	let claims: Record<string, unknown>;
	try {
		const google = createGoogle(url.origin);
		const tokens = await google.validateAuthorizationCode(code, codeVerifier);
		claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
	} catch (e) {
		console.error('[auth] google callback error:', e);
		redirect(302, '/?auth=error');
	}

	const providerUserId = String(claims.sub ?? '');
	const email = String(claims.email ?? '');
	if (!providerUserId) {
		redirect(302, '/?auth=error');
	}

	// [테스트용] 화이트리스트 외 이메일 차단 (세션·DB 생성 안 함)
	if (!isEmailAllowed(email)) {
		console.warn('[auth] blocked non-allowlisted email:', email);
		cookies.delete(STATE_COOKIE, { path: '/' });
		cookies.delete(VERIFIER_COOKIE, { path: '/' });
		redirect(302, '/?auth=notallowed');
	}

	// DB에 유저 upsert → 내부 user id 로 세션 발급. (DB 바인딩 없으면 google sub 로 폴백)
	let identity: SessionIdentity;
	const db = platform?.env?.DB;
	if (db) {
		identity = await findOrCreateOAuthUser(db, { provider: 'google', providerUserId, email });
	} else {
		console.warn('[auth] D1 binding(DB) 없음 — 세션을 google sub 로 폴백');
		identity = { id: providerUserId, email };
	}

	const token = await createSessionToken(identity);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'lax',
		maxAge: SESSION_TTL
	});

	cookies.delete(STATE_COOKIE, { path: '/' });
	cookies.delete(VERIFIER_COOKIE, { path: '/' });

	redirect(302, '/');
};
