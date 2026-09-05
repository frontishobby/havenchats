-- Migration number: 0025 	 2026-09-06T00:00:00.000Z
-- 세션별 "복장 원장(outfit ledger)": 실시간 이미지 생성 시 인물별 복장/노출 상태를 턴 간 유지한다.
-- 상황 프롬프트 LLM 은 최근 3턴만 보므로, 옷을 벗은 장면이 창 밖으로 밀리면 description 의 기본 복장으로
-- 되돌아가 "벗었는데 입은 그림"이 나오던 문제 → 매 턴 LLM 출력의 outfit 을 name 별로 저장하고
-- 다음 턴 [Current outfits] 로 주입해 "텍스트가 바꾸지 않으면 그대로 복사"하게 한다.
-- appearances(고정 외형)와 달리 주인공(char)·유저(user)도 포함한다(복장은 이들이 제일 중요).
-- 형식: JSON { "<정규화 name>": { "outfit": "<danbooru 태그>", "lastSeen": <turnRef> } }.
ALTER TABLE chat_sessions ADD COLUMN outfits TEXT;
