# Haven (havenchats.com)

캐릭터 AI 채팅 서비스 (babechat / caveduck 류). **소설 모드** 롤플레이, NSFW 포함(성인).
유저가 AI 캐릭터를 골라 1:1로 대화한다.

- **Prod**: https://havenchats.com (Cloudflare Pages, `havenchats.pages.dev`는 301 리디렉트)
- 상세 설계: `docs/ARCHITECTURE.md`

## 스택

| 영역 | 선택 |
|---|---|
| 호스팅/런타임 | Cloudflare Pages + SvelteKit (Svelte 5 runes), `@sveltejs/adapter-cloudflare` → **Workers 런타임** |
| LLM | **Vercel AI Gateway** (Vercel AI SDK v6 `ai` + `@ai-sdk/gateway`), 스트리밍 |
| DB | **Cloudflare D1** (SQLite). 유저 저장. raw D1 prepared statements (Drizzle 미사용) |
| 인증 | Google OAuth (`arctic`) + **서명 쿠키(stateless) 세션** (HMAC-SHA256, DB 미사용) |

## 핵심 규칙 / 함정 (중요 — 작업 전 숙지)

- **Workers 런타임 = Web 표준 API만**. Node API(`fs`, node `crypto`, `Buffer`) 금지. `crypto.subtle`, `fetch`, `ReadableStream` 사용.
- **env는 `$env/dynamic/private`로 읽는다** (dev: `.env`, prod: Pages secrets/bindings). `.env`는 **vite 시작 시점에만 로드** → 바꾸면 dev 서버 재시작 필수.
- **platformProxy 켜져 있음**(`svelte.config.js`) → `vite dev`에서도 D1 바인딩(`platform.env.DB`) 사용 가능. 로컬 D1 상태는 `.wrangler/state`.
- **Svelte 5 `$state` 배열 함정**: 배열에 push한 객체는 프록시로 감싸짐. 로컬 변수 ref로 mutate하면 반응성 X → **반드시 `arr[idx]`(프록시)로 수정**. (채팅 스트리밍 누적이 이걸로 동작)
- **AI SDK v6 `textStream`은 에러를 throw 안 함**(빈 스트림으로 끝남) → `streamText({ onError })`로 잡아야 함. (`/api/chat` 참고)
- **프롬프트 캐싱**: system(공통 규칙 + 캐릭터 `description` + 유저 페르소나)을 **항상 prefix**로, 가변 지침(분량·시점)은 **마지막 유저 메시지 끝에 부착** → prefix 캐싱 유지. `providerOptions.gateway.caching='auto'`.
- **모델 선택은 서버에서 허용목록(`MODEL_IDS`) 검증** 후 사용 (임의 모델 주입 방지).
- **NSFW 주의**: 메인스트림 모델(OpenAI/Anthropic/Google)은 성인물 거부. NSFW엔 허용 모델 필요 (배포 전 AI Gateway 카탈로그·약관 확인). 미성년자 묘사 등 불법 콘텐츠 차단 가드레일은 system 프롬프트에 항상 포함.
- **검증은 `npm run check`/build로**. UI 변경마다 Playwright 띄우지 말 것 (사용자 선호).

## 디렉토리

