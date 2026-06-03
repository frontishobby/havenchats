-- Migration number: 0003 	 2026-06-03T00:00:00.000Z
-- 유저 제작 캐릭터. 빌트인(목) 캐릭터는 코드(src/lib/data/characters.ts)에 남고,
-- 여기에는 /create 로 등록된 유저 캐릭터만 저장된다.

CREATE TABLE characters (
	id             TEXT PRIMARY KEY,            -- uuid (URL: /chat/<id>)
	creator_id     TEXT NOT NULL REFERENCES users(id),
	name           TEXT NOT NULL,               -- 제목 (~15자)
	tagline        TEXT NOT NULL,               -- 소개 (~100자)
	description    TEXT NOT NULL,               -- 프롬프트 (~6000자) = 시스템 프롬프트 본문
	thumbnail_key  TEXT,                        -- R2 오브젝트 키 (char/<id>.<ext>), 없으면 폴백 아바타
	audience       TEXT NOT NULL DEFAULT 'all', -- 'all'(공통) | 'male'(남성향) | 'female'(여성향)
	content_rating TEXT NOT NULL DEFAULT 'sfw', -- 'sfw' | 'nsfw'(연령제한)
	tags           TEXT NOT NULL DEFAULT '[]',  -- JSON 배열 (최대 5개)
	chats          INTEGER NOT NULL DEFAULT 0,  -- 누적 대화 수(인기도)
	created_at     INTEGER NOT NULL,            -- epoch ms
	updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_characters_creator ON characters(creator_id);
CREATE INDEX idx_characters_created ON characters(created_at DESC);
