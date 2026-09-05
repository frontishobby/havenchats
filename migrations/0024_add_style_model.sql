-- Migration number: 0024 	 2026-09-05T00:00:00.000Z
-- NovelAI Diffusion V5 출시(2026-08-21). 그림체(화풍 프롬프트)는 모델 세대에 종속되므로
-- 그림체마다 생성 모델 id 를 박는다. 기존 행은 전부 V4.5 로 만들어졌으므로 기본값 V4.5 Full.
-- 허용 id 목록은 src/lib/naiModels.ts (NAI_MODELS). 채팅·워크숍·썸네일은 이 값으로 요청 모델을 정한다.

ALTER TABLE art_styles ADD COLUMN model TEXT NOT NULL DEFAULT 'nai-diffusion-4-5-full';
