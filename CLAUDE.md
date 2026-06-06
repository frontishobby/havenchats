# Haven (havenchats.com)

캐릭터 AI 채팅 서비스 (babechat / caveduck 류). **소설 모드** 롤플레이, NSFW 포함(성인).
유저가 AI 캐릭터를 골라 1:1로 대화하고, 직접 캐릭터를 만들어 공개한다.

- **Prod**: https://havenchats.com (Cloudflare Pages, `havenchats.pages.dev`는 301 리디렉트)
- 상세 설계: `docs/ARCHITECTURE.md`

## 스택

| 영역 | 선택 |
|---|---|
| 호스팅/런타임 | Cloudflare Pages + SvelteKit (Svelte 5 runes), `@sveltejs/adapter-cloudflare` → **Workers 런타임** |
| LLM | **Vercel AI Gateway** (Vercel AI SDK v6 `ai` + `@ai-sdk/gateway`), 스트리밍 |
| DB | **Cloudflare D1** (SQLite). 유저·캐릭터·대화(세션/메시지) 저장. raw D1 prepared statements (Drizzle 미사용) |
| 이미지 | **Cloudflare R2** (`haven-images` 버킷, `IMAGES` 바인딩). 캐릭터 썸네일·장면 이미지·유저 아바타. `/img/[...key]` 라우트로 서빙 |
| 인증 | Google OAuth (`arctic`) + **서명 쿠키(stateless) 세션** (HMAC-SHA256, DB 미사용) |

## 핵심 규칙 / 함정 (중요 — 작업 전 숙지)

- **Workers 런타임 = Web 표준 API만**. Node API(`fs`, node `crypto`, `Buffer`) 금지. `crypto.subtle`, `fetch`, `ReadableStream` 사용.
- **env는 `$env/dynamic/private`로 읽는다** (dev: `.env`, prod: Pages secrets/bindings). `.env`는 **vite 시작 시점에만 로드** → 바꾸면 dev 서버 재시작 필수.
- **platformProxy 켜져 있음**(`svelte.config.js`) → `vite dev`에서도 D1(`platform.env.DB`)·R2(`platform.env.IMAGES`) 바인딩 사용 가능. 로컬 상태는 `.wrangler/state`.
- **Svelte 5 `$state` 배열 함정**: 배열에 push한 객체는 프록시로 감싸짐. 로컬 변수 ref로 mutate하면 반응성 X → **반드시 `arr[idx]`(프록시)로 수정**. (채팅 스트리밍 누적이 이걸로 동작)
- **AI SDK v6 `textStream`은 에러를 throw 안 함**(빈 스트림으로 끝남) → `streamText({ onError })`로 잡아야 함. (`/api/chat` 참고. 에러 시 채팅 버블에 일반 메시지 노출, 상세는 서버 로그만)
- **프롬프트 캐싱**: system은 **고정 prefix**(제작자 `description` + 장면 이미지 카탈로그 + 상대(유저) 정보 + 가드레일)로 만들고, 가변 부분(분량·'나' 행동 지침)은 **마지막 유저 메시지 끝에 부착** → prefix 캐싱 유지. **요약(rolling summary) 블록은 system 맨 끝**에 둬서 갱신 전까지 prefix 캐시 재사용. `providerOptions.gateway.caching='auto'`.
- **토큰 전략**(`/api/chat`): ① **sliding window** — `seq > summary_upto_seq` 메시지만 모델에 전송. ② **rolling summary** — window 토큰이 `WINDOW_TOKEN_BUDGET`(6000) 초과 + `KEEP_RECENT`(12) 초과 시 백그라운드 요약(`waitUntil`). ③ **input 하드가드** — 모델 `contextLimit` 기준으로 요청 시점에 오래된 window를 동기적으로 잘라냄(최신은 항상 보존). ④ 단일 유저 메시지 `MAX_USER_MSG_TOKENS`(4000) 초과 시 413 거부.
- **모델 선택은 서버에서 허용목록(`MODEL_IDS`) 검증** 후 사용 (임의 모델 주입 방지). 각 모델은 `contextLimit`(input 가드 기준) 보유.
- **장면 이미지(축×조합)**: 모델은 응답에 **위치코드**(`{AAB}` — 축별 value index를 A=0,B=1…로) 출력. DB 저장 시 `pinSceneCodes`로 **불변 토큰**(`{#entryId}`)으로 고정(이후 제작자가 축/값 순서 바꿔도 안 흔들림). 렌더러는 두 형식 모두 해석. 유틸은 `lib/imageCodes.ts`(클라/서버 공용 순수함수).
- **`{{나}}` 플레이스홀더**: 제작자 프롬프트·오프닝의 `{{나}}` → 유저 이름(없으면 '나')으로 치환.
- **NSFW 주의**: 메인스트림 모델(OpenAI/Anthropic/Google)은 성인물 거부. NSFW엔 허용 모델 필요. 미성년자 묘사 등 불법 콘텐츠 차단 가드레일은 system 프롬프트에 항상 포함.
- **검증은 `npm run check`/build로**. UI 변경마다 Playwright 띄우지 말 것 (사용자 선호).

