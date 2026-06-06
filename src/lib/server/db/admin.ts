/**
 * 관리자 대시보드 전용 집계 쿼리. (owner@example.com 전용 — 게이트는 라우트 layout 에서)
 *
 * 비용(cost)은 chat_messages.cost(REAL, USD, AI Gateway 실측)에 assistant 메시지 단위로 쌓인다.
 * 구버전/mock 폴백 메시지는 cost=NULL 이므로 SUM/AVG 에서 자연히 제외된다.
 * created_at 은 epoch ms. 일자 버킷팅은 KST(+9h) 기준.
 */

/** 유저 1행 + 사용량 집계. */
export interface AdminUserRow {
	id: string;
	email: string;
	name: string | null;
	createdAt: number;
	sessions: number;
	messages: number;
	costTotal: number;
	cost7d: number;
	lastActive: number | null;
}

/**
 * 전체 유저 + 사용량(세션/메시지 수, 누적 cost, 최근 7일 cost, 마지막 활동). 7일 cost 높은 순.
 * since7d = (now - 7일) epoch ms.
 */
export async function listUsersWithStats(
	db: D1Database,
	since7d: number
): Promise<AdminUserRow[]> {
	const { results } = await db
		.prepare(
			`SELECT u.id, u.email, u.display_name, u.created_at,
			        COUNT(DISTINCT s.id) AS sessions,
			        COUNT(m.id) AS messages,
			        COALESCE(SUM(m.cost), 0) AS cost_total,
			        COALESCE(SUM(CASE WHEN m.created_at >= ? THEN m.cost ELSE 0 END), 0) AS cost_7d,
			        MAX(s.last_message_at) AS last_active
			 FROM users u
			 LEFT JOIN chat_sessions s ON s.user_id = u.id
			 LEFT JOIN chat_messages m ON m.session_id = s.id
			 GROUP BY u.id
			 ORDER BY cost_7d DESC, u.created_at DESC`
		)
		.bind(since7d)
		.all<{
			id: string;
			email: string;
			display_name: string | null;
			created_at: number;
			sessions: number;
			messages: number;
			cost_total: number;
			cost_7d: number;
			last_active: number | null;
		}>();
	return (results ?? []).map((r) => ({
		id: r.id,
		email: r.email,
		name: r.display_name,
		createdAt: r.created_at,
		sessions: r.sessions,
		messages: r.messages,
		costTotal: r.cost_total,
		cost7d: r.cost_7d,
		lastActive: r.last_active
	}));
}

/** 전체 요약 카드용 집계. */
export interface AdminSummary {
	users: number;
	sessions: number;
	messages: number;
	costTotal: number;
	cost7d: number;
	active7d: number;
	active30d: number;
}

