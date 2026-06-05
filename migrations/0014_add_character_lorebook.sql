-- Migration number: 0014 	 2026-06-06T00:00:00.000Z
-- 캐릭터 로어북(키워드로 켜지는 동적 설정). JSON blob.
-- 형태: { "entries": [ { "id": "<uuid>", "keys": ["키워드"], "content": "내용", "constant": false, "order": 0 } ] }
-- 채팅 시 최근 대화의 키워드를 스캔해 매칭 항목(+constant)만 프롬프트에 주입한다.

ALTER TABLE characters ADD COLUMN lorebook TEXT;
