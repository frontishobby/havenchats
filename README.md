# Haven (havenchats.com)

캐릭터 AI 채팅 서비스 — **소설 모드** 롤플레이, 성인(NSFW) 포함. 유저가 AI 캐릭터를 골라 1:1로 대화하고 직접 캐릭터를 만들어 공개한다.

- **Prod**: https://havenchats.duckdns.org
- 제품/도메인 상세 설계: [`CLAUDE.md`](./CLAUDE.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

> 정적 SPA(SvelteKit, Svelte 5 runes) + 백엔드 단일 Cloudflare Worker(Hono). LLM은 Vercel AI SDK v6(AI Gateway). 앱·데이터(D1·R2) 모두 **Cloudflare** 한 곳에서 돈다.

---

## 호스팅 아키텍처 (단일 Cloudflare Worker)

전체가 **하나의 Cloudflare Worker**(name: `havenchats`, main: `worker/src/index.ts`)로 돈다. 백엔드는 **Hono** 기반이고, 프론트는 **정적 SPA**(`@sveltejs/adapter-static` 빌드 결과 `build/`)다.

라우팅은 wrangler `assets` 설정으로 갈린다:

- `/api/*`, `/auth/*`, `/img/*` → `run_worker_first` 에 등록 → **Hono 라우터**가 처리.
- 그 외 모든 경로(정적 파일·SPA 네비게이션) → **Workers Static Assets**(`build/`)가 직접 서빙. Worker 를 거치지 않음 → 무료/저비용. `not_found_handling: "single-page-application"` 로 미매칭 경로는 `index.html` 폴백.

**D1(`DB`)·R2(`IMAGES`) 네이티브 바인딩 직결.** 과거 Vercel 호스팅 시절의 HTTP 프록시 Worker(`d1-worker`)와 원격 프록시 클래스는 제거됐고, `getDB()`/`getImages()` 는 이제 `env.DB`/`env.IMAGES` 를 그대로 반환한다(오버헤드 0).

```
사용자 ──> havenchats.com (Cloudflare Worker `havenchats`)
              │
              ├─ /api/*, /auth/*, /img/*  → Worker (Hono 라우터)
              │      ├─ D1 `haven`        (env.DB 네이티브 바인딩)
              │      └─ R2 `haven-images` (env.IMAGES 네이티브 바인딩)
              │
              └─ 그 외(정적파일·SPA 네비게이션) → Workers Static Assets(build/, SPA 폴백)
```

### 런타임 연결 & env shim

기존 server 코드는 SvelteKit 의 `$env/dynamic/private`·`$env/dynamic/public` 를 import 한다. wrangler `alias` 로 이 둘을 **`src/lib/server/env.ts`(shim)** 에 매핑해 무수정 재사용한다. Worker fetch 핸들러 진입 시 `setRuntime(env, ctx)` 로 요청 컨텍스트를 연결하면, 바인딩(DB/IMAGES/ASSETS)·secret·var 가 모두 단일 `env` 객체로 들어온다.

| 관심사 | 헬퍼 | 위치 | 동작 |
|---|---|---|---|
| `env.DB` (D1) | `getDB()` | `src/lib/server/db/remote.ts` | `env.DB` 네이티브 바인딩 직접 반환 |
| `env.IMAGES` (R2) | `getImages()` | `src/lib/server/images.ts` | `env.IMAGES` 네이티브 바인딩 직접 반환 |
| R2 서빙(읽기) | `imgSrc(key)` / `IMAGE_BASE` | `src/lib/imageBase.ts` | 기본 `/img` 라우트(Worker 가 R2 서빙). `PUBLIC_IMAGE_BASE` 있으면 R2 공개 도메인 |
| 백그라운드 작업 | `getWaitUntil()` | `src/lib/server/waitUntil.ts` | `ExecutionContext.waitUntil` 사용(없으면 fire-and-forget) |

### 세션/인증 & 에러 처리

구 `hooks.server.ts` 로직은 `worker/src/index.ts` 의 Hono 미들웨어로 옮겼다: 세션 쿠키 검증 → D1 프로필 로드 → `c.var.user`, 차단 유저의 변이 요청 차단, workers.dev → `havenchats.com` 301. 전역 `onError` 는 `HttpError` → JSON, `Redirect` → `{ redirect }` JSON(SPA 클라가 따라가는 soft-redirect)으로 변환한다.

### 프론트엔드 = 정적 SPA

`@sveltejs/adapter-static`(fallback `index.html`), `ssr=false` 로 전 라우트 클라 렌더. 기존 `+page.server.ts`/`+layout.server.ts` 서버 로더는 전부 제거됐고, 같은 데이터를 **universal `+page.ts`/`+layout.ts` 클라 로더**가 `loadJson()`(`src/lib/api/load.ts`)으로 같은 오리진 `/api/*` 를 호출해 가져온다. `.svelte` 컴포넌트는 그대로(데이터 prop 동일, `$app/navigation` 의 `goto`/`invalidate` 가 SPA 모드에서 동작).

### 공용 타입

요청/응답 형태는 `src/lib/api/*.ts`(`chat`, `characters`, `styles`, `keys`, `profile`, `import`, `admin`, `pages`)에 정의해 **Worker(생산)와 SPA(소비)가 공유**한다.

### 이미지 서빙

기본은 같은 Worker 의 `/img/[...key]`(Hono `imgRouter`)가 `env.IMAGES`(R2)에서 읽어 서빙한다(엣지 캐시 `caches.default` + etag/304, `?v=` 있으면 immutable). `PUBLIC_IMAGE_BASE` env 를 주면 R2 공개 커스텀 도메인으로 직접 서빙하도록 전환할 수 있다(`imgSrc`/`IMAGE_BASE`).

---

## 스택

| 영역 | 선택 |
|---|---|
| 호스팅/런타임 | **단일 Cloudflare Worker** `havenchats`(Hono 백엔드 + Workers Static Assets 프론트) |
| 프론트 | SvelteKit(Svelte 5 runes) **정적 SPA**(`@sveltejs/adapter-static`, `ssr=false`) → `build/` |
| LLM | Vercel AI Gateway (AI SDK v6 `ai` + `@ai-sdk/gateway`), 스트리밍 |
| DB | **Cloudflare D1**(SQLite), raw prepared statements. `DB` 네이티브 바인딩 |
| 이미지 | **Cloudflare R2**(`haven-images`, `IMAGES` 바인딩). `/img/[...key]` 라우트로 서빙 |
| 인증 | Google OAuth(`arctic`) + 서명 쿠키(stateless, HMAC-SHA256) |

> 런타임은 Workers = Web 표준 API. env는 `$env/dynamic/private`(서버)·`$env/dynamic/public`(클라) → wrangler `alias` 로 `src/lib/server/env.ts` shim 에 매핑.

## 환경 변수

`.env`(로컬) / Cloudflare Worker secret·var(prod):

- `AUTH_SECRET` — 세션 서명
- `KEY_SECRET` — 유저 외부 API 키 양방향 암호화(AES-GCM). 미설정 시 `AUTH_SECRET` 폴백
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`(선택)
- `ALLOWED_EMAILS` — 로그인 허용 이메일(쉼표). 미설정 시 기본 1명만 허용
- `AI_GATEWAY_API_KEY` — 없으면 mock 스트리머 폴백
- **`PUBLIC_IMAGE_BASE`**(선택) — 이미지 서빙 베이스(예: R2 공개 도메인). 비면 같은 Worker 의 `/img` 라우트
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — wrangler용(D1 마이그레이션·Worker 배포)

> 바인딩·secret·var 는 모두 Worker 의 단일 `env` 객체로 들어와 `env.ts` shim 을 통해 읽힌다. (D1·R2 는 wrangler.jsonc 바인딩, 문자열 secret 은 `wrangler secret put`.)

## 명령어

```bash
# 로컬 개발 (터미널 2개)
npm run dev:worker   # 터미널1: wrangler dev (:8787, 로컬 D1/R2 바인딩 + Hono API)
npm run dev          # 터미널2: vite (:5173, SPA HMR — /api·/auth·/img 를 :8787 로 프록시)

npm run check        # svelte-check + tsc -p worker/tsconfig.json (커밋/배포 전 필수)
npm run build        # vite → adapter-static → build/

# 배포 (worker 번들 + Static Assets 업로드)
npm run deploy       # = npm run build && wrangler deploy

# prod secret 등록
npx wrangler secret put <KEY>

# D1 마이그레이션
export $(grep -E '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=' .env | xargs)
npx wrangler d1 migrations apply haven --local    # 로컬
npx wrangler d1 migrations apply haven --remote   # 원격
```

## 인프라

- **Cloudflare Worker** `havenchats`: Hono 백엔드 + Workers Static Assets(`build/`). 커스텀 도메인 `havenchats.com` 연결.
- **Cloudflare D1** `haven`(id `b8c2b1a3-78e8-4527-aefa-461bcd3486b7`, APAC/ICN) — `DB` 바인딩.
- **Cloudflare R2** `haven-images` — `IMAGES` 바인딩. 서빙은 `/img/[...key]`.
- **Google OAuth** 승인 redirect: `https://havenchats.com/auth/google/callback`(+ `http://localhost:5173/auth/google/callback`).

> ⚠️ `.env`의 `CLOUDFLARE_API_TOKEN`은 D1·R2·Workers 스크립트 권한만 있고 **Zone DNS / Zone Settings / Workers Routes 편집 권한은 없음** → DNS 레코드 변경 등은 대시보드에서 해야 함.
