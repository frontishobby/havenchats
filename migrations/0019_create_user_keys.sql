-- Migration number: 0019 	 2026-06-06T00:00:00.000Z
-- 외부 서비스 API 키(현재 NovelAI) 보관. 값은 서버에서 AES-GCM 양방향 암호화해 저장한다.
-- 복호화 키는 서버 시크릿(USER_KEYS_SECRET / 폴백 AUTH_SECRET)에서만 파생 → DB 유출만으론 평문 불가.
-- meta 는 등록 시점 검증 스냅샷(JSON: { tier, active, ... }) — UI 표시·재검증 생략용.

CREATE TABLE user_keys (
	user_id    TEXT NOT NULL REFERENCES users(id),
	provider   TEXT NOT NULL,             -- 'novelai'
	ciphertext TEXT NOT NULL,             -- base64url(iv(12) || AES-GCM ciphertext)
	meta       TEXT,                      -- JSON 검증 스냅샷(등급 등). 없으면 NULL
	created_at INTEGER NOT NULL,          -- epoch ms
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, provider)
);