```
src/
  app.d.ts            # App.Locals.user, App.Platform.env(DB, AI_GATEWAY_API_KEY...) 타입
  hooks.server.ts     # ① pages.dev→havenchats.com 301 ② 세션쿠키 검증→D1 프로필 로드→locals.user
  app.css             # 다크 테마 토큰(CSS vars)
  lib/
    types.ts          # Character, ChatMessage 등
    data/
      characters.ts   # 캐릭터 정의(mock). description=시스템 프롬프트 핵심. 현재 하린(SFW)/세라(NSFW)
      models.ts       # 모델 목록(5개)+아이콘 경로+허용목록(MODEL_IDS)
    components/
      CharacterCard.svelte
      LoginModal.svelte     # Google 로그인 옵션, fade-in
      ProfileModal.svelte   # 이름/페르소나/취향(남성향·여성향)
    state/
      loginModal.svelte.ts   # 공유 $state (openLogin)
      profileModal.svelte.ts # 공유 $state (openProfile)
    server/
      auth.ts         # Google OAuth 클라이언트, 세션 토큰 sign/verify, isEmailAllowed(화이트리스트)
      db/users.ts     # findOrCreateOAuthUser, getUserProfile, updateProfile
  routes/
    +layout.{svelte,server.ts}   # 상단바(로그인/유저칩), 모달 렌더, 최초로그인 시 프로필모달 자동
    +page.{svelte,server.ts}     # 메인(캐릭터 그리드, 검색/태그). 비로그인=NSFW 숨김
    chat/[id]/+page.{svelte,server.ts}  # 소설모드 채팅. NSFW는 비로그인 차단
    api/chat/+server.ts          # 스트리밍(로그인 필수). 시스템프롬프트/모델라우팅/길이·시점 지침
    api/profile/+server.ts       # 프로필 저장(POST)
    auth/google/+server.ts       # OAuth 시작
    auth/google/callback/+server.ts  # 콜백: 이메일 화이트리스트→유저 upsert→세션 발급
    auth/logout/+server.ts
migrations/           # D1 마이그레이션 (0001 users+oauth_accounts, 0002 persona/preference)
static/favicon.svg    # 로고 스파클(✦) 자체 제작 SVG
static/models/*.avif  # 모델 아이콘
```

## DB 스키마 (D1: `haven`)

- **users**: `id`(uuid PK), `email`(unique), `display_name`(대화용 이름), `avatar_url`(미사용), `age_verified`, `persona`, `preference`('male'|'female'), `created_at`/`updated_at`(epoch ms)
- **oauth_accounts**: `(provider, provider_user_id)` PK → `user_id`
- 세션 id = 내부 user uuid. 프로필 완료 = `display_name` 존재.

## 구현된 기능

- 메인: 캐릭터 그리드 + 검색/태그 필터. **비로그인 시 NSFW 캐릭터 숨김**.
- 채팅: **소설 모드**(말풍선 X, 산문). 괄호 `()`/`*..*` 안 지시문=기울임, 대사=`발화자 | "대사"`(렌더 시 `|` 제거, 이름 강조색). 실시간 스트리밍.
- 채팅 설정 모달: **모델 선택**(아이콘 드롭다운, 5개), **답변 길이**(5~30문장 슬라이더), **'나' 행동·대사 생성**(금지/적정/풍부). localStorage 저장.
- 인증: Google 로그인 → **이메일 화이트리스트(테스트용)** → 프로필 모달(이름/페르소나/취향) → DB 저장. 네비바 이름 클릭 시 프로필 재편집.
- 게이팅: 채팅 전송·`/api/chat`은 **로그인 필수(서버 검증)**, NSFW는 비로그인 접근 차단.

## 환경 변수

`.env`(로컬, gitignore) / Pages secrets(prod):
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`(선택, 미설정 시 요청 origin 기준)
- `AUTH_SECRET` — 세션 서명
- `ALLOWED_EMAILS` — 로그인 허용 이메일(쉼표). 비우면 전체 허용. **테스트 종료 시 해제**.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — wrangler 인증 (프로젝트별 `.env`로 관리)

## 명령어

```bash
npm run dev            # 로컬 (vite, platformProxy로 D1 에뮬레이트). .env 변경 시 재시작
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
- 커스텀 도메인 `havenchats.com` 연결됨. **Google 콘솔 승인 리디렉트 URI**: `https://havenchats.com/auth/google/callback` (+ `http://localhost:5173/auth/google/callback`)

## 아직 안 된 것 / 다음 단계

- **대화 영속화 없음** — 채팅은 브라우저 메모리에만, 새로고침 시 사라짐. (conversations/messages 테이블 + `onFinish` 저장 필요)
- 장기 기억(요약/Vectorize), 결제/크레딧 없음
- `preference`(남성향/여성향) 저장만 하고 필터링엔 미사용
- Repository 추상화(Postgres 확장 경로)는 미구현 — 현재 `lib/server/db`에 raw D1
- NSFW 전용 허용 모델 미확정 (모델 드롭다운에서 선택, 메인스트림은 거부됨)
