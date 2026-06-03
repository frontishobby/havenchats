import { redirect } from '@sveltejs/kit';
import { generateState, generateCodeVerifier } from 'arctic';
import { createGoogle, STATE_COOKIE, VERIFIER_COOKIE } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, cookies }) => {
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const google = createGoogle(url.origin);
	// id(sub) + email 만 요청 (이름/사진 미수집)
	const authUrl = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email']);

	const opts = {
		path: '/',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'lax' as const,
		maxAge: 60 * 10 // 10분
	};
	cookies.set(STATE_COOKIE, state, opts);
	cookies.set(VERIFIER_COOKIE, codeVerifier, opts);

	redirect(302, authUrl.toString());
};
