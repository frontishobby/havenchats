새로운 실시간 이미지 생성 기능 추가할거임. (novelAI 사용)
- 먼저 프로필 누르면 나오는 드롭다운에 API key 관리 버튼 추가하고 누르면 모달 뜨면서 novelAI key 등록가능하도록 설정 (opus 구독 검증 후 서버에 user_keys 테이블에 양방향 암호화 적용하여 저장)
- 채팅 세션에서 설정 버튼 옆에 이미지 버튼 만들고, 누르면 실시간 이미지 생성이 활성화됨
- 활성화 된 경우 해상도(832x1216, 1024x1024) 중 선택 가능하며, 그 아래에 항상 적용될 그림체 프롬프트 입력 가능
- 활성화 이후 채팅 진행시 assistant 출력 이후 따로 gemini 3.5 flash LLM 호출하여 상황 프롬프트를 작성
- 그리고 내가 아래에 작성할 퀄리티 프롬프트까지 해서 novelAI 에다가 그림체 프롬프트 + 상황 프롬프트 + 퀄리티 프롬프트 순으로 합쳐서 전달 (webp 로 생성)
- 생성된 이미지 받아서 webp 로 저장하고 이미지 채팅세션에 노출 (role=image_generation 으로 chat_message 저장. 이후 채팅진행할때는 이거는 LLM 에 보내는 프롬프트에서 제외)
- 이때 프롬프트 만들때 쓴 Gemini 로 인한 cost 는 다른 채팅처럼 X 좌측에 표시

이하는 novelAI 에 고정값으로 전달할 프롬프트 + 파라미터

{그림체 프롬프트}
지정 안할시 기본값=2::1girl, rating:nsfw 1.4::artist:sasamori tomoe:: 1.2::artist:ahemaru::, 0.7::artist:hero_neisan, artist:takano suzu::, 0.4::artist:kidmo::, 1.3::seoyong, artist:sohn woohyoung::, 1.2::healthyman ::, freng, 1.2::artist:sos adult::, 1.2::hiramedousa ::, 1.5::artist:shinjiro, artist:umezawa_itte::, 

{상황 프롬프트}

, -4::artist collaboration, year 2025, year 2024, -3::spoken bubble, text, cross-section::, rating:explicit, {{{-3::censored, photo inset, stomach deformation}}}, {{{-3::small lines::}}}, 1.5::balanced contrast::, -2::simple illustration::, -1::censored::, best quality, amazing quality, very aesthetic, intricate detail, highres, incredibly absurdres

아래는 네거티브 프롬프트 (고정)
text, logo, signature, watermark, too many watermarks, chili inset, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, very displeasing, undetailed eyes, multiple views, negative space, blank page, variant set, large variant set, 4koma, 2koma, oekaki, halftone, screentone, artistic error, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors, lowres, worst quality, bad quality, cheesy, sloppiness, unfinished, Incomplete, ai-generated

아래는 기타 필요 파라미터 (고정)
Model NAID 4.5F
Sampler k_euler_ancestral
Scheduler karras
Steps 28
CFG scale 5.8
CFG rescale 0.28


구현중 애매하면 질의

---

## 업데이트: NAI 캐릭터 기능 + 구조화 출력 (2026-06)

상황 프롬프트 생성을 단일 문자열(`generateText`)에서 **구조화 출력(`generateObject`)** 으로 전환하고,
NovelAI V4.5 **멀티 캐릭터 기능**(`char_captions`)을 사용하도록 변경.

> 2026-09-05: NovelAI Diffusion **V5**(2026-08-21 출시) 지원. 생성 모델은 그림체(`art_styles.model`)에 박히며, 허용목록·세대 정보는 `src/lib/naiModels.ts`. V5 는 `params_version: 4`, `noise_schedule` karras 고정, CFG 5 / rescale 0.4 / 28 steps(아카 V5 기초 가이드 설정). positive 는 가이드 순서 **인원수 > 그림체 > 연도(1.5) > 장면 > complexity(high 2/ultra 0.5) > 퀄리티(가중치) > 마이너스 > nsfw** 로 `buildPositivePrompt` 가 재배열(인원수 태그 hoist, 단일 인물 `solo` 보강, 그림체에 year/complexity 있으면 생략). 네거티브는 V5 전용 `NEGATIVE_PROMPT_V5`(가이드 순서 + `official style, official art`). 인물 상한 32. V4.5 그림체는 기존 손튜닝 파라미터·꼬리 그대로.
>
> 2026-09-06: 그림체에 **선택 퀄리티·네거티브 프롬프트**(`art_styles.quality/negative`, 마이그레이션 0026) 추가. 값이 있으면 모델별 고정 퀄리티 꼬리/네거티브를 그 값으로 통째로 대체(`resolveQualityTail`·`negativeFor(model, custom)`), 네거티브 앞 아동 차단 접두는 항상 유지. 채팅 prepare 는 `styleNegative/styleQuality`, 썸네일도 동일 필드로 받는다.

