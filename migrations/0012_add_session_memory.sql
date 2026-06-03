-- 세션별 "상시 기억": 유저가 직접 넣는 짧은 메모(최대 100자).
-- 존재 시 system 프롬프트와 대화 history 사이에 주입된다.
ALTER TABLE chat_sessions ADD COLUMN memory TEXT;
