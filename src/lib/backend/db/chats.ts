import type { ChatSession, StoredMessage, Role, AppearanceLedger, OutfitLedger } from '$lib/types';

/**
 * 대화 영속화(세션/메시지) + 토큰 전략 상태 접근.
 *
 * 전략:
 *  ① sliding window — 모델에 보내는 건 seq > summary_upto_seq 인 메시지뿐.
 *  ② rolling summary — 그 앞부분은 session.summary 에 압축 누적.
 * 두 경계(summary_upto_seq)를 "임계치마다 한 칸씩" 전진시켜 메시지 prefix 캐싱을 보존한다.
 *
 * 캐릭터 정의는 여기 저장하지 않는다(라이브 참조). 오프닝만 seq=1 로 박제.
 */

/** 한글 위주 보수적 토큰 추정(정밀 토크나이저는 Workers 에 과함). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 2);
}

interface SessionRow {
	id: string;
	user_id: string;
	character_id: string;
	model: string | null;
	summary: string | null;
	summary_upto_seq: number;
	memory: string | null;
	script_state: string | null;
	appearances: string | null;
	outfits: string | null;
	message_count: number;
	created_at: number;
	updated_at: number;
	last_message_at: number | null;
}

/** JSON 문자열을 변수 맵(Record<string,string>)으로 안전 파싱. 손상/빈 값이면 null. */
function parseScriptState(json: string | null): Record<string, string> | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === 'string') out[k] = v;
			else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
		}
		return Object.keys(out).length > 0 ? out : null;
	} catch {
		return null;
	}
}

/**
 * 외형 원장 JSON 파싱. 손상/빈 값이면 null. appearance 문자열이 있는 항목만 채택하고
 * lastSeen 은 숫자가 아니면 0 으로 보정한다.
 */
function parseAppearances(json: string | null): AppearanceLedger | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const out: AppearanceLedger = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = v as { appearance?: unknown; lastSeen?: unknown };
			if (e && typeof e.appearance === 'string' && e.appearance.trim()) {
				out[k] = {
					appearance: e.appearance,
					lastSeen: typeof e.lastSeen === 'number' ? e.lastSeen : 0
				};
			}
		}
		return Object.keys(out).length > 0 ? out : null;
	} catch {
		return null;
	}
}

/** 복장 원장 JSON 파싱(손상/빈 값이면 null). 형식은 parseAppearances 와 동일 구조(outfit 필드). */
function parseOutfits(json: string | null): OutfitLedger | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const out: OutfitLedger = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = v as { outfit?: unknown; lastSeen?: unknown };
			if (e && typeof e.outfit === 'string' && e.outfit.trim()) {
				out[k] = {
					outfit: e.outfit,
					lastSeen: typeof e.lastSeen === 'number' ? e.lastSeen : 0
				};
			}
		}
		return Object.keys(out).length > 0 ? out : null;
	} catch {
		return null;
	}
}

function rowToSession(r: SessionRow): ChatSession {
	return {
		id: r.id,
		userId: r.user_id,
		characterId: r.character_id,
		model: r.model,
		summary: r.summary,
		summaryUptoSeq: r.summary_upto_seq,
		memory: r.memory,
		scriptState: parseScriptState(r.script_state),
		appearances: parseAppearances(r.appearances),
		outfits: parseOutfits(r.outfits),
		messageCount: r.message_count,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		lastMessageAt: r.last_message_at
	};
}

const SESSION_COLS =
	'id, user_id, character_id, model, summary, summary_upto_seq, memory, script_state, appearances, outfits, message_count, created_at, updated_at, last_message_at';

