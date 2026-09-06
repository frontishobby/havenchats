# Haven (havenchats.com)

캐릭터 AI 채팅 서비스 (babechat / caveduck 류). **소설 모드** 롤플레이, NSFW 포함(성인).
유저가 AI 캐릭터를 골라 1:1로 대화하고, 직접 캐릭터를 만들어 공개한다.

- **Prod**: https://havenchats.com (**단일 Cloudflare Worker** — Hono API + 정적 SPA를 한 Worker가 서빙. `*.workers.dev`는 301 리디렉트)
- 상세 설계: `docs/ARCHITECTURE.md`

## 스택

| 영역 | 선택 |
|---|---|
| 호스팅/런타임 | **단일 Cloudflare Worker**(`worker/`, **Hono**). `/api`·`/auth`·`/img`는 Hono 라우터, 그 외(정적·SPA 네비)는 **Workers Static Assets**(SvelteKit `@sveltejs/adapter-static` 빌드 결과 `build/`)가 직접 서빙. 프론트=Svelte 5 SPA(`ssr=false`) |
| LLM | **Vercel AI Gateway** (Vercel AI SDK v6 `ai` + `@ai-sdk/gateway`), 스트리밍 |
| DB | **Cloudflare D1** (SQLite). 유저·캐릭터·대화(세션/메시지) 저장. raw D1 prepared statements (Drizzle 미사용). **`env.DB` 네이티브 바인딩 직결**(과거 HTTP 프록시 Worker 제거) |
| 이미지 | **Cloudflare R2** (`haven-images` 버킷, `IMAGES` 바인딩). 캐릭터 썸네일·장면 이미지·유저 아바타. `/img/[...key]`(Hono)로 서빙. `PUBLIC_IMAGE_BASE` 주면 공개 도메인 직접 서빙 |
| 인증 | Google OAuth (`arctic`) + **서명 쿠키(stateless) 세션** (HMAC-SHA256). worker/src/index.ts Hono 미들웨어가 세션→유저 로드 |

## 핵심 규칙 / 함정 (중요 — 작업 전 숙지)

