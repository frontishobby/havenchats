-- Migration number: 0009 	 2026-06-04T00:00:00.000Z
-- 캐릭터 공개 범위. 'public'=메인 그리드·공개 프로필에 노출,
-- 'private'=제작자 본인 프로필("내 캐릭터")에서만 보임.
-- 기존 행은 모두 공개로 처리.

ALTER TABLE characters ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
