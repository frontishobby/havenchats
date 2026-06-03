-- Migration number: 0008 	 2026-06-03T00:00:00.000Z
-- 장면 이미지 세트(축×조합). JSON blob 으로 보관(tags/greetings 와 동일 패턴).
-- 형태: { "axes": [{ "label": "표정", "values": ["평온","화남"] }, ...],
--        "entries": [{ "id": "<uuid>", "combo": [0,0,1], "ext": "webp" }, ...] }
-- 이미지 본체는 R2(IMAGES): charimg/<characterId>/<entryId>.<ext>
-- 없으면 NULL.

ALTER TABLE characters ADD COLUMN image_set TEXT;