- **Workers 런타임 = Web 표준 API만**. Node API(`fs`, node `crypto`, `Buffer`) 금지. `crypto.subtle`, `fetch`, `ReadableStream` 사용.
- **server 코드의 env**: 기존 `import { env } from '$env/dynamic/private'`(및 `/public`)는 wrangler `alias`(`wrangler.jsonc`)로 **`src/lib/server/env.ts` shim**에 매핑된다. Worker fetch 진입 시 `setRuntime(env, ctx)`로 요청 컨텍스트 연결 → vars·secret·바인딩(`DB`/`IMAGES`)이 모두 단일 `env`에서 읽힌다. `getDB()`/`getImages()`/`getWaitUntil()`는 이 런타임 env/ctx를 쓴다(인자 무시). prod env는 `wrangler secret put` / `wrangler.jsonc vars`.
- **로컬 개발 = 2터미널**: ①`npm run dev:worker`(`wrangler dev`, :8787, 로컬 D1/R2 — `.wrangler/state`) ②`npm run dev`(`vite`, :5173, `/api`·`/auth`·`/img`를 :8787로 프록시 — `vite.config.ts`). `.env`는 vite 시작 시점에만 로드 → 바꾸면 재시작.
- **라우팅 분기**(`wrangler.jsonc assets`): `run_worker_first: ["/api/*","/auth/*","/img/*"]`만 Worker(Hono) 호출, 나머지는 Worker 안 거치고 정적 assets가 직접 서빙(`not_found_handling: single-page-application` → 미매칭 경로는 `index.html`로 SPA).
- **Svelte 5 `$state` 배열 함정**: 배열에 push한 객체는 프록시로 감싸짐. 로컬 변수 ref로 mutate하면 반응성 X → **반드시 `arr[idx]`(프록시)로 수정**. (채팅 스트리밍 누적이 이걸로 동작)
- **AI SDK v6 `textStream`은 에러를 throw 안 함**(빈 스트림으로 끝남) → `streamText({ onError })`로 잡아야 함. (`/api/chat` 참고. 에러 시 채팅 버블에 일반 메시지 노출, 상세는 서버 로그만)
- **프롬프트 캐싱**: system은 **고정 prefix**(제작자 `description` + 장면 이미지 카탈로그 + 상대(유저) 정보 + 가드레일)로 만들고, 가변 부분(분량·'나' 행동 지침)은 **마지막 유저 메시지 끝에 부착** → prefix 캐싱 유지. **요약(rolling summary) 블록은 system 맨 끝**에 둬서 갱신 전까지 prefix 캐시 재사용. `providerOptions.gateway.caching='auto'`.
- **토큰 전략**(`/api/chat`): ① **sliding window** — `seq > summary_upto_seq` 메시지만 모델에 전송. ② **rolling summary** — window 토큰이 `WINDOW_TOKEN_BUDGET`(6000) 초과 + `KEEP_RECENT`(12) 초과 시 백그라운드 요약(`waitUntil`). ③ **input 하드가드** — 모델 `contextLimit` 기준으로 요청 시점에 오래된 window를 동기적으로 잘라냄(최신은 항상 보존). ④ 단일 유저 메시지 `MAX_USER_MSG_TOKENS`(4000) 초과 시 413 거부.
- **모델 선택은 서버에서 허용목록(`MODEL_IDS`) 검증** 후 사용 (임의 모델 주입 방지). 각 모델은 `contextLimit`(input 가드 기준) 보유.
- **반복 억제**(`/api/chat`): 분량 지침은 '약 N문장 목표(최소 0.7N·최대 N), 반복이 아니라 장면 진행으로 채울 것' + '앞선 응답 문장·문단·상투 묘사 재사용 금지, 매 턴 장면 진행' 규칙을 응답 지침에 포함('최대 N' 상한만 주면 모델이 절반쯤에서 임의로 끊어 30문장 설정이 무의미해짐). DeepSeek·GLM 엔 `repetitionPenalties`(frequency 0.4·presence 0.3) 추가(Anthropic·Google·OpenAI GPT-5.x 추론 모델은 미지원 — SDK `unsupported` 경고만 남기므로 제외). 배경: DeepSeek V4 Pro 장문 세션에서 직전 응답 41문단 중 31문단이 글자 단위 복사되던 실측(2026-09).
- **DeepSeek 공급자 라우팅**(`buildProviderOptions`): 게이트웨이는 DeepSeek 을 11개 공급자 중 가중 추첨으로 고르는데 **Alibaba(Model Studio)는 자체 검열**로 성인 장면을 스트림 본문 에러 JSON(`data_inspection_failed`)으로 거부 → HTTP 에러가 아니라 폴백도 안 타고 `AI_TypeValidationError`(choices 누락)로 끝남(2026-09-06 실측). 또 Alibaba 경유는 frequencyPenalty unsupported. → `gateway.order`+`only: ['deepseek','fireworks','baseten','novita','deepinfra']`(alibaba 제외)로 고정. `order` 는 우선순위만 주고 미기재 공급자를 폴백으로 남기며, `only` 만 주면 목록 안에서 다시 가중 추첨이라 둘 다 필요(2026-09-07 라우팅 메타 실측). Claude 도 같은 이유로 `only: ['anthropic']`(Bedrock 경유 정책 차단 회피). 채팅 버블엔 검열 차단 안내 문구 분기(`isProviderCensorError`), 콘솔 메타 `streamError` 는 cause/value 까지 JSON 직렬화.
- **NSFW 검열 회피 프레이밍**(`chatAssembly.ts`, RisuAI '망원경(Lacuna)' 프리셋에서 회피 요소만 발췌, 2026-09-06): "성적 묘사 허용" 같은 직접 문구는 Vertex(Gemini 3.8+) 입력 필터에 걸리므로 쓰지 않는다. NSFW·비imported 캐릭터는 ① system 맨 앞 `<Ai mandate=…/>`(인과 타당 결과는 그대로 렌더링 + 🔞 이모지) + `<Identity=세계 시뮬레이터/>`, ② `# 필수 준수` 의 허용 줄을 '장면 유형 동등 취급 + 의성어' 영어 조항(`NSFW_RENDERING_LINES`)으로 대체, ③ window 맨 앞 assistant **사전 동의 턴**(`NSFW_PREAGREE_TURN`, 오프닝과 한 메시지로 병합) — 이 셋은 **모델 무관 전체 적용**. ④ Gemini 전용 **XML 프레임**(system 전문을 `<Security:InputParsing>`+`<World:Root>` 로 감싼 첫 user 메시지로 접고 입력/로어/지침/기억을 태그로 감싸는 `usesXmlFrame` 경로)은 **`XML_FRAME_ENABLED=false` 로 꺼둠** — 2026-09-06 실측(세션 재생 17회)에서 이 프레임만 텍스트 거부 3회, 프레임 없는 ①~③ 은 10회 전부 정상. 미성년 하드 가드 문구는 그대로 유지. SFW·imported 캐릭터는 변화 없음. Vertex 페일오버 회복 효과는 아직 미실측. 재현 스크립트 패턴: D1 에서 세션 메시지+캐릭터를 뽑아 `buildSystemPrompt`/`buildMessages` 로 변형별 조립 → `.env` 의 `AI_GATEWAY_API_KEY` 로 `generateText` N회(tsx, 레포 안 경로에서 실행해야 `ai` 모듈 해석됨).
- **장면 이미지(축×조합)**: 모델은 응답에 **위치코드**(`{AAB}` — 축별 value index를 A=0,B=1…로) 출력. DB 저장 시 `pinSceneCodes`로 **불변 토큰**(`{#entryId}`)으로 고정(이후 제작자가 축/값 순서 바꿔도 안 흔들림). 렌더러는 두 형식 모두 해석. 유틸은 `lib/imageCodes.ts`(클라/서버 공용 순수함수).
- **그리드 코드 폭 가변**: 축 값 26개 초과면 코드 두 글자(AA~ZZ, 최대 676), 조합 상한 6,000, `ImageAxis.fallback`(없는 조합이면 그 축을 기본값으로 재시도 — 인물×상황 희소 세트용). 대량 업로드는 관리자 전용 `POST /api/characters/:id/scenes/bulk` + `scripts/scenes-bulk.mjs`(파일명 `키_키.webp` → combo, `HAVEN_COOKIE` 필요).
- **`{{나}}` 플레이스홀더**: 제작자 프롬프트·오프닝의 `{{나}}` → 유저 이름(없으면 '나')으로 치환.
- **NSFW 주의**: 메인스트림 모델(OpenAI/Anthropic/Google)은 성인물 거부. NSFW엔 허용 모델 필요. 미성년자 묘사 등 불법 콘텐츠 차단 가드레일은 system 프롬프트에 항상 포함.
- **검증은 `npm run check`/build로**. UI 변경마다 Playwright 띄우지 말 것 (사용자 선호).

## 디렉토리

