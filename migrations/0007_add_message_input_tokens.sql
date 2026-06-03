-- Migration number: 0007 	 2026-06-03T00:00:00.000Z
-- 턴별 input 토큰 기록. assistant 메시지 행에, 그 응답을 만들 때 모델에 들어간
-- input 토큰 수(프로바이더 usage 실측, 없으면 추정치)를 저장한다. (정산·분석·디버깅용)

ALTER TABLE chat_messages ADD COLUMN input_tokens INTEGER;
