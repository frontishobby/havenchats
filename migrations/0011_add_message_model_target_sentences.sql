-- Migration number: 0011 	 2026-06-04T00:00:00.000Z
-- 턴별 모델 + 요청 분량 기록. (학습/평가 데이터셋 빌드용)
--  - model:            이 메시지를 보낼 때 실제로 사용한 모델 ID. 세션의 model(마지막 사용)은
--                      그대로 두고, 메시지 단위로 어떤 모델로 보냈는지를 별도 기록한다.
--  - target_sentences: 그 턴에 사용자가 출력 분량 슬라이더로 요청한 값(문장 수, maxSentences).
--                      assistant 메시지 행에 그 응답에 기대된 분량을 남긴다.
-- 둘 다 과거 행은 기록된 적이 없으므로 NULL(backfill 없음), 이후 전송분부터 채운다.

ALTER TABLE chat_messages ADD COLUMN model TEXT;
ALTER TABLE chat_messages ADD COLUMN target_sentences INTEGER;
