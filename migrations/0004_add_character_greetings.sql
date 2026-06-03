-- Migration number: 0004 	 2026-06-03T00:00:01.000Z
-- 첫 상황(오프닝) 목록. JSON 배열, 최소 1개. 각 항목이 채팅 시작 시 첫 메시지가 된다.

ALTER TABLE characters ADD COLUMN greetings TEXT NOT NULL DEFAULT '[]';
