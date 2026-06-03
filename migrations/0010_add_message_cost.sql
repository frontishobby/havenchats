-- Migration number: 0010 	 2026-06-04T00:00:00.000Z
-- 턴별 비용(실제 청구 credit) 기록. assistant 메시지 행에, 그 응답 생성에 든
-- AI Gateway 추론 비용(providerMetadata.gateway.cost, USD)을 저장한다. (정산·분석용)
-- 실측이 없는 경우(mock·구버전 응답)는 NULL.

ALTER TABLE chat_messages ADD COLUMN cost REAL;