/** 단일 세션 조회(소유권 확인 포함). */
export async function getSession(
	db: D1Database,
	sessionId: string,
	userId: string
): Promise<ChatSession | null> {
	const row = await db
		.prepare(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ? AND user_id = ?`)
		.bind(sessionId, userId)
		.first<SessionRow>();
	return row ? rowToSession(row) : null;
}

/** (user, character) 의 가장 최근 세션. 없으면 null (= 이어가기 대상). */
export async function getLatestSession(
	db: D1Database,
	userId: string,
	characterId: string
): Promise<ChatSession | null> {
	const row = await db
		.prepare(
			`SELECT ${SESSION_COLS} FROM chat_sessions
			 WHERE user_id = ? AND character_id = ?
			 ORDER BY last_message_at DESC NULLS LAST, created_at DESC
			 LIMIT 1`
		)
		.bind(userId, characterId)
		.first<SessionRow>();
	return row ? rowToSession(row) : null;
}

/** (user, character) 의 세션 목록(최근순). 목록 UI 용. */
export async function listSessions(
	db: D1Database,
	userId: string,
	characterId: string
): Promise<ChatSession[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SESSION_COLS} FROM chat_sessions
			 WHERE user_id = ? AND character_id = ?
			 ORDER BY last_message_at DESC NULLS LAST, created_at DESC`
		)
		.bind(userId, characterId)
		.all<SessionRow>();
	return (results ?? []).map(rowToSession);
}

interface RecentSessionRow {
	id: string;
	character_id: string;
	last_message_at: number | null;
	last_content: string | null;
}

/** 사이드바 페이징 커서 — (last_message_at, sessionId) 복합. 이 지점 '이후'(더 오래된)부터 잇는다. */
export interface RecentSessionCursor {
	lastMessageAt: number;
	sessionId: string;
}

export interface RecentSessionItem {
	sessionId: string;
	characterId: string;
	lastMessageAt: number;
	lastContent: string | null;
}

/**
 * 유저의 최근 세션(캐릭터 무관, 전역 최근순). 사이드바 목록용. 커서 기반 페이징.
 * 각 행에 그 세션의 마지막 메시지 본문(last_content)을 함께 가져온다.
 * 메시지가 한 건도 없는 세션은 last_content=null 로 나오며 호출부에서 거른다.
 *
 * 정렬은 (last_message_at DESC, id DESC) — id(uuid)로 안정적 tiebreak 하여 커서가 흔들리지 않게 한다.
 * `last_message_at IS NOT NULL` 로 빈 세션(메시지/오프닝 없음)을 애초에 제외한다(어차피 호출부에서 거름).
 * cursor 가 있으면 (last_message_at, id) 가 그보다 '작은'(더 오래된) 행만 — keyset 페이징.
 */
export async function listRecentSessions(
	db: D1Database,
	userId: string,
	limit = 30,
	cursor?: RecentSessionCursor | null
): Promise<RecentSessionItem[]> {
	const sub = `(SELECT m.content FROM chat_messages m
	               WHERE m.session_id = s.id AND m.role != 'image_generation'
	               ORDER BY m.seq DESC LIMIT 1) AS last_content`;
	const stmt = cursor
		? db
				.prepare(
					`SELECT s.id, s.character_id, s.last_message_at, ${sub}
					 FROM chat_sessions s
					 WHERE s.user_id = ? AND s.last_message_at IS NOT NULL
					   AND (s.last_message_at < ? OR (s.last_message_at = ? AND s.id < ?))
					 ORDER BY s.last_message_at DESC, s.id DESC
					 LIMIT ?`
				)
				.bind(userId, cursor.lastMessageAt, cursor.lastMessageAt, cursor.sessionId, limit)
		: db
				.prepare(
					`SELECT s.id, s.character_id, s.last_message_at, ${sub}
					 FROM chat_sessions s
					 WHERE s.user_id = ? AND s.last_message_at IS NOT NULL
					 ORDER BY s.last_message_at DESC, s.id DESC
					 LIMIT ?`
				)
				.bind(userId, limit);
	const { results } = await stmt.all<RecentSessionRow>();
	return (results ?? []).map((r) => ({
		sessionId: r.id,
		characterId: r.character_id,
		lastMessageAt: r.last_message_at as number,
		lastContent: r.last_content
	}));
}

/**
 * 세션과 그 메시지를 삭제(소유권 확인). 반환: 실제로 삭제됐는지.
 * chat_messages 는 FK·cascade 가 없으므로 메시지를 먼저 지운 뒤 세션을 지운다.
 */
