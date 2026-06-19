import { getDB } from '$lib/server/db/remote';
import { json, type RequestHandler } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import { getCharacterDefaultVars } from '$lib/server/db/characters';
import { isAdmin } from '$lib/server/auth';
import { getSession, updateScriptState } from '$lib/server/db/chats';

/**
 * 디버그 — 세션 CBS 변수(script_state) 조회/덮어쓰기.
 * 접근: 캐릭터 제작자 본인 또는 관리자(시스템 내부 상태 조작).
 *
 *  GET  ?sessionId=&characterId=  → { vars, defaultVars }
 *  POST { sessionId, characterId, vars } → 저장 후 { vars }
 */

/** 세션 소유 + 디버그 권한 확인. 통과 시 null, 아니면 에러 Response. */
async function guard(
	db: D1Database,
	userId: string,
	email: string | null,
	characterId: string,
	sessionId: string
) {
	const character = await findCharacter(db, characterId);
	if (!character) return json({ error: 'character not found' }, { status: 404 });
	const canDebug = isAdmin(email) || character.creator.id === userId;
	if (!canDebug) return json({ error: 'forbidden' }, { status: 403 });
	const session = await getSession(db, sessionId, userId);
	if (!session) return json({ error: 'session not found' }, { status: 404 });
	return null;
}

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const sessionId = url.searchParams.get('sessionId');
	const characterId = url.searchParams.get('characterId');
	if (!sessionId || !characterId) return json({ error: 'missing params' }, { status: 400 });

	const err = await guard(db, locals.user.id, locals.user.email, characterId, sessionId);
	if (err) return err;

	const session = await getSession(db, sessionId, locals.user.id);
	const defaultVars = await getCharacterDefaultVars(db, characterId);
	return json({ vars: session?.scriptState ?? {}, defaultVars: defaultVars ?? {} });
};

interface VarsBody {
	sessionId: string;
	characterId: string;
	/** 새 변수 맵 전체(기존을 통째로 대체). 키는 소문자 정규화. */
	vars: Record<string, unknown>;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = getDB(platform);
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json()) as VarsBody;
	if (!body.sessionId || !body.characterId) return json({ error: 'missing params' }, { status: 400 });

	const err = await guard(db, locals.user.id, locals.user.email, body.characterId, body.sessionId);
	if (err) return err;

	// 문자열/숫자/불리언만 받아 문자열로 정규화(손상 입력 방어). 키는 소문자.
	const clean: Record<string, string> = {};
	if (body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)) {
		for (const [k, v] of Object.entries(body.vars)) {
			const key = String(k).trim().toLowerCase();
			if (!key) continue;
			if (typeof v === 'string') clean[key] = v;
			else if (typeof v === 'number' || typeof v === 'boolean') clean[key] = String(v);
		}
	}

	await updateScriptState(db, body.sessionId, clean);
	return json({ vars: clean });
};
