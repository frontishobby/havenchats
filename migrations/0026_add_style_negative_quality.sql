-- Migration number: 0026 	 2026-09-06T00:00:00.000Z
-- 그림체(art_styles)에 선택적 네거티브·퀄리티 프롬프트 컬럼 추가.
--  - negative: NULL/빈값이면 모델별 고정 NEGATIVE_PROMPT(_V5) 사용. 값이 있으면 아동 차단 접두 태그 뒤에 이 값을 붙여 대체.
--  - quality : NULL/빈값이면 모델별 고정 QUALITY_TAIL(_V5) 사용. 값이 있으면 퀄리티 꼬리를 이 값으로 대체.
-- 조립 규칙은 src/lib/server/novelai.ts (buildPositivePrompt / negativeFor).

ALTER TABLE art_styles ADD COLUMN negative TEXT;
ALTER TABLE art_styles ADD COLUMN quality TEXT;