export async function deleteSession(
	db: D1Database,
	sessionId: string,
	userId: string
): Promise<boolean> {
	const owned = await db
		.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?')
		.bind(sessionId, userId)
		.first<{ id: string }>();
	if (!owned) return false;
	await db.batch([
		db.prepare('DELETE FROM chat_messages WHERE session_id = ?').bind(sessionId),
		db.prepare('DELETE FROM chat_sessions WHERE id = ?').bind(sessionId)
	]);
	return true;
}

/** 최근 keep 개를 제외한 오래된 세션 수·그 세션들의 이미지 수(정리 미리보기). */
export async function countPrunableSessions(
	db: D1Database,
	userId: string,
	keep: number
): Promise<{ total: number; prunable: number; images: number }> {
	const total =
		(await db
			.prepare('SELECT count(*) AS n FROM chat_sessions WHERE user_id = ?')
			.bind(userId)
			.first<{ n: number }>())?.n ?? 0;
	const prunable = Math.max(0, total - keep);
	if (prunable === 0) return { total, prunable: 0, images: 0 };
	const images =
		(await db
			.prepare(
				`SELECT count(*) AS n FROM chat_messages WHERE role = 'image_generation' AND session_id IN (${OLD_SESSIONS_SQL})`
			)
			.bind(userId, keep)
			.first<{ n: number }>())?.n ?? 0;
	return { total, prunable, images };
}

/** 최근 keep 개(마지막 대화 시각 기준) 밖의 세션 id 서브쿼리. bind: (userId, keep) */
const OLD_SESSIONS_SQL = `SELECT id FROM chat_sessions WHERE user_id = ?
	 ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT -1 OFFSET ?`;

/**
 * 오래된 세션 정리: 최근 keep 개만 남기고 나머지 세션·메시지를 지운다.
 * 반환: 지운 세션 수 + 지워야 할 이미지 키(image_generation 행의 content) — 호출부가 스토리지에서 삭제.
 */
export async function pruneOldSessions(
	db: D1Database,
	userId: string,
	keep: number
): Promise<{ deleted: number; imageKeys: string[] }> {
	const ids = (
		await db.prepare(OLD_SESSIONS_SQL).bind(userId, keep).all<{ id: string }>()
	).results.map((r) => r.id);
	if (ids.length === 0) return { deleted: 0, imageKeys: [] };
	const imageKeys = (
		await db
			.prepare(
				`SELECT content FROM chat_messages WHERE role = 'image_generation' AND session_id IN (${OLD_SESSIONS_SQL})`
			)
			.bind(userId, keep)
			.all<{ content: string }>()
	).results.map((r) => r.content);
	await db.batch([
		db
			.prepare(`DELETE FROM chat_messages WHERE session_id IN (${OLD_SESSIONS_SQL})`)
			.bind(userId, keep),
		db.prepare(`DELETE FROM chat_sessions WHERE id IN (${OLD_SESSIONS_SQL})`).bind(userId, keep)
	]);
	return { deleted: ids.length, imageKeys };
}

/**
 * 메시지 1건 삭제(소유권 확인 — 메시지가 속한 세션이 이 유저 것인지). 반환: 실제 삭제 여부.
 * seq 는 재배열하지 않고 session.message_count 도 줄이지 않는다 → 삭제로 생긴 seq 공백은
 * getWindow/getMessagePage(둘 다 seq 순서만 사용)·요약 경계(summary_upto_seq)에 무해하고,
 * 다음 메시지 seq 발급(message_count+1)이 기존 seq 와 충돌하지 않아 안전하다.
 */
export async function deleteMessage(
	db: D1Database,
	messageId: string,
	userId: string
): Promise<boolean> {
	const owned = await db
		.prepare(
			`SELECT m.id FROM chat_messages m
			 JOIN chat_sessions s ON s.id = m.session_id
			 WHERE m.id = ? AND s.user_id = ?`
		)
		.bind(messageId, userId)
		.first<{ id: string }>();
	if (!owned) return false;
	await db.prepare('DELETE FROM chat_messages WHERE id = ?').bind(messageId).run();
	return true;
}