## 디렉토리

```
src/
  app.d.ts            # App.Locals.user, App.Platform.env(DB, IMAGES, SESSIONS, AI_GATEWAY_API_KEY) 타입
  hooks.server.ts     # ① pages.dev→havenchats.com 301 ② 세션쿠키 검증→D1 프로필 로드→locals.user
  app.css             # 다크 테마 토큰(CSS vars)
  lib/
    types.ts          # Character, Opening, ImageAxis/Entry/Set, ChatMessage, ChatSession, RecentChat 등
    imageCodes.ts     # 장면 이미지 코드 유틸(위치코드↔combo, 카탈로그/핀 변환). 클라·서버 공용 순수함수
    data/
      models.ts       # 모델 목록(5개)+아이콘+contextLimit+허용목록(MODEL_IDS)
    components/
      CharacterCard.svelte
      CharacterDetailModal.svelte   # 캐릭터 상세 + 오프닝 선택 + '채팅 시작'
      CharacterForm.svelte          # 캐릭터 생성/수정 공용 폼
      CharacterImagesModal.svelte   # 장면 이미지(축×조합) 편집
      Sidebar.svelte                # 최근 채팅 목록
      LoginModal / ProfileModal / ApiKeyModal / NsfwBadge / PromptGuideModal / TextReplaceModal
    state/
      loginModal.svelte.ts / profileModal.svelte.ts / apiKeyModal.svelte.ts   # 공유 $state
    server/
      auth.ts         # Google OAuth, 세션 토큰 sign/verify, isEmailAllowed(화이트리스트)
      crypto.ts       # 양방향(대칭) 암호화 AES-GCM(encryptSecret/decryptSecret) — 외부 API 키 보관용
      novelai.ts      # NovelAI 연동: verifySubscription(Opus 검증), generateImage(고정 프롬프트/파라미터, ZIP 해제)
      characters.ts   # 캐릭터 조회 래퍼(getVisibleCharacters/findCharacter) — D1 위임
      characterForm.ts# 캐릭터 폼·이미지셋 파싱/검증(parseCharacterForm/parseImageSet)
      imageStore.ts   # R2 업로드/정리(commitImageSet, deleteKeys, deleteAllSceneImages)
      db/
        users.ts      # findOrCreateOAuthUser, getUserProfile, getPublicProfile, updateProfile, updateAvatarKey
        characters.ts # CRUD(listCharacters, getCharacterById, createCharacter, updateCharacter, deleteCharacter, ownership)
        chats.ts      # 세션/메시지(getSession, createSession, appendMessage, getWindow, updateSummary, listRecentSessions, estimateTokens)
        userKeys.ts   # 외부 API 키 보관(getKeyStatus/getDecryptedKey/setKey/deleteKey) — 암호문만 저장
  routes/
    +layout.{svelte,server.ts}   # 상단바, 사이드바(최근 채팅), 모달 렌더, 최초로그인 시 프로필모달
    +page.{svelte,server.ts}     # 메인(캐릭터 그리드, 검색/태그). 비로그인=NSFW 숨김
    create/+page.{svelte,server.ts}              # 캐릭터 만들기(로그인 필수)
    characters/[id]/edit/+page.{svelte,server.ts}# 캐릭터 수정(소유자만)
    user/[id]/+page.{svelte,server.ts}           # 유저 공개 프로필 + 제작 캐릭터 목록
    chat/[id]/+page.{svelte,server.ts}           # 소설모드 채팅(새 세션). ?o=오프닝. NSFW 비로그인 차단
    chat/[id]/session/[sessionId]/+page.*        # 세션 이어가기(하위 /debug 포함). 로더는 chatPageLoad 공용
    img/[...key]/+server.ts      # R2 오브젝트 서빙(썸네일/장면/아바타)
    api/
      chat/+server.ts            # 스트리밍(로그인 필수). system조립/모델라우팅/토큰전략/영속화/요약
      chat/summary/+server.ts    # 세션 요약 조회(GET)·수동 수정(POST)
      chat/image/+server.ts      # 실시간 이미지 생성(POST): Gemini 상황프롬프트→NovelAI→R2 저장→image_generation 메시지
      keys/novelai/+server.ts    # NovelAI 키 관리: GET(상태)·POST(Opus 검증+암호화 저장)·DELETE
      characters/+server.ts      # 캐릭터 생성(POST)
      characters/[id]/+server.ts # 캐릭터 수정(PUT)·삭제(DELETE). 소유자 검증
      profile/+server.ts         # 프로필·아바타 저장(POST)
    auth/google/+server.ts, auth/google/callback/+server.ts, auth/logout/+server.ts
migrations/           # D1 마이그레이션 0001~0019
static/favicon.svg    # 로고 스파클(✦) SVG
static/models/*.avif  # 모델 아이콘
```

