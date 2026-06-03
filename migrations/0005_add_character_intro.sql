-- Migration number: 0005 	 2026-06-03T00:00:02.000Z
-- 설명(intro): 상세 모달 표시 전용 소개글. 시스템 프롬프트에는 포함되지 않는다.

ALTER TABLE characters ADD COLUMN intro TEXT NOT NULL DEFAULT '';