```
worker/               # ⭐ Cloudflare Worker(Hono) — 백엔드 API + 정적 SPA 서빙(설정은 루트 wrangler.jsonc)
  tsconfig.json       # worker 전용 타입체크(paths 로 $lib·$env 매핑)
  src/
    index.ts          # Hono 앱: setRuntime(env/ctx) + 세션 미들웨어(쿠키→D1 프로필→c.var.user, 차단유저 변이차단, *.workers.dev→canonical 301) + 라우터 마운트 + onError(HttpError→JSON·Redirect→{redirect}) + ASSETS 폴백
    context.ts        # AppEnv(Bindings=c.env / Variables=c.var.user=UserProfile|null), requireUser(c)→401
    routes/
      auth.ts         # /auth/google·/google/callback·/logout
      img.ts          # /img/* R2 서빙(엣지 caches.default, ?v= 캐싱)
      api.ts          # /api 하위 라우터 마운트
      api/
        chat.ts       # /api/chat 전체: POST '/'(스트리밍)·rewrite(입력 필터)·recent·session·messages·memory·summary·vars·image/prepare·image/commit·inspect·page(채팅페이지 데이터)
        characters.ts # 생성/수정/삭제/promote/assist/thumbnail + GET edit-data·assets-data(구 로더)
        styles.ts     # 그림체 Hub API + GET page(구 로더)
        modules.ts    # 모듈 Hub API(재사용 프롬프트: 목록·생성·수정·삭제·즐겨찾기·page·forchat)
        keys.ts       # /api/keys/gateway·/novelai (GET/POST/DELETE) + /novelai/token(클라 직접 호출용 평문 수령)
        profile.ts    # /api/profile (POST)
        import.ts     # charx import(관리자)
        admin.ts      # overview·infra·stats·users/:id·users/:id/block (관리자)
        pages.ts      # /api/me(레이아웃)·/api/home(메인)·/api/user/:id (구 +layout/+page.server 데이터)
src/                  # SvelteKit 정적 SPA(프론트엔드 only)
  app.html            # SPA 셸 + **부트 스켈레톤**(#boot, 경로별 6종 인라인 CSS/HTML — JS·API 로드 전 표시, 루트 레이아웃 onMount 가 제거)
  app.d.ts            # App.Locals.user(UserProfile 형태) 타입
  app.css             # 다크 테마 토큰(CSS vars)
  lib/
    types.ts          # Character, Opening, ImageAxis/Entry/Set, ChatMessage, ChatSession, RecentChat 등
    imageCodes.ts     # 장면 이미지 코드 유틸. 클라·서버 공용 순수함수
    imageBase.ts      # imgSrc/IMAGE_BASE (PUBLIC_IMAGE_BASE — $env/dynamic/public)
    novelaiClient.ts  # 클라 전용: NovelAI 직접 호출(msgpack 스트림·ZIP 폴백·webp 변환·토큰 캐시)
    api/              # ⭐ Worker↔SPA 공용 (alias 로 worker 도 import)
      load.ts         # loadJson(fetch,path) — 클라 로더 공용 GET(401/error·{redirect} 처리)
      pages·chat·characters·styles·modules·keys·profile·admin·import.ts  # 요청·응답 공용 타입(modules: MAX_ACTIVE_MODULES=8)
    data/models.ts    # 모델 목록+아이콘+contextLimit+허용목록(MODEL_IDS)
    components/        # (변경 없음) CharacterCard/DetailModal/Form/ImagesModal/Sidebar/LoginModal/ProfileModal/ApiKeyModal/StyleWorkshopModal/ModuleEditorModal …
    state/            # loginModal/profileModal/apiKeyModal.svelte.ts (공유 $state)
    server/           # ⭐ Worker 에서만 사용(SPA 번들 제외). wrangler alias($lib)·$env shim 으로 번들
      env.ts          # $env/dynamic/private|public shim + setRuntime/getRuntimeEnv/getExecutionCtx
      httpError.ts    # HttpError(status)·Redirect(soft) — 구 @sveltejs/kit error/redirect 대체
      waitUntil.ts    # getWaitUntil() → ExecutionContext.waitUntil
      auth.ts crypto.ts novelai.ts characters.ts characterForm.ts imageStore.ts images.ts(getImages→env.IMAGES)
      credits.ts notify.ts recentChats.ts chatPageLoad.ts chatAssembly.ts minorSafety.ts nsfwUnlock.ts cloudflare.ts cfPricing.ts importCharx.ts
      imagePrompt.ts    # 이미지 상황 프롬프트 공용(구조화 스키마 SCENE_PROMPT_SCHEMA·sanitizeTags/Scene·ADULT_ONLY_RULE·HIDDEN_FEATURE_RULE/stripHiddenFeatures — 옷 입은 장면이면 유두·음모·배 문신 등 가려지는 특징을 appearance 에서 제거, NAI 가 특징 보여주려 벗기는 것 방지) — 채팅 이미지·썸네일 공용
      db/ users.ts characters.ts chats.ts userKeys.ts styles.ts modules.ts admin.ts  remote.ts(getDB→env.DB 직결)
  routes/             # 전부 클라 렌더(.svelte) + universal 로더(+page.ts/+layout.ts, ssr=false)
    +layout.{svelte,ts}   # ssr=false + /api/me 로드(유저·사이드바·크레딧)
    +page.{svelte,ts}     # 메인 그리드 — /api/home
    create/+page.{svelte,ts}                 # 로그인 가드(parent().user)
    import/+page.{svelte,ts}                  # charx(관리자 가드)
    characters/[id]/edit/+page.{svelte,ts}    # /api/characters/:id/edit-data
    characters/[id]/assets/+page.{svelte,ts}  # /api/characters/:id/assets-data
    user/[id]/+page.{svelte,ts}               # /api/user/:id
    chat/[id]/+page.{svelte,ts}               # /api/chat/page (하위 /session/[sessionId]·/debug 동일 로더)
    styles/+page.{svelte,ts}                  # /api/styles/page
    modules/+page.{svelte,ts}                 # /api/modules/page (모듈 Hub)
    admin/…                                    # overview/infra/stats/users/[id] (관리자) — /api/admin/*
wrangler.jsonc        # Worker 설정: main, assets(run_worker_first·SPA fallback), alias($lib·$env), D1·R2 바인딩
migrations/           # D1 마이그레이션
static/favicon.svg, static/models/*.avif
```

