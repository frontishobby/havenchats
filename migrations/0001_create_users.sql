-- Migration number: 0001 	 2026-06-03T09:45:05.142Z
-- 유저 + OAuth 계정 연결

CREATE TABLE users (
	id            TEXT PRIMARY KEY,           -- 내부 user id (uuid)
	email         TEXT UNIQUE,
	display_name  TEXT,
	avatar_url    TEXT,
	age_verified  INTEGER NOT NULL DEFAULT 0, -- 0/1, NSFW 게이트(추후)
	created_at    INTEGER NOT NULL,           -- epoch ms
	updated_at    INTEGER NOT NULL
);

CREATE TABLE oauth_accounts (
	provider          TEXT NOT NULL,          -- 'google'
	provider_user_id  TEXT NOT NULL,          -- 예: google 'sub'
	user_id           TEXT NOT NULL REFERENCES users(id),
	created_at        INTEGER NOT NULL,
	PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX idx_oauth_user ON oauth_accounts(user_id);
