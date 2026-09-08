-- Migration number: 0028 	 2026-09-08
-- 캐릭터 상세용 고해상도 이미지(2048x2048, 저장 시 업스케일). thumbnail_key(1024)는 카드용.
ALTER TABLE characters ADD COLUMN full_image_key TEXT;
