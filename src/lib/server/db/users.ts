import type { SessionIdentity } from '$lib/server/auth';
import type { Country } from '$lib/types';
import { withVersion } from '$lib/imageCodes';

export interface OAuthProfile {
	provider: string; // 'google'
	providerUserId: string; // google 'sub'
	email: string;
}

export type Preference = 'male' | 'female';

export interface UserProfile {
	id: string;
	email: string;
	name: string | null; // display_name (남에게 노출되는 이름)
	personaName: string | null; // 채팅에서 AI 가 부르는 이름(선택). 비면 채팅은 name 으로 폴백
	avatarUrl: string | null; // 프로필 사진(servable URL) — 없으면 null
	persona: string | null;
	preference: Preference | null;
	country: Country | null; // NSFW 노출 게이트(PY 만 노출). 미선택이면 null → SFW 만
	profileComplete: boolean; // display_name 설정 여부
	blockedReason: string | null; // null 이 아니면 차단된 유저
}

/** 다른 유저에게 공개되는 최소 프로필(유저 페이지 헤더용). */
export interface PublicProfile {
	id: string;
	name: string | null;
	avatarUrl: string | null;
}

/** avatar_url 컬럼에는 R2 오브젝트 키를 저장한다. servable URL 로 변환. version 은 캐시 버스팅. */
function avatarUrlFromKey(key: string | null, version?: number | null): string | null {
	return key ? withVersion(`/img/${key}`, version) : null;
}

/**
 * OAuth 로그인 → 기존 유저 조회, 없으면 신규 생성. 신원({id,email})만 반환.
 * Google 에서는 id(sub)·email 만 받고, 이름/사진 등은 저장하지 않는다(프로필 모달에서 직접 입력).
 */
export async function findOrCreateOAuthUser(
	db: D1Database,
	profile: OAuthProfile
): Promise<SessionIdentity> {
	const now = Date.now();

	const link = await db
		.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?')
		.bind(profile.provider, profile.providerUserId)
		.first<{ user_id: string }>();

	if (link) {
		await db
			.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?')
			.bind(profile.email, now, link.user_id)
			.run();
		return { id: link.user_id, email: profile.email };
	}

	const userId = crypto.randomUUID();
	await db.batch([
		db
			.prepare(
				'INSERT INTO users (id, email, display_name, avatar_url, age_verified, created_at, updated_at) VALUES (?, ?, NULL, NULL, 0, ?, ?)'
			)
			.bind(userId, profile.email, now, now),
		db
			.prepare(
				'INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)'
			)
			.bind(profile.provider, profile.providerUserId, userId, now)
	]);

	return { id: userId, email: profile.email };
}

/** 세션 신원으로 전체 프로필 로드. (hooks 에서 매 요청 사용) */
export async function getUserProfile(db: D1Database, id: string): Promise<UserProfile | null> {
	const row = await db
		.prepare(
			'SELECT id, email, display_name, persona_name, avatar_url, persona, preference, country, blocked_reason, updated_at FROM users WHERE id = ?'
		)
		.bind(id)
		.first<{
			id: string;
			email: string;
			display_name: string | null;
			persona_name: string | null;
			avatar_url: string | null;
			persona: string | null;
			preference: string | null;
			country: string | null;
			blocked_reason: string | null;
			updated_at: number;
		}>();

	if (!row) return null;

	const pref = row.preference === 'male' || row.preference === 'female' ? row.preference : null;
	const country = row.country === 'KR' || row.country === 'PY' ? row.country : null;
	return {
		id: row.id,
		email: row.email,
		name: row.display_name,
		personaName: row.persona_name,
		avatarUrl: avatarUrlFromKey(row.avatar_url, row.updated_at),
		persona: row.persona,
		preference: pref,
		country,
		profileComplete: !!row.display_name && row.display_name.trim() !== '',
		blockedReason: row.blocked_reason
	};
}

/**
 * 유저 차단/해제(관리자 전용). reason 이 비면 차단 해제(NULL), 아니면 그 사유로 차단.
 * 반환: 저장된 사유(해제면 null).
 */
export async function setBlockedReason(
	db: D1Database,
	id: string,
	reason: string | null
): Promise<string | null> {
	const text = reason?.trim() ? reason.trim().slice(0, 500) : null;
	await db
		.prepare('UPDATE users SET blocked_reason = ?, updated_at = ? WHERE id = ?')
		.bind(text, Date.now(), id)
		.run();
	return text;
}

/** 프로필 국가만 갱신(드롭다운 NSFW 토글용). PY 전환의 코드 검증은 호출부(엔드포인트) 책임. */
export async function updateCountry(db: D1Database, id: string, country: Country): Promise<void> {
	await db
		.prepare('UPDATE users SET country = ?, updated_at = ? WHERE id = ?')
		.bind(country, Date.now(), id)
		.run();
}

/** 유저 페이지 헤더용 공개 프로필. 없으면 null. */
export async function getPublicProfile(db: D1Database, id: string): Promise<PublicProfile | null> {
	const row = await db
		.prepare('SELECT id, display_name, avatar_url, updated_at FROM users WHERE id = ?')
		.bind(id)
		.first<{ id: string; display_name: string | null; avatar_url: string | null; updated_at: number }>();
	if (!row) return null;
	return { id: row.id, name: row.display_name, avatarUrl: avatarUrlFromKey(row.avatar_url, row.updated_at) };
}

/** 프로필 사진 R2 키 갱신. 기존 키(있으면) 반환 → 호출부가 옛 오브젝트 정리. */
export async function updateAvatarKey(
	db: D1Database,
	id: string,
	key: string
): Promise<string | null> {
	const prev = await db
		.prepare('SELECT avatar_url FROM users WHERE id = ?')
		.bind(id)
		.first<{ avatar_url: string | null }>();
	await db
		.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
		.bind(key, Date.now(), id)
		.run();
	return prev?.avatar_url ?? null;
}

/**
 * 프로필 모달 저장 (upsert).
 * 세션은 서명 쿠키로 검증되지만 해당 유저 row 가 없을 수 있어(예: 로컬 D1 초기화 후 stale 쿠키)
 * UPDATE 만 하면 0건 수정으로 조용히 누락된다. id 충돌 시 갱신하는 upsert 로 self-heal 한다.
 */
export async function updateProfile(
	db: D1Database,
	id: string,
	email: string,
	data: {
		name: string;
		personaName: string | null;
		persona: string | null;
		preference: Preference | null;
		country: Country | null;
	}
): Promise<void> {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO users (id, email, display_name, persona_name, persona, preference, country, age_verified, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   display_name = excluded.display_name,
			   persona_name = excluded.persona_name,
			   persona = excluded.persona,
			   preference = excluded.preference,
			   country = excluded.country,
			   updated_at = excluded.updated_at`
		)
		.bind(id, email, data.name, data.personaName, data.persona, data.preference, data.country, now, now)
		.run();
}
