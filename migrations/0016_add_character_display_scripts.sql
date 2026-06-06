-- Migration number: 0016 	 2026-06-06T00:00:00.000Z
-- imported(charx) 카드의 editdisplay 정규식(표시용 HTML 치환). JSON 배열.
-- 형태: [ { "in": "<img=\"(.+?)\">", "out": "<style>…</style><div>…{{raw::$1}}…</div>", "flags": "g" } ]
-- 채팅 렌더 시(클라) 모델 출력의 <img="..."> 마커를 감정 스프라이트 HTML 로 바꾼다(CBS 평가→DOMPurify 세정).
-- 표시 전용(숨김 프롬프트 아님)이라 클라이언트로 내려간다. user 제작 캐릭터는 NULL.

ALTER TABLE characters ADD COLUMN display_scripts TEXT;
