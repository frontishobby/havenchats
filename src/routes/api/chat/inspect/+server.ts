import { json, type RequestHandler } from '@sveltejs/kit';
import { findCharacter } from '$lib/server/characters';
import {
	getCharacterPrompt,
	getCharacterLorebook,
	getCharacterDefaultVars
} from '$lib/server/db/characters';
import { isAdmin } from '$lib/server/auth';
import { makeRng, type CbsContext } from '$lib/cbs';
import { getSession, getWindow, estimateTokens } from '$lib/server/db/chats';
import { personalize } from '$lib/placeholders';
import type { ChatSession, StoredMessage } from '$lib/types';
import {
	assembleTurn,
	buildSnapshot,
	clampSentences,
	clampUserActs,
	openingContent,
	pickModel
} from '$lib/server/chatAssembly';

/**
 * 디버그 드라이런 — 모델 호출·DB 영속 없이, "지금 보내면 어떤 프롬프트가 나가는지"를 조립해 반환한다.
 * 디버그 패널이 변수/요약/기억을 손본 뒤 또는 다음 입력을 미리보기 위해 호출한다.
 *
 * 접근: 캐릭터 제작자 본인 또는 관리자만(시스템 프롬프트·숨김 카드 노출 방지).
 * 부수효과 없음(scriptState 미저장) — ctx 는 throwaway.
 */
interface InspectBody {
	characterId: string;
	/** 있으면 그 세션 상태로, 없으면 새 세션(오프닝)으로 미리보기. */
	sessionId?: string;
	/** 다음에 보낼 유저 메시지(미리보기용, 선택). window 끝에 가상으로 덧붙인다. */
	text?: string;
	openingIndex?: number;
	model?: string;
	maxSentences?: number;
	userActs?: number;
	/** 저장하지 않고 이 변수로 평가해 미리보기(변수 조작 실험용). */
	varsOverride?: Record<string, string>;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json()) as InspectBody;
	const character = await findCharacter(db, body.characterId);
	if (!character) return json({ error: 'character not found' }, { status: 404 });

	// 게이트: 제작자 본인 또는 관리자만.
	const canDebug = isAdmin(locals.user.email) || character.creator.id === locals.user.id;
	if (!canDebug) return json({ error: 'forbidden' }, { status: 403 });

	// imported 카드는 서버 전용 원문을 채워 넣는다(/api/chat 와 동일).
	let characterDefaultVars: Record<string, string> | null = null;
	if (character.imported) {
		const raw = await getCharacterPrompt(db, character.id);
		if (raw != null) character.description = raw;
		character.lorebook = await getCharacterLorebook(db, character.id);
		characterDefaultVars = await getCharacterDefaultVars(db, character.id);
	}

	const userId = locals.user.id;
	const userName = (locals.user.personaName && locals.user.personaName.trim()) || locals.user.name;
	const userPersona = locals.user.persona;
	const modelId = pickModel(body.model);
	const maxSentences = clampSentences(body.maxSentences);
	const userActs = clampUserActs(body.userActs);
	const text = (body.text ?? '').trim();

	// 세션 확정(읽기 전용). 없으면 새 세션 미리보기.
	let session: ChatSession | null = null;
	if (body.sessionId) {
		session = await getSession(db, body.sessionId, userId);
		if (!session) return json({ error: 'session not found' }, { status: 404 });
	}

	// live window 구성 — 세션이 있으면 DB window, 없으면 오프닝으로 가상 구성. text 가 있으면 가상 유저 메시지 추가.
	const fullWindow: Array<StoredMessage & { tokenEst: number }> = [];
	if (session) {
		const win = await getWindow(db, session.id, session.summaryUptoSeq);
		fullWindow.push(...win);
		if (text) {
			fullWindow.push(synthMsg('preview-user', session.messageCount + 1, 'user', text));
		}
	} else {
		const opening = personalize(
			openingContent(character, body.openingIndex),
			character.name,
			userName
		);
		if (opening.trim()) fullWindow.push(synthMsg('preview-opening', 1, 'assistant', opening));
		if (text) fullWindow.push(synthMsg('preview-user', fullWindow.length + 1, 'user', text));
	}

	const lastSeq = fullWindow.length > 0 ? fullWindow[fullWindow.length - 1].seq : 1;
	const varsBefore = { ...(characterDefaultVars ?? {}), ...(session?.scriptState ?? {}) };
	const ctx: CbsContext = {
		vars: { ...varsBefore, ...(body.varsOverride ?? {}) },
		index: lastSeq,
		lang: 'ko',
		rng: makeRng(`${session?.id ?? 'preview'}:${lastSeq}`),
		now: Date.now()
	};

	const assembled = assembleTurn({
		character,
		fullWindow,
		summary: session?.summary ?? null,
		memory: session?.memory ?? null,
		userName,
		userPersona,
		modelId,
		maxSentences,
		userActs,
		ctx
	});

	const snapshot = buildSnapshot({
		source: 'preview',
		model: modelId,
		assembled,
		character,
		session,
		defaultVars: characterDefaultVars,
		varsBefore,
		varsAfter: { ...ctx.vars },
		userName,
		userPersona,
		summary: session?.summary ?? null,
		memory: session?.memory ?? null,
		maxSentences,
		userActs
	});

	return json(snapshot);
};

/** 미리보기용 가상 메시지(DB 미저장). token_est 는 실제 추정과 동일 기준. */
function synthMsg(
	id: string,
	seq: number,
	role: 'user' | 'assistant',
	content: string
): StoredMessage & { tokenEst: number } {
	return { id, seq, role, content, tokenEst: estimateTokens(content) };
}
