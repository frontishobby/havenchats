-- Migration number: 0021 	 2026-06-07T01:00:00.000Z
-- 그림체 '저장(비공개, 본인 채팅 전용)' vs '공유(Hub 공개)' 구분.
-- shared=1 만 Hub 목록에 노출. 기존 행은 모두 공유로 만들어졌으므로 기본 1.

ALTER TABLE art_styles ADD COLUMN shared INTEGER NOT NULL DEFAULT 1;
