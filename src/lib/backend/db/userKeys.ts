/**
 * 외부 서비스 API 키 보관(user_keys 테이블). 정적(1인·브라우저) 런타임이라 본인 기기의 로컬 DB 에
 * 평문으로 저장한다(컬럼명 ciphertext 는 과거 AES-GCM 시절 이름 유지).
 * provider: 'novelai'(이미지 생성), 'gateway'(Vercel AI Gateway — 챗/상황프롬프트 LLM).
 */

export type KeyProvider = 'novelai' | 'gateway' | 'bridge';

/** 등록 시점 검증 스냅샷(NovelAI: { tier, active, isOpus }). UI 표시·재검증 생략용. */
export type StoredKeyMeta = Record<string, unknown>;

interface KeyRow {
	ciphertext: string;
	meta: string | null;
	updated_at: number;
}

/** 등록 여부·메타만(평문 미복호화). UI 상태 표시용. */
export async function getKeyStatus(
	db: D1Database,
	userId: string,
	provider: KeyProvider
): Promise<{ registered: boolean; meta: StoredKeyMeta | null; updatedAt: number | null }> {
	const row = await db
		.prepare('SELECT ciphertext, meta, updated_at FROM user_keys WHERE user_id = ? AND provider = ?')
		.bind(userId, provider)
		.first<KeyRow>();
	if (!row) return { registered: false, meta: null, updatedAt: null };
	let meta: StoredKeyMeta | null = null;
	if (row.meta) {
		try {
			meta = JSON.parse(row.meta) as StoredKeyMeta;
		} catch {
			meta = null;
		}
	}
	return { registered: true, meta, updatedAt: row.updated_at };
}

/** 평문 키 복호화(없으면 null). 이미지 생성 등 실제 사용 시점에만 호출. */
export async function getDecryptedKey(
	db: D1Database,
	userId: string,
	provider: KeyProvider
): Promise<string | null> {
	const row = await db
		.prepare('SELECT ciphertext FROM user_keys WHERE user_id = ? AND provider = ?')
		.bind(userId, provider)
		.first<{ ciphertext: string }>();
	if (!row) return null;
	return row.ciphertext || null;
}

/** 키 등록/교체(upsert). 평문을 암호화해 저장. meta 는 검증 스냅샷. */
export async function setKey(
	db: D1Database,
	userId: string,
	provider: KeyProvider,
	plaintext: string,
	meta: object | null
): Promise<void> {
	const ciphertext = plaintext;
	const now = Date.now();
	const metaJson = meta ? JSON.stringify(meta) : null;
	await db
		.prepare(
			`INSERT INTO user_keys (user_id, provider, ciphertext, meta, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, provider)
			 DO UPDATE SET ciphertext = excluded.ciphertext, meta = excluded.meta, updated_at = excluded.updated_at`
		)
		.bind(userId, provider, ciphertext, metaJson, now, now)
		.run();
}

/** 키 삭제. */
export async function deleteKey(
	db: D1Database,
	userId: string,
	provider: KeyProvider
): Promise<void> {
	await db
		.prepare('DELETE FROM user_keys WHERE user_id = ? AND provider = ?')
		.bind(userId, provider)
		.run();
}
