import type { SessionIdentity } from '$lib/server/auth';

export interface OAuthProfile {
	provider: string; // 'google'
	providerUserId: string; // google 'sub'
	email: string;
}

export type Preference = 'male' | 'female';

export interface UserProfile {
	id: string;
	email: string;
	name: string | null; // display_name (대화용 이름)
	persona: string | null;
	preference: Preference | null;
	profileComplete: boolean; // display_name 설정 여부
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
		.prepare('SELECT id, email, display_name, persona, preference FROM users WHERE id = ?')
		.bind(id)
		.first<{
			id: string;
			email: string;
			display_name: string | null;
			persona: string | null;
			preference: string | null;
		}>();

	if (!row) return null;

	const pref = row.preference === 'male' || row.preference === 'female' ? row.preference : null;
	return {
		id: row.id,
		email: row.email,
		name: row.display_name,
		persona: row.persona,
		preference: pref,
		profileComplete: !!row.display_name && row.display_name.trim() !== ''
	};
}

/** 프로필 모달 저장. */
export async function updateProfile(
	db: D1Database,
	id: string,
	data: { name: string; persona: string | null; preference: Preference | null }
): Promise<void> {
	await db
		.prepare('UPDATE users SET display_name = ?, persona = ?, preference = ?, updated_at = ? WHERE id = ?')
		.bind(data.name, data.persona, data.preference, Date.now(), id)
		.run();
}
