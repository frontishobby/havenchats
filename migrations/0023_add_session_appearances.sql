-- Migration number: 0023 	 2026-06-08T00:00:00.000Z
-- 세션별 "외형 원장(appearance ledger)": 실시간 이미지 생성 시 동적 NPC 의 외형을 고정한다.
-- 캐릭터 description 에 없는(스토리 중 즉석 등장한) 인물은 매 턴 외형이 바뀌는 문제 →
-- 상황 프롬프트 LLM 이 인물별 name/appearance/state 로 분해 → name 으로 원장 대조해
-- 첫 등장 시 외형을 박고(pin), 이후엔 원장 값으로 강제 고정한다.
-- 형식: JSON { "<정규화 name>": { "appearance": "<danbooru 태그>", "lastSeen": <turnRef> } }.
-- memory / script_state 와 같은 세션 상태 JSON 컬럼 패턴.
ALTER TABLE chat_sessions ADD COLUMN appearances TEXT;
