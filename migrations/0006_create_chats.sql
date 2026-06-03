-- Migration number: 0006 	 2026-06-03T00:00:00.000Z
-- 대화 영속화: 세션 + 메시지.
-- 토큰 전략: ① sliding window(seq > summary_upto_seq 만 모델에 전송)
--            ② rolling summary(summary 컬럼에 누적, 임계치마다 백그라운드 갱신)
-- 캐릭터 데이터는 스냅샷하지 않는다 — characters 테이블(빌트인은 코드)이 source of truth.
-- 단 오프닝(greeting)은 세션 시작 시점 본문을 seq=1 메시지로 저장(세션별 앵커).

CREATE TABLE chat_sessions (
	id               TEXT PRIMARY KEY,            -- uuid (URL: /chat/<charId>?s=<id>)
	user_id          TEXT NOT NULL REFERENCES users(id),
	character_id     TEXT NOT NULL,               -- 빌트인 slug + 유저캐릭 uuid 혼재 → FK 미설정
	model            TEXT,                        -- 마지막 사용 모델(요약도 이 모델로 수행)
	summary          TEXT,                        -- rolling summary. NULL = 아직 요약 없음
	summary_upto_seq INTEGER NOT NULL DEFAULT 0,  -- 요약이 커버한 마지막 seq. 이보다 큰 seq 만 live window
	message_count    INTEGER NOT NULL DEFAULT 0,  -- 발급된 마지막 seq(= 다음 seq 계산용)
	created_at       INTEGER NOT NULL,            -- epoch ms
	updated_at       INTEGER NOT NULL,
	last_message_at  INTEGER                      -- 목록 정렬용(최근 대화 우선)
);

-- 캐릭터당 여러 세션 → unique 제약 없음. 최근 세션 조회/목록용 인덱스.
CREATE INDEX idx_sessions_user_char ON chat_sessions(user_id, character_id, last_message_at DESC);

CREATE TABLE chat_messages (
	id          TEXT PRIMARY KEY,                 -- uuid
	session_id  TEXT NOT NULL REFERENCES chat_sessions(id),
	seq         INTEGER NOT NULL,                 -- 세션 내 1-based 순번(정렬·window 슬라이싱)
	role        TEXT NOT NULL,                    -- 'user' | 'assistant'
	content     TEXT NOT NULL,
	token_est   INTEGER NOT NULL DEFAULT 0,       -- window 예산 계산용 토큰 추정 캐시
	created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_messages_session_seq ON chat_messages(session_id, seq);
