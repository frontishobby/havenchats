-- Migration number: 0015 	 2026-06-06T00:00:00.000Z
-- 변수 엔진: 세션별 변수 상태 + 캐릭터 스크립트 데이터(기본 변수 등).
-- script_state: chat_sessions 의 세션 변수 맵 JSON ( {"호감도":"50"} ). CBS getvar/setvar 가 읽고 쓴다.
-- script_data: characters 의 스크립트 설정 JSON ( {"defaultVariables":{...}} ). 3·4순위에서 triggers/regex 확장.

ALTER TABLE chat_sessions ADD COLUMN script_state TEXT;
ALTER TABLE characters ADD COLUMN script_data TEXT;
