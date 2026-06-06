-- Migration number: 0020 	 2026-06-07T00:00:00.000Z
-- 그림체 Hub: 유저가 만든 화풍(스타일) 프롬프트를 공유·즐겨찾기하고, 채팅 이미지 생성에 적용.
-- 그림체 = 화풍 프롬프트(아티스트/화풍 태그). 채팅 시 자동 상황 프롬프트 + 고정 퀄리티/네거티브와 합쳐진다.
-- 썸네일은 일관성을 위해 고정 표준 장면(SFW)으로 생성해 R2(style/<id>.<ext>)에 저장.

CREATE TABLE art_styles (
	id            TEXT PRIMARY KEY,            -- uuid
	creator_id    TEXT NOT NULL REFERENCES users(id),
	title         TEXT NOT NULL,
	memo          TEXT,                        -- 설명/메모(선택)
	prompt        TEXT NOT NULL,               -- 화풍(스타일) 프롬프트 본문
	thumbnail_key TEXT,                        -- R2 키(style/<id>.<ext>). 없으면 NULL
	created_at    INTEGER NOT NULL,            -- epoch ms
	updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_art_styles_creator ON art_styles(creator_id, created_at DESC);
CREATE INDEX idx_art_styles_created ON art_styles(created_at DESC);

-- 즐겨찾기(유저↔그림체). 채팅에서 고를 수 있는 후보가 된다.
CREATE TABLE art_style_favorites (
	user_id    TEXT NOT NULL,
	style_id   TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, style_id)
);
CREATE INDEX idx_asf_user ON art_style_favorites(user_id, created_at DESC);

-- 캐릭터 제작자가 지정하는 '추천 그림체'. 이 캐릭터로 채팅 시 이미지 모달에 추천으로 노출.
ALTER TABLE characters ADD COLUMN recommended_style_id TEXT;
