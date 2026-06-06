-- 유저 차단: blocked_reason 이 NULL 이 아니면 차단된 유저로 판단.
-- 사유 텍스트를 그대로 보관(차단 모달에 노출).
ALTER TABLE users ADD COLUMN blocked_reason TEXT;