## DB 스키마 (D1: `haven`)

- **users**: `id`(uuid PK), `email`(unique), `display_name`(대화용 이름), `avatar_url`(**R2 오브젝트 키** 저장 → `/img/<key>`로 서빙), `age_verified`, `persona`, `preference`('male'|'female'), `created_at`/`updated_at`(epoch ms)
- **oauth_accounts**: `(provider, provider_user_id)` PK → `user_id`
- **characters**(유저 제작): `id`(uuid PK), `creator_id`→users, `name`, `tagline`, `intro`(상세모달 표시용, 프롬프트엔 미포함), `description`(시스템 프롬프트 본문), `thumbnail_key`(R2), `audience`('all'|'male'|'female'), `content_rating`('sfw'|'nsfw'), `tags`(JSON), `greetings`(JSON, 오프닝 목록), `image_set`(JSON, 축×조합 장면이미지/NULL), `chats`(누적 대화수), `created_at`/`updated_at`
- **chat_sessions**: `id`(uuid PK), `user_id`, `character_id`(빌트인slug+uuid 혼재 가능 → **FK 미설정**), `model`(마지막 사용), `summary`/`summary_upto_seq`(요약 상태), `message_count`(마지막 seq), `created_at`/`updated_at`/`last_message_at`
- **chat_messages**: `id`(uuid PK), `session_id`→sessions, `seq`(세션 내 1-based), `role`('user'|'assistant'|**'image_generation'**), `content`(image_generation 은 **R2 키**), `token_est`, `input_tokens`(assistant 행에 그 응답 생성 시 input 토큰 실측/추정), `cost`(assistant=추론비용, image_generation=Gemini 상황프롬프트 비용), `created_at`. unique(session_id, seq). **`image_generation` 행은 LLM window/요약에서 제외**(`getWindow`·프리뷰 서브쿼리에서 `role != 'image_generation'`), 표시·페이징엔 포함.
- **user_keys**: `(user_id, provider)` PK, `ciphertext`(**AES-GCM 양방향 암호화** `base64url(iv‖ct)` — 평문 미저장), `meta`(JSON 검증 스냅샷: NovelAI `{tier,active,isOpus}`), `created_at`/`updated_at`. provider 현재 `'novelai'`. 복호화 키는 `KEY_SECRET`(폴백 `AUTH_SECRET`)에서 파생.
- 세션 id = 내부 user uuid. 프로필 완료 = `display_name` 존재. 오프닝(greeting)은 세션 시작 시 seq=1 메시지로 저장(세션별 앵커). **캐릭터 데이터는 세션에 스냅샷하지 않음** — characters 테이블이 source of truth.

