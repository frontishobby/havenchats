-- Migration number: 0027 	 2026-09-06T12:00:00.000Z
-- 모듈 Hub: 재사용 가능한 일반 프롬프트(출력 규칙 추가 등)를 만들어 공유·즐겨찾기하고,
-- 채팅에서 여러 개를 골라 켜면 매 턴 프롬프트 **가장 마지막**([응답 지침] 뒤)에 순서대로 첨부된다.
-- 캐릭터·유저에 종속되지 않는 범용 텍스트라 썸네일·모델 같은 부가 컬럼은 없다.

CREATE TABLE prompt_modules (
	id         TEXT PRIMARY KEY,                     -- uuid
	creator_id TEXT NOT NULL REFERENCES users(id),
	title      TEXT NOT NULL,
	memo       TEXT,                                 -- 설명/메모(선택, Hub 카드·상세 표시용. 프롬프트엔 미포함)
	prompt     TEXT NOT NULL,                        -- 모듈 본문(프롬프트 끝에 첨부되는 텍스트)
	shared     INTEGER NOT NULL DEFAULT 1,           -- 1=Hub 공개, 0=비공개(본인 채팅 전용)
	created_at INTEGER NOT NULL,                     -- epoch ms
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_prompt_modules_creator ON prompt_modules(creator_id, created_at DESC);
CREATE INDEX idx_prompt_modules_created ON prompt_modules(created_at DESC);

-- 즐겨찾기(유저↔모듈). 채팅 모듈 모달에서 켤 수 있는 후보(내가 만든 것 + 즐겨찾기).
CREATE TABLE prompt_module_favorites (
	user_id    TEXT NOT NULL,
	module_id  TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, module_id)
);
CREATE INDEX idx_pmf_user ON prompt_module_favorites(user_id, created_at DESC);