/** 소유자 검증 후 메시지 1건 조회(없거나 남의 것이면 null). 이미지 재생성 등 in-place 갱신용. */
export async function getOwnedMessage(
	db: D1Database,
	messageId: string,
	userId: string
): Promise<{ id: string; sessionId: string; role: Role; content: string } | null> {
	const row = await db
		.prepare(
			`SELECT m.id, m.session_id AS sessionId, m.role, m.content FROM chat_messages m
			 JOIN chat_sessions s ON s.id = m.session_id
			 WHERE m.id = ? AND s.user_id = ?`
		)
		.bind(messageId, userId)
		.first<{ id: string; sessionId: string; role: Role; content: string }>();
	return row ?? null;
}

/** 메시지 행 존재 여부(세션 한정). 이미지 영속 전 assistant 행이 먼저 박혔는지 확인용. */
export async function messageExists(
	db: D1Database,
	messageId: string,
	sessionId: string
): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS x FROM chat_messages WHERE id = ? AND session_id = ?')
		.bind(messageId, sessionId)
		.first<{ x: number }>();
	return !!row;
}

/** 메시지 content/cost 제자리 갱신(seq·순서 보존). 이미지 재생성 시 같은 행을 덮어쓴다. */
export async function updateMessageContentCost(
	db: D1Database,
	messageId: string,
	content: string,
	cost?: number
): Promise<void> {
	await db
		.prepare('UPDATE chat_messages SET content = ?, token_est = ?, cost = ? WHERE id = ?')
		.bind(content, estimateTokens(content), cost ?? null, messageId)
		.run();
}

interface MessageRow {
	id: string;
	seq: number;
	role: Role;
	content: string;
	cost: number | null;
}

/**
 * 세션 메시지 한 페이지(렌더링용). before 가 있으면 그 seq '미만'에서 최신 limit 개를,
 * 없으면 세션 전체에서 최신 limit 개를 가져온다. 항상 seq 오름차순으로 반환.
 *  - oldestSeq: 이 페이지의 가장 오래된 seq(없으면 0). 다음 페이지 요청의 before 로 사용.
 *  - hasMore:   이 페이지 앞에 더 오래된 메시지가 남아있는지(seq 는 1-based 연속이라 oldest>1).
 */
export async function getMessagePage(
	db: D1Database,
	sessionId: string,
	limit: number,
	before?: number
): Promise<{ messages: StoredMessage[]; oldestSeq: number; hasMore: boolean }> {
	const beforeSeq = before && before > 0 ? before : Number.MAX_SAFE_INTEGER;
	const { results } = await db
		.prepare(
			`SELECT id, seq, role, content, cost FROM chat_messages
			 WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`
		)
		.bind(sessionId, beforeSeq, limit)
		.all<MessageRow>();
	const messages = (results ?? [])
		.map((r) => ({
			id: r.id,
			seq: r.seq,
			role: r.role,
			content: r.content,
			cost: r.cost ?? undefined
		}))
		.reverse(); // DESC 로 가져온 뒤 화면 표시용 오름차순으로 뒤집기
	const oldestSeq = messages.length > 0 ? messages[0].seq : 0;
	return { messages, oldestSeq, hasMore: oldestSeq > 1 };
}

/**
 * 새 세션 생성. opening(첫 상황 본문)이 있으면 seq=1 assistant 메시지로 함께 저장.
 * 반환: 생성된 세션.
 */