export async function getOverallSummary(
	db: D1Database,
	since7d: number,
	since30d: number
): Promise<AdminSummary> {
	const totals = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM users) AS users,
			   (SELECT COUNT(*) FROM chat_sessions) AS sessions,
			   (SELECT COUNT(*) FROM chat_messages) AS messages,
			   (SELECT COALESCE(SUM(cost), 0) FROM chat_messages) AS cost_total,
			   (SELECT COALESCE(SUM(cost), 0) FROM chat_messages WHERE created_at >= ?) AS cost_7d`
		)
		.bind(since7d)
		.first<{
			users: number;
			sessions: number;
			messages: number;
			cost_total: number;
			cost_7d: number;
		}>();

	const active = await db
		.prepare(
			`SELECT
			   COUNT(DISTINCT CASE WHEN m.created_at >= ? THEN s.user_id END) AS active_7d,
			   COUNT(DISTINCT CASE WHEN m.created_at >= ? THEN s.user_id END) AS active_30d
			 FROM chat_messages m
			 JOIN chat_sessions s ON s.id = m.session_id`
		)
		.bind(since7d, since30d)
		.first<{ active_7d: number; active_30d: number }>();

	return {
		users: totals?.users ?? 0,
		sessions: totals?.sessions ?? 0,
		messages: totals?.messages ?? 0,
		costTotal: totals?.cost_total ?? 0,
		cost7d: totals?.cost_7d ?? 0,
		active7d: active?.active_7d ?? 0,
		active30d: active?.active_30d ?? 0
	};
}

/** 일별 cost 추이 1행(KST 기준 날짜). */
export interface DailyCost {
	day: string; // 'YYYY-MM-DD' (KST)
	cost: number;
	messages: number;
}

/** 최근 N일 일별 cost/메시지 수(KST). since = (now - N일) epoch ms. */
export async function getDailyCost(db: D1Database, since: number): Promise<DailyCost[]> {
	const { results } = await db
		.prepare(
			`SELECT date(created_at / 1000, 'unixepoch', '+9 hours') AS day,
			        COALESCE(SUM(cost), 0) AS cost,
			        COUNT(*) AS messages
			 FROM chat_messages
			 WHERE created_at >= ?
			 GROUP BY day
			 ORDER BY day`
		)
		.bind(since)
		.all<{ day: string; cost: number; messages: number }>();
	return (results ?? []).map((r) => ({ day: r.day, cost: r.cost, messages: r.messages }));
}

/** 모델별 cost/토큰 통계 1행. */
export interface ModelStat {
	model: string | null;
	messages: number;
	costSum: number;
	costAvg: number | null;
	costMin: number | null;
	costMax: number | null;
	inTokSum: number;
	inTokAvg: number | null;
}

/**
 * 모델별 통계. cost 가 기록된 assistant 메시지만 대상(NULL 제외).
 * model 이 NULL 인 구버전 행은 별도 그룹(model=null)으로 묶인다.
 */
export async function getModelStats(db: D1Database): Promise<ModelStat[]> {
	const { results } = await db
		.prepare(
			`SELECT model,
			        COUNT(*) AS messages,
			        COALESCE(SUM(cost), 0) AS cost_sum,
			        AVG(cost) AS cost_avg,
			        MIN(cost) AS cost_min,
			        MAX(cost) AS cost_max,
			        COALESCE(SUM(input_tokens), 0) AS in_tok_sum,
			        AVG(input_tokens) AS in_tok_avg
			 FROM chat_messages
			 WHERE role = 'assistant' AND cost IS NOT NULL
			 GROUP BY model
			 ORDER BY cost_sum DESC`
		)
		.all<{
			model: string | null;
			messages: number;
			cost_sum: number;
			cost_avg: number | null;
			cost_min: number | null;
			cost_max: number | null;
			in_tok_sum: number;
			in_tok_avg: number | null;
		}>();
	return (results ?? []).map((r) => ({
		model: r.model,
		messages: r.messages,
		costSum: r.cost_sum,
		costAvg: r.cost_avg,
		costMin: r.cost_min,
		costMax: r.cost_max,
		inTokSum: r.in_tok_sum,
		inTokAvg: r.in_tok_avg
	}));
}

/** 관리자 유저 상세 — 전체 프로필. */
export interface AdminUserDetail {
	id: string;
	email: string;
	name: string | null;
	persona: string | null;
	preference: string | null;
	ageVerified: boolean;
	createdAt: number;
	updatedAt: number;
}

export async function getUserDetail(db: D1Database, id: string): Promise<AdminUserDetail | null> {
	const row = await db
		.prepare(
			`SELECT id, email, display_name, persona, preference, age_verified, created_at, updated_at
			 FROM users WHERE id = ?`
		)
		.bind(id)
		.first<{
			id: string;
			email: string;
			display_name: string | null;
			persona: string | null;
			preference: string | null;
			age_verified: number;
			created_at: number;
			updated_at: number;
		}>();
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		name: row.display_name,
		persona: row.persona,
		preference: row.preference,
		ageVerified: row.age_verified === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

/** 한 유저의 사용량 집계(상세 페이지 헤더용). */
export interface UserStats {
	sessions: number;
	messages: number;
	costTotal: number;
	cost7d: number;
	lastActive: number | null;
}

export async function getUserStats(
	db: D1Database,
	userId: string,
	since7d: number
): Promise<UserStats> {
	const row = await db
		.prepare(
			`SELECT COUNT(DISTINCT s.id) AS sessions,
			        COUNT(m.id) AS messages,
			        COALESCE(SUM(m.cost), 0) AS cost_total,
			        COALESCE(SUM(CASE WHEN m.created_at >= ? THEN m.cost ELSE 0 END), 0) AS cost_7d,
			        MAX(s.last_message_at) AS last_active
			 FROM chat_sessions s
			 LEFT JOIN chat_messages m ON m.session_id = s.id
			 WHERE s.user_id = ?`
		)
		.bind(since7d, userId)
		.first<{
			sessions: number;
			messages: number;
			cost_total: number;
			cost_7d: number;
			last_active: number | null;
		}>();
	return {
		sessions: row?.sessions ?? 0,
		messages: row?.messages ?? 0,
		costTotal: row?.cost_total ?? 0,
		cost7d: row?.cost_7d ?? 0,
		lastActive: row?.last_active ?? null
	};
}

/**
 * 관리자용 캐릭터 1행 — 공개/비공개/imported 무관 전부, 원본 프롬프트(description) 포함.
 * (일반 조회 rowToCharacter 는 imported 의 description 을 가리지만 여기선 그대로 노출.)
 */
export interface AdminCharacter {
	id: string;
	name: string;
	tagline: string;
	intro: string;
	description: string; // 시스템 프롬프트 본문(원본)
	visibility: 'public' | 'private';
	contentRating: 'sfw' | 'nsfw';
	imported: boolean;
	openings: { name: string; content: string }[];
	chats: number;
	createdAt: number;
}

/** greetings JSON → Opening[] 안전 파싱(구버전 string[] 호환). */
function parseOpenings(json: string): { name: string; content: string }[] {
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		const out: { name: string; content: string }[] = [];
		for (const o of parsed) {
			if (typeof o === 'string') out.push({ name: '', content: o });
			else if (o && typeof o.content === 'string')
				out.push({ name: typeof o.name === 'string' ? o.name : '', content: o.content });
		}
		return out;
	} catch {
		return [];
	}
}

/** 한 유저가 만든 모든 캐릭터(공개+비공개+imported), 원본 프롬프트 포함. 최신순. */
export async function listCharactersForAdmin(
	db: D1Database,
	creatorId: string
): Promise<AdminCharacter[]> {
	const { results } = await db
		.prepare(
			`SELECT c.id, c.name, c.tagline, c.intro, c.description, c.visibility, c.content_rating,
			        c.imported, c.greetings, c.created_at,
			        (SELECT COUNT(*) FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
			           WHERE s.character_id = c.id) AS chats
			 FROM characters c
			 WHERE c.creator_id = ?
			 ORDER BY c.created_at DESC`
		)
		.bind(creatorId)
		.all<{
			id: string;
			name: string;
			tagline: string;
			intro: string;
			description: string;
			visibility: string;
			content_rating: string;
			imported: number;
			greetings: string;
			created_at: number;
			chats: number;
		}>();
	return (results ?? []).map((r) => ({
		id: r.id,
		name: r.name,
		tagline: r.tagline,
		intro: r.intro,
		description: r.description,
		visibility: r.visibility === 'private' ? 'private' : 'public',
		contentRating: r.content_rating === 'nsfw' ? 'nsfw' : 'sfw',
		imported: r.imported === 1,
		openings: parseOpenings(r.greetings),
		chats: r.chats,
		createdAt: r.created_at
	}));
}

/** 캐릭터별 사용량 1행. */
export interface CharacterStat {
	characterId: string;
	name: string | null; // characters 테이블에 없으면(삭제/빌트인) null
	creatorId: string | null;
	sessions: number;
	messages: number;
	cost: number;
}

/** 캐릭터별 사용량 top N(cost 높은 순). 삭제된 캐릭터는 name=null. */
export async function getCharacterStats(db: D1Database, limit = 20): Promise<CharacterStat[]> {
	const { results } = await db
		.prepare(
			`SELECT s.character_id,
			        c.name AS name,
			        c.creator_id AS creator_id,
			        COUNT(DISTINCT s.id) AS sessions,
			        COUNT(m.id) AS messages,
			        COALESCE(SUM(m.cost), 0) AS cost
			 FROM chat_sessions s
			 LEFT JOIN chat_messages m ON m.session_id = s.id
			 LEFT JOIN characters c ON c.id = s.character_id
			 GROUP BY s.character_id
			 ORDER BY cost DESC, messages DESC
			 LIMIT ?`
		)
		.bind(limit)
		.all<{
			character_id: string;
			name: string | null;
			creator_id: string | null;
			sessions: number;
			messages: number;
			cost: number;
		}>();
	return (results ?? []).map((r) => ({
		characterId: r.character_id,
		name: r.name,
		creatorId: r.creator_id,
		sessions: r.sessions,
		messages: r.messages,
		cost: r.cost
	}));
}
