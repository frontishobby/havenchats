import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth';
import type { RequestHandler } from './$types';

function logout(cookies: import('@sveltejs/kit').Cookies): never {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(302, '/');
}

export const POST: RequestHandler = ({ cookies }) => logout(cookies);
export const GET: RequestHandler = ({ cookies }) => logout(cookies);