export async function createSession(
	db: D1Database,
	input: {
		userId: string;
		characterId: string;
		model: string | null;
		opening: string;
		/** 첫 대화 전에 미리 설정한 상시 기억(최대 100자). 없으면 null. */
		memory?: string | null;
		/** 캐릭터 기본 변수(import defaultVariables). 세션 변수 상태 초기 시딩. 없으면 null. */
		defaultVariables?: Record<string, string> | null;
	}
): Promise<ChatSession> {
	const now = Date.now();
	const id = crypto.randomUUID();
	const opening = input.opening.trim();
	const hasOpening = opening !== '';
	const count = hasOpening ? 1 : 0;
	const lastAt = hasOpening ? now : null;
	const memVal = ((input.memory ?? '').trim().slice(0, MAX_MEMORY_CHARS) || null) as string | null;
	const seedVars = input.defaultVariables ?? null;
	const scriptStateVal =
		seedVars && Object.keys(seedVars).length > 0 ? JSON.stringify(seedVars) : null;

	const stmts = [
		db
			.prepare(
				`INSERT INTO chat_sessions
				 (id, user_id, character_id, model, summary, summary_upto_seq, memory, script_state, message_count, created_at, updated_at, last_message_at)
				 VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`
			)
			.bind(id, input.userId, input.characterId, input.model, memVal, scriptStateVal, count, now, now, lastAt)
	];
	if (hasOpening) {
		stmts.push(
			db
				.prepare(
					`INSERT INTO chat_messages (id, session_id, seq, role, content, token_est, created_at)
					 VALUES (?, ?, 1, 'assistant', ?, ?, ?)`
				)
				.bind(crypto.randomUUID(), id, opening, estimateTokens(opening), now)
		);
	}
	await db.batch(stmts);

	return {
		id,
		userId: input.userId,
		characterId: input.characterId,
		model: input.model,
		summary: null,
		summaryUptoSeq: 0,
		memory: memVal,
		scriptState: seedVars && Object.keys(seedVars).length > 0 ? seedVars : null,
		appearances: null,
		outfits: null,
		messageCount: count,
		createdAt: now,
		updatedAt: now,
		lastMessageAt: lastAt
	};
}

/**
 * 메시지 1건 추가. 다음 seq 를 발급하고 세션 카운터/시각을 갱신한다.
 * model 을 같이 넘기면 세션의 "마지막 사용 모델"을 갱신(요약 시 사용)하고, 동시에 이 메시지
 * 행에도 어떤 모델로 보냈는지를 기록한다(메시지 단위 모델 — 세션 model 과 별개).
 * inputTokens 는 assistant 메시지에서, 그 응답에 들어간 input 토큰 수(실측/추정).
 * cost 는 assistant 메시지에서, 그 응답의 AI Gateway 추론 비용(USD, 실측). 없으면 미기록.
 * targetSentences 는 그 턴에 사용자가 출력 분량 슬라이더로 요청한 값(문장 수). assistant
 * 메시지에 그 응답에 기대된 분량을 남긴다(데이터셋용). 없으면 미기록.
 * id 를 넘기면 그 값을 메시지 PK 로 사용(클라가 생성한 id 와 DB id 를 일치시켜 삭제 등 동기화).
 * 없으면 서버가 생성.
 * 반환: 발급된 seq.
 */
