import { json, error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { setBlockedReason } from '$lib/server/db/users';
import type { RequestHandler } from './$types';

/**
 * 유저 차단/해제 (관리자 전용).
 * body: { reason: string | null } — 사유가 있으면 차단, 비었으면(null/'') 해제.
 * 비관리자/비로그인은 404(존재 은폐). 관리자 자기 자신은 차단 불가(자물쇠 방지).
 */
export const POST: RequestHandler = async ({ params, locals, platform, request }) => {
	requireAdmin(locals.user?.email);

	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	if (params.id === locals.user?.id) error(400, '자기 자신은 차단할 수 없어요.');

	let reason: string | null = null;
	try {
		const body = (await request.json()) as { reason?: unknown };
		if (typeof body.reason === 'string') reason = body.reason;
	} catch {
		// 본문 없음 = 해제
	}

	const saved = await setBlockedReason(db, params.id, reason);
	return json({ blockedReason: saved });
};
