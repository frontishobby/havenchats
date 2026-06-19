# Haven (havenchats.com)

캐릭터 AI 채팅 서비스 — **소설 모드** 롤플레이, 성인(NSFW) 포함. 유저가 AI 캐릭터를 골라 1:1로 대화하고 직접 캐릭터를 만들어 공개한다.

- **Prod**: https://havenchats.com
- 제품/도메인 상세 설계: [`CLAUDE.md`](./CLAUDE.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

> SvelteKit(Svelte 5 runes) + Vercel AI SDK v6(AI Gateway). 앱은 **Vercel**에서, 데이터 플레인(D1·R2)은 **Cloudflare**에 둔다.

---

## 호스팅 아키텍처 (2026-06 Cloudflare Pages → Vercel 이전)

원래 전부 Cloudflare Pages(Workers 런타임)에서 돌렸으나, **Workers 무료 플랜의 요청당 10ms CPU 한도**에 부딪혀(메인 SSR이 한도 초과 → `Error 1102`) 호스팅을 **Vercel**로 옮겼다. Vercel 함수는 CPU-ms 벽이 아니라 **벽시계 duration(초)** 한도라 같은 SSR이 정상 동작한다.

핵심 전략: **앱(SSR/API)은 Vercel, 데이터(D1·R2)는 Cloudflare에 그대로 두고 HTTP로 접근.** Vercel은 `platform.env.*` 바인딩을 못 쓰므로, 그 자리를 전부 추상화해 **CF면 네이티브 바인딩, 아니면 원격 HTTP**로 자동 전환되게 했다 — CF로 되돌려도 코드 변경 0.

```
사용자 ──> havenchats.com (Vercel, region icn1=서울)
              │
              ├─ D1 읽기/쓰기 ──HTTP──> d1-worker.havenchats.com (CF Worker) ──> D1 `haven`
              ├─ R2 업로드/삭제 ─HTTP──> d1-worker.havenchats.com (CF Worker) ──> R2 `haven-images`
              └─ 이미지 서빙(읽기) ─────> img.havenchats.com (R2 공개 도메인 + CF Image Transformations)
```

### 추상화 (드롭인 — `platform.env.*` 직접 참조 제거)

| 바인딩 | 추상화 | 위치 | 동작 |
|---|---|---|---|
| `env.DB` (D1) | `getDB(platform)` | `src/lib/server/db/remote.ts` | 네이티브 우선 → `RemoteD1Database`(HTTP) |
| `env.IMAGES` (R2 쓰기) | `getImages(platform)` | `src/lib/server/images.ts` | 네이티브 우선 → `RemoteR2`(HTTP) |
| R2 서빙(읽기) | `imgSrc(key)` / `IMAGE_BASE` | `src/lib/imageBase.ts` | `PUBLIC_IMAGE_BASE` 비면 `/img` 라우트, 있으면 공개 도메인 |
| `context.waitUntil` | `getWaitUntil(platform)` | `src/lib/server/waitUntil.ts` | CF 네이티브 → `@vercel/functions` waitUntil → fire-and-forget |

`svelte.config.js`는 `process.env.VERCEL` 유무로 **adapter-vercel ↔ adapter-cloudflare**를 자동 선택(로컬 dev는 cloudflare 어댑터 + platformProxy로 D1/R2 에뮬레이트).

### 데이터 프록시 Worker (`d1-worker/`)

CF의 D1·R2를 비-Workers 호스트(Vercel)에서 쓰기 위한 **얇은 프록시 Worker**(`haven-d1-api` → `d1-worker.havenchats.com`). D1의 prepare/bind 인터페이스와 R2의 put/delete/list를 HTTP로 미러링한다. 모든 요청은 `Authorization: Bearer <APP_SECRET>` 필요.

```
GET  /health                          헬스체크(인증 불필요)
POST /query/{all,first,run,batch,exec}  D1
PUT  /r2/object?key=<key>             R2 put (바디=바이트, Content-Type=오브젝트 타입)
POST /r2/delete   { keys: string[] }  R2 delete (배열 일괄)
GET  /r2/list?prefix=&cursor=          R2 list → { objects:[{key}], truncated, cursor }
```

배포: `npx wrangler deploy --config d1-worker/wrangler.jsonc` (자세히 `d1-worker/README.md`).

### 이미지 서빙

이미지는 R2 공개 커스텀 도메인 **`img.havenchats.com`**(CF 존)으로 직접 서빙 → egress 무료. 같은 CF 존이라 **CF Image Transformations**(`/cdn-cgi/image/...`, `resized()` 헬퍼)가 그대로 동작(allowed-origins에 `img.havenchats.com` 등록 필요). `/img/[...key]` 라우트는 `PUBLIC_IMAGE_BASE` 미설정 시 CF 폴백으로만 남겨둠.

### CF ↔ Vercel 전환 스위치

env 변수만으로 전환된다(코드 변경 없음):

- **Vercel**: `D1_API_URL`, `D1_API_SECRET`, `PUBLIC_IMAGE_BASE=https://img.havenchats.com` 설정. `platform` 없음 → 자동 원격.
- **CF로 복귀**: 위 env 제거 → `getDB`/`getImages`가 네이티브 바인딩을 잡고, `imgSrc`는 `/img` 라우트 사용.
- **로컬에서 원격 경로 검증**: `D1_FORCE_REMOTE=true`(+ 필요시 `PUBLIC_IMAGE_BASE`)를 `.env`에 임시로.

---

## 스택

| 영역 | 선택 |
|---|---|
| 호스팅/런타임 | **Vercel** (Hobby, region `icn1`, `nodejs22.x`, maxDuration 60) + SvelteKit(Svelte 5) |
| LLM | Vercel AI Gateway (AI SDK v6 `ai` + `@ai-sdk/gateway`), 스트리밍 |
| DB | **Cloudflare D1**(SQLite), raw prepared statements. Vercel에선 프록시 Worker 경유 |
| 이미지 | **Cloudflare R2**(`haven-images`). 서빙 `img.havenchats.com`, 업로드/삭제 프록시 Worker 경유 |
| 인증 | Google OAuth(`arctic`) + 서명 쿠키(stateless, HMAC-SHA256) |

> 런타임은 Web 표준 API 위주(Workers 호환 유지). env는 `$env/dynamic/private`(서버)·`$env/dynamic/public`(클라).

## 환경 변수

`.env`(로컬) / Vercel·CF env:

- `AUTH_SECRET` — 세션 서명
- `KEY_SECRET` — 유저 외부 API 키 양방향 암호화(AES-GCM). 미설정 시 `AUTH_SECRET` 폴백
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`(선택)
- `ALLOWED_EMAILS` — 로그인 허용 이메일(쉼표). 미설정 시 기본 1명만 허용
- `AI_GATEWAY_API_KEY` — 없으면 mock 스트리머 폴백
- **`D1_API_URL`, `D1_API_SECRET`** — 데이터 프록시 Worker(원격 D1·R2). Worker 쪽엔 `APP_SECRET`(=`D1_API_SECRET`)로 등록
- **`PUBLIC_IMAGE_BASE`** — 이미지 서빙 베이스(예: `https://img.havenchats.com`). 비면 `/img` 라우트
- `D1_FORCE_REMOTE` — (로컬 검증용) 네이티브 바인딩이 있어도 원격 강제
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — wrangler용(D1 마이그레이션·Worker 배포)

## 명령어

```bash
npm run dev      # 로컬 (cloudflare 어댑터 + platformProxy로 D1·R2 에뮬레이트)
npm run check    # svelte-check (커밋/배포 전 필수)
npm run build    # 빌드 (VERCEL=1 면 adapter-vercel)

# Vercel 배포 (팀: HavenChats, 프로젝트: havenchats)
vercel deploy --prod --yes

# 데이터 프록시 Worker 배포 (.env의 CF 토큰 export 후)
export $(grep -E '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=' .env | xargs)
npx wrangler deploy --config d1-worker/wrangler.jsonc

# D1 마이그레이션
npx wrangler d1 migrations apply haven --remote
```

## 인프라

- **Vercel**: 팀 `HavenChats`, 프로젝트 `havenchats`, region `icn1`(서울 — D1과 동일 리전으로 프록시 왕복 최소화). 도메인 `havenchats.com`(apex A → `76.76.21.21`).
- **Cloudflare**(데이터 플레인, 존 `havenchats.com` DNS 유지):
  - D1 `haven`(APAC/ICN), R2 `haven-images`
  - Worker `haven-d1-api` → `d1-worker.havenchats.com`
  - R2 공개 도메인 `img.havenchats.com` + Image Transformations
- **Google OAuth** 승인 redirect: `https://havenchats.com/auth/google/callback`

> ⚠️ 현재 `.env`의 `CLOUDFLARE_API_TOKEN`은 D1·R2·Workers 스크립트 권한만 있고 **Zone DNS / Zone Settings / Workers Routes 편집 권한은 없음** → DNS 레코드·Image Transformations allowed-origins 변경은 대시보드에서 해야 함.