export async function appendMessage(
	db: D1Database,
	sessionId: string,
	role: Role,
	content: string,
	model?: string,
	inputTokens?: number,
	cost?: number,
	id?: string,
	targetSentences?: number
): Promise<number> {
	const now = Date.now();
	// 단일 유저가 순차 전송하므로 read-then-write 경쟁 위험은 낮다.
	const cur = await db
		.prepare('SELECT message_count FROM chat_sessions WHERE id = ?')
		.bind(sessionId)
		.first<{ message_count: number }>();
	const seq = (cur?.message_count ?? 0) + 1;

	await db.batch([
		db
			.prepare(
				`INSERT INTO chat_messages (id, session_id, seq, role, content, token_est, input_tokens, cost, model, target_sentences, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id ?? crypto.randomUUID(),
				sessionId,
				seq,
				role,
				content,
				estimateTokens(content),
				inputTokens ?? null,
				cost ?? null,
				model ?? null,
				targetSentences ?? null,
				now
			),
		db
			.prepare(
				`UPDATE chat_sessions
				 SET message_count = ?, last_message_at = ?, updated_at = ?,
				     model = COALESCE(?, model)
				 WHERE id = ?`
			)
			.bind(seq, now, now, model ?? null, sessionId)
	]);
	return seq;
}

/** live window — 모델에 실제로 보낼 메시지(seq > summary_upto_seq). token_est 포함. */
export async function getWindow(
	db: D1Database,
	sessionId: string,
	summaryUptoSeq: number
): Promise<Array<StoredMessage & { tokenEst: number }>> {
	const { results } = await db
		.prepare(
			// image_generation 메시지는 모델에 보내지 않으므로 window 에서 제외(요약 transcript 도 동일).
			`SELECT id, seq, role, content, token_est FROM chat_messages
			 WHERE session_id = ? AND seq > ? AND role != 'image_generation' ORDER BY seq`
		)
		.bind(sessionId, summaryUptoSeq)
		.all<MessageRow & { token_est: number }>();
	return (results ?? []).map((r) => ({
		id: r.id,
		seq: r.seq,
		role: r.role,
		content: r.content,
		tokenEst: r.token_est
	}));
}

/**
 * 세션 변수 상태 갱신(CBS setvar 결과). 빈 맵이면 NULL 로 저장.
 * 턴 종료 후(waitUntil) 호출 — 매 턴 평가로 변이된 변수를 영속한다.
 */
export async function updateScriptState(
	db: D1Database,
	sessionId: string,
	state: Record<string, string>
): Promise<void> {
	const val = Object.keys(state).length > 0 ? JSON.stringify(state) : null;
	await db
		.prepare('UPDATE chat_sessions SET script_state = ?, updated_at = ? WHERE id = ?')
		.bind(val, Date.now(), sessionId)
		.run();
}

/**
 * 이미지 원장 갱신(실시간 이미지 생성 시) — 외형 원장·복장 원장을 한 번에. 빈 원장이면 NULL 로 저장.
 * NovelAI 호출 전 inline 으로 저장 — 빠른 재요청 레이스를 피하고 다음 턴 일관성을 보장한다.
 */
export async function updateImageLedgers(
	db: D1Database,
	sessionId: string,
	ledgers: { appearances: AppearanceLedger; outfits: OutfitLedger }
): Promise<void> {
	const a = Object.keys(ledgers.appearances).length > 0 ? JSON.stringify(ledgers.appearances) : null;
	const o = Object.keys(ledgers.outfits).length > 0 ? JSON.stringify(ledgers.outfits) : null;
	await db
		.prepare('UPDATE chat_sessions SET appearances = ?, outfits = ?, updated_at = ? WHERE id = ?')
		.bind(a, o, Date.now(), sessionId)
		.run();
}

/** 요약 갱신 — 새 summary 와 그것이 커버한 마지막 seq 를 저장(경계 전진). */
export async function updateSummary(
	db: D1Database,
	sessionId: string,
	summary: string,
	uptoSeq: number
): Promise<void> {
	await db
		.prepare(
			'UPDATE chat_sessions SET summary = ?, summary_upto_seq = ?, updated_at = ? WHERE id = ?'
		)
		.bind(summary, uptoSeq, Date.now(), sessionId)
		.run();
}

/**
 * 유저가 직접 요약 텍스트만 수정. 경계(summary_upto_seq)는 그대로 둔다.
 * 단, 빈 문자열로 지우면 summary=NULL + 경계 0 으로 리셋 →
 * 요약이 커버하던 과거 메시지가 다시 live window 로 돌아온다(맥락 유실 방지).
 * 반환: 저장된 요약(빈 입력은 null).
 */
export async function setSummaryText(
	db: D1Database,
	sessionId: string,
	summary: string
): Promise<string | null> {
	const text = summary.trim();
	if (text === '') {
		await db
			.prepare(
				'UPDATE chat_sessions SET summary = NULL, summary_upto_seq = 0, updated_at = ? WHERE id = ?'
			)
			.bind(Date.now(), sessionId)
			.run();
		return null;
	}
	await db
		.prepare('UPDATE chat_sessions SET summary = ?, updated_at = ? WHERE id = ?')
		.bind(text, Date.now(), sessionId)
		.run();
	return text;
}

/** 상시 기억 최대 길이(자). 클라/서버 공통 상한. */
export const MAX_MEMORY_CHARS = 100;

/**
 * 유저가 직접 넣는 "상시 기억" 저장. 앞뒤 공백 제거 후 MAX_MEMORY_CHARS 로 잘라 저장.
 * 빈 문자열이면 NULL 로 지운다. 반환: 저장된 값(없으면 null).
 */
export async function setMemoryText(
	db: D1Database,
	sessionId: string,
	memory: string
): Promise<string | null> {
	const text = memory.trim().slice(0, MAX_MEMORY_CHARS);
	await db
		.prepare('UPDATE chat_sessions SET memory = ?, updated_at = ? WHERE id = ?')
		.bind(text === '' ? null : text, Date.now(), sessionId)
		.run();
	return text === '' ? null : text;
}