## DB 스키마 (D1: `haven`)

- **users**: `id`(uuid PK), `email`(unique), `display_name`(대화용 이름), `avatar_url`(**R2 오브젝트 키** 저장 → `/img/<key>`로 서빙), `age_verified`, `persona`, `preference`('male'|'female'), `created_at`/`updated_at`(epoch ms)
- **oauth_accounts**: `(provider, provider_user_id)` PK → `user_id`
- **characters**(유저 제작): `id`(uuid PK), `creator_id`→users, `name`, `tagline`, `intro`(상세모달 표시용, 프롬프트엔 미포함), `description`(시스템 프롬프트 본문), `thumbnail_key`(R2), `audience`('all'|'male'|'female'), `content_rating`('sfw'|'nsfw'), `tags`(JSON), `greetings`(JSON, 오프닝 목록), `image_set`(JSON, 축×조합 장면이미지/NULL), `chats`(누적 대화수), `created_at`/`updated_at`
- **chat_sessions**: `id`(uuid PK), `user_id`, `character_id`(빌트인slug+uuid 혼재 가능 → **FK 미설정**), `model`(마지막 사용), `summary`/`summary_upto_seq`(요약 상태), `message_count`(마지막 seq), `created_at`/`updated_at`/`last_message_at`. `appearances`(JSON, 실시간 이미지 **외형 원장** — 동적 NPC 고정 외형, 주인공·유저 제외), `outfits`(JSON, **복장 원장** — 인물별 현재 복장/노출 상태, 주인공·유저 포함. 상황 프롬프트에 `[Current outfits]`로 주입해 '텍스트가 바꾸지 않으면 그대로 복사' → 옷 벗은 상태가 최근 3턴 창 밖으로 밀려도 유지. 재생성(replaceId)은 읽기만)
- **chat_messages**: `id`(uuid PK), `session_id`→sessions, `seq`(세션 내 1-based), `role`('user'|'assistant'|**'image_generation'**), `content`(image_generation 은 **R2 키**), `token_est`, `input_tokens`(assistant 행에 그 응답 생성 시 input 토큰 실측/추정), `cost`(assistant=추론비용, image_generation=Gemini 상황프롬프트 비용), `created_at`. unique(session_id, seq). **`image_generation` 행은 LLM window/요약에서 제외**(`getWindow`·프리뷰 서브쿼리에서 `role != 'image_generation'`), 표시·페이징엔 포함.
- **user_keys**: `(user_id, provider)` PK, `ciphertext`(**AES-GCM 양방향 암호화** `base64url(iv‖ct)` — 평문 미저장), `meta`(JSON 검증 스냅샷: NovelAI `{tier,active,isOpus}`), `created_at`/`updated_at`. provider 현재 `'novelai'`. 복호화 키는 `KEY_SECRET`(폴백 `AUTH_SECRET`)에서 파생.
- **art_styles**(그림체 Hub): `id`(uuid PK), `creator_id`→users, `title`, `memo`, `prompt`(화풍 태그), `model`(NovelAI 모델 id, 기본 `nai-diffusion-4-5-full` — 기존 행=V4.5), `negative`/`quality`(NULL 허용, 선택 네거티브·퀄리티 프롬프트 — 0026), `thumbnail_key`(R2 `style/<id>.<ext>` — 고정 표준 장면 SFW 썸네일), `created_at`/`updated_at`
- **art_style_favorites**: `(user_id, style_id)` PK — 채팅 이미지 모달에서 고를 수 있는 후보. `characters.recommended_style_id`(추가됨): 제작자 추천 그림체.
- **prompt_modules**(모듈 Hub, 0027): `id`(uuid PK), `creator_id`→users, `title`, `memo`(표시용, 프롬프트 미포함), `prompt`(본문, ≤4000자), `shared`(1=Hub 공개/0=비공개), `created_at`/`updated_at`. **prompt_module_favorites**: `(user_id, module_id)` PK — 채팅 모듈 모달 후보(내 것 + 즐겨찾기).
- 세션 id = 내부 user uuid. 프로필 완료 = `display_name` 존재. 오프닝(greeting)은 세션 시작 시 seq=1 메시지로 저장(세션별 앵커). **캐릭터 데이터는 세션에 스냅샷하지 않음** — characters 테이블이 source of truth.

## 구현된 기능

