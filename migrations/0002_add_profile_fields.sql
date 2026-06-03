-- Migration number: 0002 	 2026-06-03T09:54:09.658Z
-- 프로필: 대화용 이름(display_name, 이미 존재) + 페르소나 + 선호(남성향/여성향)

ALTER TABLE users ADD COLUMN persona TEXT;
ALTER TABLE users ADD COLUMN preference TEXT; -- 'male' | 'female'
