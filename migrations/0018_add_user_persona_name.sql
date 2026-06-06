-- 대화용 이름(persona_name) 분리.
-- display_name = 남에게 노출되는 이름(프로필 필수).
-- persona_name = 채팅에서 AI 가 부르는 이름(선택). 비면 채팅에서 display_name 으로 폴백.
ALTER TABLE users ADD COLUMN persona_name TEXT;
