-- Migration number: 0013 	 2026-06-05T00:00:00.000Z
-- charx(캐릭터 카드 V3) import 으로 만들어진 캐릭터 표시.
-- imported=1 이면:
--  - 시스템 프롬프트(description)를 클라이언트에 절대 노출하지 않음(서버 조립 시에만 사용)
--  - 영구 비공개(공개 불가)·수정 불가. (장면 이미지는 기기 한정 → 기기간 공유로 R2 전환만 가능)
-- 일반 제작 캐릭터는 0.

ALTER TABLE characters ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