- **메인**: 캐릭터 그리드 + 검색/태그 필터. **비로그인 시 NSFW 캐릭터 숨김**.
- **캐릭터 제작/관리**: `/create`로 캐릭터 등록(이름·소개·프롬프트·태그·오프닝 다중·썸네일·장면 이미지). 소유자만 수정(`/characters/[id]/edit`)·삭제. 폼/이미지 파싱은 `characterForm.ts`, R2 정리는 `imageStore.ts`.
- **AI 도우미(제작 폼)**: `CharacterAssistPanel`(러프 입력 → `POST /api/characters/assist` — `streamObject` 구조화 출력을 **NDJSON 스트림**(`progress`/`ping`/`done`/`error`, 타입 `AssistStreamEvent`)으로 흘려 폼 채움·기존 내용 보존 수정. 비스트리밍 `generateObject` 시절 12k+ 토큰 응답을 기다리는 동안 어느 홉도 바이트를 안 보내 무한 대기가 났던 것을 고침: 서버 heartbeat 10s·상한 5분·`maxRetries:1`, 클라 60s 무수신 감지·취소 버튼) + `CharacterThumbnailPanel`(NovelAI 썸네일 — **자연어 연출**(선택, 한국어) + 설정을 `POST /api/characters/thumbnail` 이 `generateObject` 로 `{ base, scene, characters[] }` 구조화(스키마·sanitizer 는 채팅 이미지와 공용 `lib/server/imagePrompt.ts`) → 인물별 캡션을 NAI `char_captions` 로 분리해 **여러 인물 동시 등장** 가능. 패널에서 base/장면 문장/인물 캡션을 편집해 그림만 다시 뽑거나(`prompt` 전송) '↻ 설정·연출 반영'으로 재생성(`regen`). 상황 프롬프트 모델은 `IMAGE_PROMPT_MODELS`(GLM 5.3 Flash), 미성년 하드차단 동일 적용). **허용 모델 `ASSIST_MODELS`: Claude Opus 4.6·GPT-5.6 Sol·DeepSeek V4 Pro·GLM 5.3 Flash(기본)** — 구조화 출력 안정 모델만(Gemini Flash 는 NSFW 설정 입력 content-filter 로 제외. DeepSeek V4 Pro 는 Opus·Sol 이 NSFW 설정을 거부할 때의 상위 대안 — 2026-09-07 실측 4/4 정상, 30~35s). PC(≥1080px)는 폼 우측 sticky 열, **모바일은 우하단 ✦ FAB → 바텀시트**(탭: 캐릭터 생성/썸네일) — 같은 DOM 인스턴스를 CSS 로만 배치 전환.
- **유저 프로필 페이지**(`/user/[id]`): 공개 프로필 + 제작 캐릭터 목록. 본인이면 전체, 외부 방문자에겐 NSFW 숨김.
- **채팅**: **소설 모드**(말풍선 X, 산문). 괄호 `()`/`*..*` 지시문=기울임, 대사=`발화자 | "대사"`(`|` 제거·이름 강조). **장면 이미지** 인라인 표시(위치코드/핀 토큰). 실시간 스트리밍.
- **대화 영속화**: 세션+메시지 D1 저장. 유저 메시지는 즉시 저장(스트림 끊겨도 유실 방지), assistant는 `onFinish`에 저장. **사이드바 최근 채팅**(`listRecentSessions`, 마지막 대사 미리보기). `/chat/[id]/session/[sessionId]` 경로로 이어가기(구버전 `?s=`도 하위호환). 새 세션은 첫 전송 시 lazy 생성 후 `replaceState`로 세션 URL로 교체(기본은 항상 새 세션).
- **장기 맥락**: sliding window + rolling summary(백그라운드 갱신). 요약은 모달에서 조회/수동 수정 가능(`/api/chat/summary`).
- **채팅 설정 모달**: **모델 선택**(아이콘 드롭다운, 가격 내림차순 7개: Claude Opus 4.6(RP 커뮤니티 합의 최고·검열 최약. Opus 4.8·5 는 하드검열 강화라 제외, 2026-09-07)·Kimi K3·GPT-5.6 Sol·Gemini 3.8 Flash·DeepSeek V4 Pro 0813·GLM 5.3 Flash·DeepSeek V4 Flash 0731(기본)), **답변 길이**(5~30문장 슬라이더), **'나' 행동·대사 생성**(0금지/1적정/2풍부). localStorage 저장.
- **이어가기(자동 진행)**: 입력창을 비운 채 전송 버튼(»)을 누르면 `/api/chat` 에 `continue:true` 로 보내 **유저 메시지 없이** 캐릭터가 직전 장면을 이어 쓴다. 서버는 user 행을 저장하지 않고, `buildMessages` 가 마지막 assistant 뒤에 `CONTINUE_DIRECTIVE`(이어가기 지시)+로어+응답 지침을 합성 user 메시지로 붙인다. DB 엔 assistant 행이 연달아 쌓이므로 `buildMessages` 가 **연속 assistant 를 한 메시지로 병합**해 모델에 보낸다. Enter 는 빈 입력이면 무시(버튼만). 이어갈 assistant 가 없으면(오프닝 없는 새 세션) 400.
- **입력 제안**(전송 버튼 왼쪽 💬): `POST /api/chat/suggest`(`SuggestRequestBody`) — 캐릭터 description·요약·최근 대화 꼬리(8개)·페르소나를 system 에 넣고 **DeepSeek V4 Pro 고정**(`SUGGEST_MODEL_ID`, noThinking)으로 유저가 다음에 할 법한 입력 후보 3개를 번호 목록으로 받아 파싱(`parseSuggestions`). 컴포저 위 칩으로 표시, 클릭 시 **입력창에 채움**(바로 전송 X). 제안 비용은 `pendingSuggestCost` 로 모아 다음 유저 메시지의 `inputCost` 에 합산 기록.
- **입력 필터**(채팅 헤더 🪄 버튼, 🖼 왼쪽): 켜면 컴포저 위에 **지시 한 줄**(예: "무협지 풍으로")이 나타나고, 전송 시 클라가 먼저 `POST /api/chat/rewrite`(`RewriteRequestBody`)로 원문을 보내 서버가 **캐릭터 description(참고)·요약·최근 대화 꼬리(8개)·유저 페르소나**를 system 에 넣고 `generateText`(noThinking) 로 지시 문체로 **다시 쓴 입력문**을 받은 뒤, 그 텍스트로 `/api/chat` 을 호출한다(DB 에는 변환문이 user 메시지로 저장. 변환 비용은 `inputCost` 로 되돌려 보내 user 행 `cost` 에 기록·버블 옆 표시). 변환 중엔 유저 버블에 pending 표시, 실패 시 버블 제거·입력 복원·에러 표시. 변환 모델은 **채팅 모델 목록(MODELS) 전체** 선택 가능(기본 DeepSeek V4 Flash), 설정은 localStorage(`haven:filter:*`). 규칙: 의도·행동·대사 보존, 캐릭터 반응 대필 금지, 분량 ≤1.5배, 미성년 가드.
- **실시간 이미지 생성(NovelAI)**: 채팅 헤더 🖼 버튼으로 켜면(localStorage) 매 assistant 턴 직후 클라가 ① `POST /api/chat/image/prepare` → 서버가 LLM(`generateObject` **구조화 출력**)으로 마지막 응답을 `{ base, scene, characters[{name, appearance, outfit, state}] }` 로 분해(인물 캡션 = 외형 + **outfit**(복장/노출 — 세션 `outfits` 복장 원장으로 턴 간 유지) + state(포즈·표정). `scene`=자연어 장면 1~2문장, V5 만 조립에 사용·V4.5 는 버림. 이 비용이 메시지 cost)·미성년 하드차단·**NovelAI 요청 바디**(`buildGeneratePayload`) 반환 → ② **브라우저가 `image.novelai.net` 을 직접 호출**(`lib/novelaiClient.ts`: `/ai/generate-image-stream` + `parameters.stream='msgpack'` → 4B 길이 프리픽스 + msgpack, intermediate=JPEG 프리뷰·final=PNG. 실패 시 `/ai/generate-image` ZIP 폴백(fflate). 토큰은 `GET /api/keys/novelai/token` 으로 받아 메모리에만) → 최종 PNG 를 **webp 변환**(`lib/imagePreview.ts blobToWebp`: canvas.toBlob → WebKit(사파리·iOS 전 브라우저)은 webp 인코딩 미지원이라 `lib/webpEncode.worker.ts` 의 libwebp WASM(`@jsquash/webp`, ~100KB br) 워커로 폴백. 그림체 워크숍 썸네일·캐릭터 썸네일도 동일 함수) → ③ `POST /api/chat/image/commit?sessionId&replaceId&assistantMsgId&cost` 에 바이너리 업로드 → R2(`chatimg/<sessionId>/<id>.<ext>`) 저장 + `role=image_generation` 메시지 영속. **Worker 는 NovelAI 프레임을 만지지 않는다**(무료 플랜 CPU 10ms 대응 — 예전 서버 SSE→NDJSON 재전송은 요청당 CPU 0.4~1.2s). **NAI 모델은 그림체에 박힌 값**(`art_styles.model`, 허용목록 `lib/naiModels.ts`: V5 Full(기본)·V5 Curated·V4.5 Full — 2026-08-21 V5 출시, 기존 그림체는 마이그레이션 0024 기본값으로 V4.5 마킹). 워크숍 미리보기·썸네일·채팅(`naiModel`) 모두 고른 그림체의 모델로 요청하고, `buildGeneratePayload`가 모델별 `params_version`(V5=4)·CFG(`imageParamsFor`)·퀄리티 꼬리(`qualityTailFor`)를 고른다. NAI **멀티 캐릭터 기능**(`char_captions` 인물별 분리 → 속성 누출 방지), 위치는 AUTO(`use_coords:false`+`use_order`), 인물 최대 V4.5=6·V5=32(모델별 상한), {{나}}는 프레임에 보일 때만 별도 엔트리. **상황 프롬프트 모델은 구조화 출력 안정 + NSFW 비거부 모델로 한정**(`IMAGE_PROMPT_MODELS`: GLM 5.3 Flash(기본)·MiniMax M3 — MODELS 와 별개 목록, `findImagePromptModel` 로 조회. Gemini Flash 는 BLOCK_NONE 에도 노골적 장면 content-filter 라 제외). 해상도(세로 832×1216/정사각 1024×1024/가로 1216×832 — 가로형이면 상황 프롬프트 user 끝에 `[Canvas] LANDSCAPE` 구도 힌트 부착)·**1명 고정**(`solo`, localStorage `haven:img:solo` — 다인 장면에서 NAI 디테일 붕괴 방지. user 끝에 `[Solo]` 힌트(주인공 1명·POV/프레임 밖 처리) + 서버 후처리: 인물 엔트리를 첫 1개로 자르고(`char` 강제 X — 주인공이 육체 없는 AI/내레이터형이면 기기가 그려지는 실측) `enforceCountBase` 로 base 의 인원수·source#/target# 태그 제거 후 `1girl/1boy, solo` 강제. 상황 프롬프트 공통 규칙에 '비육체 주인공은 인물 엔트리 금지, 장면의 실제 인물을 그림' 추가. 하위 토글 **'남성 1명 추가 허용'**(`soloMale`, localStorage `haven:img:soloMale`): `[Solo+1]` 힌트 — 기본 1명, 포옹·정사 등 상대 남성 몸이 프레임에 꼭 필요할 때만 남성 1명(보통 유저)을 2번째 엔트리로 허용. 서버 `pickSoloEntries` 가 '남성 아닌 첫 인물 + 남성 첫 인물' 최대 2명만 남기고, 2명이면 base 를 `1boy, 1girl`(상호작용 태그 유지)로 정리)·**그림체(즐겨찾기에서 택1)**·상황프롬프트 모델·'빠른 생성 우선'은 헤더 모달에서 설정. NSFW 캐릭터면 base_caption 앞에 `rating:nsfw`. 미성년 하드차단은 base+모든 인물 캡션 합본 검사. 캐릭터 description 통짜를 외형 레퍼런스로 LLM 에 주입. 키는 **프로필 메뉴 > API 키 관리**에서 등록(NovelAI **Opus 등급** 검증(`api.novelai.net` 은 CORS 불가 → 서버) 후 암호화 저장). 고정 프롬프트/파라미터·검증·서버측 ZIP 해제는 `lib/server/novelai.ts`. 썸네일(`characters/thumbnail`)·그림체(`styles/generate`)는 아직 서버 NDJSON 스트림 경로(`generateImageStream`). Gemini 는 `gateway.order:['google','vertex']` 페일오버 — **google(AI Studio) 우선**: Vertex 는 Gemini 3.8+ 에서 NSFW 허용 지시가 든 프롬프트를 입력 단계에서 content-filter 차단(빈 응답, 페일오버 안 탐).
- **그림체 Hub**(`/styles`): 유저가 화풍(스타일) 프롬프트를 만들어 공유·즐겨찾기. **깎기 워크숍**(`StyleWorkshopModal`)에서 화풍+상황(테스트)으로 자기 NovelAI 키로 미리보기 생성 → 공유 시 제목·메모 + **고정 표준 장면**(`THUMBNAIL_SITUATION`, SFW)으로 일관 썸네일 리롤·결정 → R2 저장. 카드(썸네일+제목+작성자) 클릭 시 상세(프롬프트+즐겨찾기). **선택 퀄리티·네거티브 프롬프트**(워크숍 접이식 섹션, `art_styles.negative/quality`): 비면 모델별 고정 `QUALITY_TAIL(_V5)`/`NEGATIVE_PROMPT(_V5)`, 있으면 **통째로 대체**(`resolveQualityTail`/`negativeFor(model, custom)`) — 단 네거티브 앞 아동 차단 접두(`MINOR_BLOCK_NEGATIVE`)는 항상 유지, V5 연도·complexity 자동 주입은 그림체 또는 퀄리티에 이미 있으면 생략. 워크숍 미리보기·썸네일·채팅(`styleNegative/styleQuality`)·캐릭터 썸네일 모두 고른 그림체의 값을 보낸다. 채팅 이미지 모달은 즐겨찾기 그림체 중 택1(캐릭터 추천 그림체 상단). 캐릭터 제작 폼에서 추천 그림체 지정 가능. 본인 그림체는 상세의 '수정'으로 같은 워크숍 모달을 채워 열어 수정(`edit` prop → `PATCH /api/styles/:id` multipart, 썸네일은 선택·미첨부 시 유지, 공개 여부는 그대로. JSON `{shared}` PATCH 는 공개 토글). API: `/api/styles*`(목록·생성·수정·상세·삭제·즐겨찾기·`mine`·`generate`).
- **모듈 Hub**(`/modules`): 캐릭터 무관·재사용 가능한 **일반 지침**(출력 규칙 추가, 문체, 금기 등)을 만들어 공유·즐겨찾기(`ModuleEditorModal`: 제목·메모·본문·공개 토글, JSON `POST/PATCH /api/modules(/:id)`, `{shared}` 만 보내면 공개 토글). 채팅 헤더 🧩 버튼(설정 왼쪽) 모달에서 **내 모듈 + 즐겨찾기** 중 여러 개를 켜고 끔(최대 `MAX_ACTIVE_MODULES`=8, 켠 순서 번호 표시, localStorage `haven:modules:active` JSON 배열 — 전역 설정). 전송 시 `moduleIds` 로 보내면 서버가 `getModulesForChat`(공유 or 본인 소유만, 클라 순서 유지)로 해석해 `assembleTurn({modules})` → `buildModulesBlock`(`[추가 규칙 — 모듈]` 헤더 + `## 제목`/본문, `{{char}}`·`{{나}}` 치환) → **프롬프트 가장 마지막**: `[응답 지침]` 뒤 같은 user 메시지에 부착(이어가기 턴도 동일, XML 프레임이면 `<Guide:Modules>`). 꼬리 블록이라 prefix 캐시 무영향. 디버그 스냅샷 `modulesBlock`·패널 '모듈' 섹션, `/api/chat/inspect` 도 `moduleIds` 수용.
- **인증**: Google 로그인 → **이메일 화이트리스트(테스트용)** → 프로필 모달(이름/페르소나/취향/아바타) → DB 저장. 네비바 이름 클릭 시 재편집.
- **게이팅**: 채팅 전송·`/api/chat`·캐릭터 생성/수정은 **로그인 필수(서버 검증)**, NSFW는 비로그인 접근 차단.

## 환경 변수

`.env`(로컬, gitignore) / **Worker secrets**(prod, `wrangler secret put`) / 비밀 아닌 값은 `wrangler.jsonc` `vars`:
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway. (채팅은 유저 본인 Gateway 키 BYO 사용)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`(선택, 미설정 시 요청 origin 기준)
- `AUTH_SECRET` — 세션 서명
- `KEY_SECRET` — 유저 외부 API 키 **양방향 암호화** 키(AES-GCM). **미설정 시 `AUTH_SECRET`로 폴백**. 생성: `openssl rand -base64 48`.
- `ALLOWED_EMAILS` — 로그인 허용 이메일(쉼표). 미설정 시 기본 `owner@example.com`만 허용, 빈 문자열=전체 허용. **테스트 종료 시 해제**.
- `PUBLIC_IMAGE_BASE`(선택) — 이미지 공개 도메인. 미설정 시 `/img` 라우트로 R2 서빙.
- `DISCORD_WEBHOOK_URL`(선택), `NSFW_UNLOCK_CODE`(선택, 기본 'arca'), `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`(**Worker 시크릿으로만**, admin infra 탭용. 로컬 .env 에는 두지 않음 — wrangler 계정 오인 방지)
- (NovelAI 키는 env 가 아니라 유저별 `user_keys` 테이블에 암호화 저장)

## 명령어

```bash
# 로컬 개발 = 2터미널
npm run dev:worker     # ① wrangler dev (:8787) — Hono API + 로컬 D1/R2 바인딩(.wrangler/state)
npm run dev            # ② vite (:5173) — SPA HMR, /api·/auth·/img 를 :8787 로 프록시

npm run check          # svelte-check + tsc(worker) (커밋/배포 전 필수)
npm run build          # vite build → adapter-static → build/ (정적 SPA)

# wrangler 인증 = `wrangler login` OAuth(frontishobby 계정). 프로젝트 루트의 .env 에 CLOUDFLARE_API_TOKEN 이 있으면
# wrangler 가 자동 로드해 그쪽 계정으로 붙으니, .env 에는 CF 토큰을 두지 않는다(구 무료 계정 토큰은 제거).
npx wrangler d1 migrations apply haven --local    # 로컬 스키마
npx wrangler d1 migrations apply haven --remote   # 원격 스키마
npm run deploy                                     # 수동 배포(build 후 wrangler deploy). 평시 배포는 main 푸시 → CF Workers Builds(대시보드 Git 연결)
npx wrangler secret put <KEY>                      # prod 시크릿
npx wrangler deploy --dry-run --outdir=/tmp/x      # 번들/바인딩 검증(업로드 안 함)
```

## 인프라

- **Worker**: `havenchats` (`main: worker/src/index.ts`). 정적 SPA(`build/`)를 ASSETS 로 서빙 + Hono API. (구 Pages 프로젝트·Vercel·d1-worker 프록시는 폐기)
- **Cloudflare 계정**: `frontishobby`(id `91e905352aff208653b16dd55b3f7e60`, **Workers Paid**). 2026-09-05 에 무료 계정 `HavenChats`(`130cd789…`)에서 도메인(Registrar 이동)·Worker·D1·R2 를 전부 이전. 무료 플랜 CPU 10ms 한도에 채팅 스트리밍(요청당 CPU 170~975ms)이 걸려 응답 끊김·이미지 commit 실패가 났던 것이 이전 사유.
- D1: `haven` (id `4ddf590a-9ef2-45c6-bb07-a293fefdd239`, region APAC) — `DB` 바인딩(네이티브 직결). (구 계정 id `b8c2b1a3…` 는 폐기)
- R2: `haven-images` — `IMAGES` 바인딩. 키 규칙: 썸네일 `char/<id>.<ext>`, 장면 `charimg/<charId>/<entryId>.<ext>`, 아바타 `avatar/<...>`, 실시간 생성 `chatimg/<sessionId>/<msgId>.<ext>`, 그림체 `style/<id>.<ext>`. 서빙 `/img/[...key]`(Hono)
- 커스텀 도메인 `havenchats.com` 은 `wrangler.jsonc` `routes`(custom_domain) 로 **이 Worker 에 연결**. 배포는 **CF Workers Builds**(대시보드에서 GitHub 레포 연결, main 푸시 시 `npm run build` → `wrangler deploy`). 구 GitHub Actions 워크플로는 제거. **Google 콘솔 리디렉트 URI**: `https://havenchats.com/auth/google/callback` (+ `http://localhost:5173/auth/google/callback`)
- **남은 원격 정리**: 구 무료 계정(`HavenChats`)의 Worker `havenchats`·D1 `haven`·R2 `haven-images` 는 이전 검증 후 삭제. (구 `d1-worker`·Pages·Vercel 도 동일)

## 아직 안 된 것 / 다음 단계

- **캐릭터 삭제 시 세션 정리 없음** — `deleteCharacter`는 characters 행 + R2 이미지만 지움. `chat_sessions`/`chat_messages`는 FK·cascade 없이 **고아 행으로 잔존**. UX상으론 graceful(사이드바에선 `findCharacter` null→스킵, 직접 접근은 404)이지만 DB 행이 영구 누적됨. 정리 로직(동반 삭제 or cron) 미정.
- 빌트인(목) 캐릭터 없음 — 현재 모든 캐릭터는 유저 제작(D1). (예전 `lib/data/characters.ts`는 제거됨)
- `preference`(남성향/여성향) 저장만 하고 노출 필터링엔 미사용 (`audience` 컬럼은 있으나 필터 미연결)
- 장기 기억은 rolling summary까지만 (Vectorize/장기 검색 없음). 결제/크레딧 없음.
- Repository 추상화(Postgres 확장 경로)는 미구현 — 현재 `lib/server/db`에 raw D1
- NSFW 전용 허용 모델 미확정 (모델 드롭다운에서 선택, 메인스트림은 거부됨)
- `age_verified` 컬럼 존재하나 NSFW 게이트엔 미사용(로그인 여부로만 게이팅)
- **실시간 이미지 R2 정리 없음** — `image_generation` 메시지 삭제/세션 삭제 시 DB 행은 지워도 `chatimg/...` R2 오브젝트는 **고아로 잔존**(기존 캐릭터 삭제 캐비엇과 동일). 정리(cron) 미정. webp 는 NovelAI per-request 옵션이 없어 **계정 Image Format 설정**을 따름 → 보통 PNG, 응답 매직바이트로 실제 포맷 판별 저장.