## 구현된 기능

- **메인**: 캐릭터 그리드 + 검색/태그 필터. **비로그인 시 NSFW 캐릭터 숨김**.
- **캐릭터 제작/관리**: `/create`로 캐릭터 등록(이름·소개·프롬프트·태그·오프닝 다중·썸네일·장면 이미지). 소유자만 수정(`/characters/[id]/edit`)·삭제. 폼/이미지 파싱은 `characterForm.ts`, R2 정리는 `imageStore.ts`.
- **유저 프로필 페이지**(`/user/[id]`): 공개 프로필 + 제작 캐릭터 목록. 본인이면 전체, 외부 방문자에겐 NSFW 숨김.
- **채팅**: **소설 모드**(말풍선 X, 산문). 괄호 `()`/`*..*` 지시문=기울임, 대사=`발화자 | "대사"`(`|` 제거·이름 강조). **장면 이미지** 인라인 표시(위치코드/핀 토큰). 실시간 스트리밍.
- **대화 영속화**: 세션+메시지 D1 저장. 유저 메시지는 즉시 저장(스트림 끊겨도 유실 방지), assistant는 `onFinish`에 저장. **사이드바 최근 채팅**(`listRecentSessions`, 마지막 대사 미리보기). `/chat/[id]/session/[sessionId]` 경로로 이어가기(구버전 `?s=`도 하위호환). 새 세션은 첫 전송 시 lazy 생성 후 `replaceState`로 세션 URL로 교체(기본은 항상 새 세션).
- **장기 맥락**: sliding window + rolling summary(백그라운드 갱신). 요약은 모달에서 조회/수동 수정 가능(`/api/chat/summary`).
- **채팅 설정 모달**: **모델 선택**(아이콘 드롭다운, 5개), **답변 길이**(5~30문장 슬라이더), **'나' 행동·대사 생성**(0금지/1적정/2풍부). localStorage 저장.
- **실시간 이미지 생성(NovelAI)**: 채팅 헤더 🖼 버튼으로 켜면(localStorage) 매 assistant 턴 직후 클라가 `/api/chat/image` 호출 → ① Gemini(`google/gemini-3.5-flash`)가 마지막 응답을 **상황 프롬프트**(best-effort danbooru 태그+자연어)로 변환(이 비용이 메시지 cost 로 표시) → ② 그림체+상황+고정 퀄리티/네거티브로 **NovelAI(nai-diffusion-4-5-full)** 생성(응답 ZIP→매직바이트로 webp/png 판별) → ③ R2(`chatimg/<sessionId>/<msgId>.<ext>`) 저장 + `role=image_generation` 메시지 영속. 해상도(832×1216/1024×1024)·그림체 프롬프트는 헤더 모달에서 설정. 키는 **프로필 메뉴 > API 키 관리**에서 등록(NovelAI **Opus 등급** 검증 후 암호화 저장). 고정 프롬프트/파라미터·검증·ZIP 해제는 `lib/server/novelai.ts`.
- **인증**: Google 로그인 → **이메일 화이트리스트(테스트용)** → 프로필 모달(이름/페르소나/취향/아바타) → DB 저장. 네비바 이름 클릭 시 재편집.
- **게이팅**: 채팅 전송·`/api/chat`·캐릭터 생성/수정은 **로그인 필수(서버 검증)**, NSFW는 비로그인 접근 차단.

## 환경 변수

