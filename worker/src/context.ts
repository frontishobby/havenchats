import type { Context } from 'hono';
import type { WorkerEnv } from '$lib/server/env';
import type { UserProfile } from '$lib/server/db/users';
import { HttpError } from '$lib/server/httpError';

/** Hono 앱 타입 — 바인딩(c.env) + 요청 변수(c.var.user). */
export type AppEnv = {
	Bindings: WorkerEnv;
	Variables: { user: UserProfile | null };
};

export type AppContext = Context<AppEnv>;

/** 로그인 필수 — 비로그인 시 401. */
export function requireUser(c: AppContext): UserProfile {
	const user = c.get('user');
	if (!user) throw new HttpError(401, '로그인이 필요합니다.');
	return user;
}