> 2026-09-05 (자연어 장면): 구조화 스키마에 **`scene`**(영어 1~2문장) 추가. V5 는 자연어+태그 혼용을 공식 지원(journal: "natural language prompting to the next level", 태그도 그대로)하므로 태그가 못 담는 **관계·행위 흐름·시선·공간 배치**를 문장으로 보강한다. 인물은 역할 명사(the woman/the man)로만 지칭하고 외형·옷은 금지(char_captions 누출 방지). 조립 위치는 base 태그 뒤·complexity 앞(`buildPositivePrompt` 5번째 인자), **V4.5 그림체면 버림**. 상한 400자(`MAX_SCENE_CHARS`, V5 Curated base ~703 토큰 예산 고려). `state` 도 짧은 절 허용으로 완화. 자연어 허용에 맞춰 미성년 하드차단 용어에 teen/schoolgirl/high school 등 우회 표현 추가(`minorSafety.ts`). 디버그 패널에 scene 표시.

- **모델 한정**: 상황 프롬프트 모델을 구조화 출력이 안정적인 **Gemini 계열** 로만 허용
  (`IMAGE_PROMPT_MODELS`/`IMAGE_PROMPT_MODEL_IDS`, 기본 `google/gemini-3.8-flash`). 다른 모델은 JSON 불안정.
- **구조화 스키마**: `{ base, characters: [{ caption }] }`
  - `base` = 배경·구도·**인원수 태그**(`1girl`/`1boy, 1girl`/`2girls`)·상호작용 태그(`source#`/`target#`/`mutual#`).
  - `characters[]` = 화면에 보이는 인물별 캡션(번호 없는 `girl`/`boy` + 외형(레퍼런스 고정) + 현재 복장 + 표정/포즈).
    인물을 분리하면 NAI 가 인물 간 속성 누출(머리색·옷 bleeding)을 막는다. {{나}}(유저)는 프레임에 실제로
    보일 때만 별도 엔트리(보통 1:1 POV 는 캐릭터 1명만). 최대 6명.
- **페이로드**: `v4_prompt.caption.char_captions` 채움, 위치는 **AUTO**(`use_coords:false`, `use_order:true`).
  음수(`v4_negative_prompt.char_captions`)는 양수와 **개수만 맞춘 빈 캡션**(전역 네거티브는 base_caption).
- **base_caption** = (NSFW면 `rating:nsfw`) + 그림체 + base 장면 + 퀄리티 꼬리. 인물 외형은 char_captions 로 분리.
- **안전**: base+모든 인물 캡션을 합쳐 미성년 하드차단(`containsMinorTerms`) 검사. 한글/잡음은 필드별 sanitize.
- 썸네일(`characters/thumbnail`)·그림체(`styles/generate`)는 단일 표준 장면이라 기존 flat 경로 유지
  (`generateImage`/`generateImageStream` 의 `charCaptions` 는 옵셔널 — 미전달 시 char_captions:[]).
---

## 업데이트: 클라 직접 호출(msgpack) + webp 커밋 (2026-09)

Worker 가 NovelAI SSE(base64) 프레임을 파싱해 NDJSON 으로 재전송하던 구조는 요청당 CPU 400~1,200ms 로
Workers 무료 플랜(10ms)에서 잘렸다. 채팅 이미지 경로를 **브라우저 직접 호출**로 바꿨다.

- `POST /api/chat/image/prepare` — 세션 검증 → 상황 프롬프트(LLM, 외형 원장) → 미성년 하드차단 →
  **NovelAI 요청 바디**(`buildGeneratePayload`) + `cost`(+debug) 반환. NovelAI 호출 없음.
- `GET /api/keys/novelai/token` — 본인 토큰 평문 수령(`cache-control: no-store`). 클라는 모듈 메모리에만 캐시.
- 클라(`lib/novelaiClient.ts`): `image.novelai.net/ai/generate-image-stream` 에 `parameters.stream='msgpack'`
  으로 직접 요청 → 4B BE 길이 프리픽스 + msgpack(`event_type`, `image` bin). intermediate(JPEG)=프리뷰,
  final(PNG)=결과. 스트림 실패 시 `/ai/generate-image`(ZIP, fflate) 폴백. 401/402/429 는 폴백 없이 에러.
  최종 PNG 는 canvas `toBlob('image/webp', 0.9)` 로 변환(미지원 브라우저면 PNG 유지).
- `POST /api/chat/image/commit?sessionId&replaceId&assistantMsgId&cost` — 바디=이미지 바이너리
  (webp/png/jpeg, 12MB 상한) → R2 `chatimg/<sessionId>/<id>.<ext>` + `image_generation` 행(assistant seq 대기 로직 유지).
- 썸네일(`characters/thumbnail`)·그림체(`styles/generate`)는 아직 서버 NDJSON 경로(`generateImageStream`) — 후속.