`.env`(로컬, gitignore) / Pages secrets(prod):
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway. **없으면 mock 스트리머로 폴백**(로컬 키 없이 UI 동작).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`(선택, 미설정 시 요청 origin 기준)
- `AUTH_SECRET` — 세션 서명
- `KEY_SECRET` — 유저 외부 API 키(NovelAI 등) **양방향 암호화** 키(AES-GCM). **미설정 시 `AUTH_SECRET`로 폴백**(로컬 동작). 바꾸면 기존 암호문 복호화 불가 → 키 재등록 필요. 생성: `openssl rand -base64 48`.
- (NovelAI 키는 **env 가 아니라 유저별 `user_keys` 테이블**에 암호화 저장 — 환경변수 아님)
- `ALLOWED_EMAILS` — 로그인 허용 이메일(쉼표). **미설정 시 기본 `owner@example.com`만 허용**, 빈 문자열로 두면 전체 허용. **테스트 종료 시 해제**.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — wrangler 인증 (프로젝트별 `.env`로 관리)

## 명령어

```bash
npm run dev            # 로컬 (vite, platformProxy로 D1·R2 에뮬레이트). .env 변경 시 재시작
npm run check          # svelte-check (커밋/배포 전 필수)
npm run build          # adapter-cloudflare 빌드

# wrangler 명령은 .env의 CF 토큰 export 후 실행:
export $(grep -E '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=' .env | xargs)
npx wrangler d1 migrations apply haven --local    # 로컬 스키마
npx wrangler d1 migrations apply haven --remote   # 원격 스키마
npm run build && npx wrangler pages deploy --branch main   # 배포
npx wrangler pages secret put <KEY> --project-name havenchats  # prod 시크릿
```

## 인프라

- Pages 프로젝트: `havenchats` (production branch `main`)
- D1: `haven` (id `b8c2b1a3-78e8-4527-aefa-461bcd3486b7`, region APAC) — `wrangler.jsonc`에 `DB` 바인딩
- R2: `haven-images` — `IMAGES` 바인딩. 키 규칙: 썸네일 `char/<id>.<ext>`, 장면 `charimg/<charId>/<entryId>.<ext>`, 아바타 `avatar/<...>`, 실시간 생성 이미지 `chatimg/<sessionId>/<msgId>.<ext>`. 서빙은 `/img/[...key]`
- 커스텀 도메인 `havenchats.com` 연결됨. **Google 콘솔 승인 리디렉트 URI**: `https://havenchats.com/auth/google/callback` (+ `http://localhost:5173/auth/google/callback`)

## 아직 안 된 것 / 다음 단계

- **캐릭터 삭제 시 세션 정리 없음** — `deleteCharacter`는 characters 행 + R2 이미지만 지움. `chat_sessions`/`chat_messages`는 FK·cascade 없이 **고아 행으로 잔존**. UX상으론 graceful(사이드바에선 `findCharacter` null→스킵, 직접 접근은 404)이지만 DB 행이 영구 누적됨. 정리 로직(동반 삭제 or cron) 미정.
- 빌트인(목) 캐릭터 없음 — 현재 모든 캐릭터는 유저 제작(D1). (예전 `lib/data/characters.ts`는 제거됨)
- `preference`(남성향/여성향) 저장만 하고 노출 필터링엔 미사용 (`audience` 컬럼은 있으나 필터 미연결)
- 장기 기억은 rolling summary까지만 (Vectorize/장기 검색 없음). 결제/크레딧 없음.
- Repository 추상화(Postgres 확장 경로)는 미구현 — 현재 `lib/server/db`에 raw D1
- NSFW 전용 허용 모델 미확정 (모델 드롭다운에서 선택, 메인스트림은 거부됨)
- `age_verified` 컬럼 존재하나 NSFW 게이트엔 미사용(로그인 여부로만 게이팅)
- **실시간 이미지 R2 정리 없음** — `image_generation` 메시지 삭제/세션 삭제 시 DB 행은 지워도 `chatimg/...` R2 오브젝트는 **고아로 잔존**(기존 캐릭터 삭제 캐비엇과 동일). 정리(cron) 미정. webp 는 NovelAI per-request 옵션이 없어 **계정 Image Format 설정**을 따름 → 보통 PNG, 응답 매직바이트로 실제 포맷 판별 저장.
