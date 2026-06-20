# 캐릭터 AI 채팅 서비스 — 아키텍처 설계

> babechat / caveduck 류 캐릭터 롤플레이 채팅 서비스
> Stack: **단일 Cloudflare Worker (Hono 백엔드 + 정적 SPA) + Vercel AI Gateway + D1·R2**
> 작성일: 2026-06-03 / 상태: Draft v1

---

## 1. 목표와 범위

### 1.1 제품 한 줄 정의
유저가 AI 캐릭터(페르소나)를 만들고, 그 캐릭터와 지속적인 롤플레이/대화를 나누는 서비스. 대화는 캐릭터 설정 + 유저 페르소나 + 장기 기억에 기반해 일관성을 유지한다.

### 1.2 핵심 결정사항 (확정)
| 항목 | 결정 | 비고 |
|---|---|---|
| 호스팅/런타임 | **단일 Cloudflare Worker** (Hono 백엔드 + Workers Static Assets) | name `havenchats`, main `worker/src/index.ts` |
| 프론트 | SvelteKit **정적 SPA** (`@sveltejs/adapter-static`, `ssr=false`) | 빌드 결과 `build/` 를 Static Assets 로 서빙 |
| LLM 게이트웨이 | Vercel AI Gateway | 멀티 프로바이더 라우팅·폴백·비용추적 |
| 1차 저장소 | Cloudflare D1 (SQLite) | `DB` 네이티브 바인딩, raw prepared statements |
| 이미지 저장소 | Cloudflare R2 (`haven-images`) | `IMAGES` 네이티브 바인딩, `/img/[...key]` 서빙 |
| 인증 | Google OAuth | Arctic + 서명 쿠키(stateless) 세션 |
| 콘텐츠 수위 | **NSFW 포함 (성인)** | 모델 라우팅 + 연령 게이트 필수 |

### 1.3 MVP에 들어가는 것 / 빠지는 것
- **들어감**: Google 로그인, 캐릭터 생성/탐색, 1:1 채팅(스트리밍), 대화 히스토리, 단기 기억(최근 N턴 + 롤링 요약), 연령 게이트, NSFW 모델 라우팅, 기본 사용량 집계.
- **빠짐(추후)**: 결제/크레딧, 장기 기억 벡터 검색(Vectorize), 캐릭터 공개 마켓/평점, 멀티 캐릭터 그룹챗, 이미지 생성, 음성.

---

## 2. 기술 스택 결정 근거 & 주의점

### 2.1 단일 Cloudflare Worker (가장 중요한 제약)
- 백엔드는 **Hono** 앱(`worker/src/index.ts`)으로, **Workers 런타임**에서 돈다 → **Node.js API 사용 불가**. `fs`, `crypto`(Node판), `Buffer` 등 의존 라이브러리는 쓸 수 없다. **Web 표준 API**(`fetch`, `crypto.subtle`, `ReadableStream`, `TextEncoder`)만 사용.
- 라우팅: wrangler `assets.run_worker_first` 에 등록된 `/api/*`·`/auth/*`·`/img/*` 만 Worker(Hono)로 가고, 그 외(정적 파일·SPA 네비게이션)는 **Workers Static Assets**(`build/`)가 직접 서빙(`not_found_handling: "single-page-application"`).
- 바인딩(D1 `DB`, R2 `IMAGES`, `ASSETS`)·secret·var 는 모두 Worker fetch 핸들러의 단일 `env` 객체로 들어온다. 진입 시 `setRuntime(env, ctx)` 로 요청 컨텍스트에 연결하고, 기존 server 코드가 쓰던 `$env/dynamic/private`·`$env/dynamic/public` 는 wrangler `alias` 로 **`src/lib/server/env.ts`(shim)** 에 매핑돼 무수정 동작한다.
- 라이브러리 선택 기준: "edge / Workers 호환" 여부를 항상 먼저 확인.
  - OAuth: **Arctic** (edge 호환, Node 비의존)
  - 비번 해싱(이메일 인증을 추후 추가할 경우): `crypto.subtle` 기반 또는 `@oslojs/crypto` (Workers 호환). bcrypt(native) ❌

### 2.2 Vercel AI Gateway
- OpenAI 호환 + 전용 `ai` SDK(Vercel AI SDK) 프로바이더 둘 다 지원. **Vercel AI SDK의 `streamText`** 를 쓰면 스트리밍·툴콜·토큰 usage 처리가 가장 깔끔하다.
- 한 개의 API 키로 여러 모델(Anthropic / OpenAI / Google / 오픈웨이트 호스팅 등)에 라우팅. **모델 폴백**과 **요청별 비용·토큰 usage** 를 게이트웨이가 제공 → 사용량 집계에 활용.
- ⚠️ **NSFW 관련 핵심 제약**: Anthropic·OpenAI·Google 등 메이저 프로바이더는 사용정책상 노골적 성인물 생성을 제한한다. 따라서 NSFW 트래픽은 **이를 허용하는 오픈웨이트/전용 호스팅 모델**로 라우팅해야 한다. 어떤 모델이 가능한지는 **AI Gateway의 현재 모델 카탈로그와 각 프로바이더 약관을 배포 전 반드시 확인**해야 하며, 본 설계는 "모델을 설정으로 교체 가능하게" 추상화하는 것으로 이 불확실성을 흡수한다(§7, §8).

---

## 3. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                  Browser (정적 SPA, Svelte)                   │
│   - 채팅 UI / 캐릭터 빌더 / 탐색                               │
│   - +page.ts/+layout.ts 클라 로더가 /api/* 를 fetch          │
│   - 토큰 스트리밍 수신(fetch stream)                          │
└───────────────┬─────────────────────────────┬────────────────┘
                │ HTTPS                         │ /api·/auth·/img
                ▼                               ▼
┌──────────────────────────────────────────────────────────────┐
│           단일 Cloudflare Worker `havenchats`                  │
│                                                                │
│  [run_worker_first 밖] Static Assets(build/) ─ SPA·정적파일 서빙│
│                                                                │
│  [run_worker_first: /api,/auth,/img] Hono 앱                  │
│   미들웨어 ── 세션 검증(쿠키→D1) → c.var.user, 차단유저 차단  │
│   onError ── HttpError→JSON, Redirect→{redirect} JSON         │
│                                                                │
│  worker/src/routes/                                           │
│   ├─ /auth/*    OAuth 시작/콜백/로그아웃 (Arctic)            │
│   ├─ /img/*     R2 오브젝트 서빙(엣지캐시+etag)              │
│   └─ /api/*     chat(스트림)·characters·styles·keys·profile  │
│                 ·import·admin·pages(/me,/home,/user)         │
│                                                                │
│  src/lib/server/  auth · db(raw D1) · imageStore(R2) · ai     │
│  src/lib/api/     요청/응답 공용 타입(Worker↔SPA 공유)       │
└───────┬───────────────────────────────┬──────────────────────┘
        │ env.DB / env.IMAGES (네이티브)  │
        ▼                                ▼
   ┌──────────────────┐          ┌──────────────────┐
   │ D1 `haven` (SQL) │          │ Vercel AI Gateway │
   │ R2 `haven-images`│          │  → LLM providers  │
   └──────────────────┘          └──────────────────┘
```

### 3.1 채팅 요청 시퀀스
```
1. Client → POST /api/chat { conversationId, content }
2. Hono 미들웨어가 세션 검증 → c.var.user 확정 (미인증 401)
3. 연령 게이트 확인: user.age_verified == true 인지 (NSFW 캐릭터인 경우 필수)
4. 메시지 저장 (role=user) → D1
5. 프롬프트 빌더:
     system  = 캐릭터 정의 + 유저 페르소나 + 롤링 요약 + 가드레일
     history = 최근 N턴 (D1에서 로드)
6. 모델 라우터: 캐릭터.content_rating → 적합 모델 선택 (§7)
7. AI SDK streamText(model, messages) → ReadableStream
8. 서버는 스트림을 클라이언트로 그대로 패스스루(SSE), 동시에 누적
9. 스트림 종료 시:
     - assistant 메시지 저장 → D1
     - usage(토큰/비용) 기록 → D1 (usage_events)
     - 턴 수가 임계치 넘으면 비동기 요약 트리거 (ctx.waitUntil)
```

> Workers는 응답 후에도 `ctx.waitUntil(promise)` 로 백그라운드 작업(요약/usage flush)을 안전하게 끝낼 수 있다. 코드에선 `getWaitUntil()`(`src/lib/server/waitUntil.ts`)이 진입 시 연결된 `ExecutionContext.waitUntil` 을 감싸 호출한다.

---

## 4. 데이터 모델 (D1 / SQLite)

> 모든 테이블은 추상화 인터페이스 뒤에 있으므로, Postgres 이전 시 타입 매핑만 바꾼다(§5).

### 4.1 ERD (개념)
```
users ──< oauth_accounts
users ──< sessions
users ──< personas            (유저가 자기 자신을 묘사하는 페르소나)
users ──< characters          (creator)
characters ──< conversations >── users (참여자)
conversations ──< messages
conversations ──1 conversation_memory   (롤링 요약 1행)
users ──< usage_events
```

### 4.2 스키마 (요약 DDL)
```sql
-- 유저
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- uuid/cuid
  email         TEXT UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  age_verified  INTEGER NOT NULL DEFAULT 0, -- 0/1, NSFW 접근 게이트
  nsfw_enabled  INTEGER NOT NULL DEFAULT 0, -- 유저 설정상 NSFW 노출 동의
  created_at    INTEGER NOT NULL,           -- epoch ms
  updated_at    INTEGER NOT NULL
);

-- OAuth 계정 연결 (provider별)
CREATE TABLE oauth_accounts (
  provider           TEXT NOT NULL,         -- 'google'
  provider_user_id   TEXT NOT NULL,
  user_id            TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, provider_user_id)
);

-- 세션 (KV에 둘 수도 있으나, 단순성 위해 D1도 가능)
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,             -- 해시된 토큰
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL
);

-- 캐릭터 정의
CREATE TABLE characters (
  id            TEXT PRIMARY KEY,
  creator_id    TEXT REFERENCES users(id),
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  tagline       TEXT,                        -- 짧은 소개
  description   TEXT,                         -- 공개 설명
  persona       TEXT NOT NULL,               -- 시스템 프롬프트에 들어갈 캐릭터 설정
  greeting      TEXT,                         -- 첫 인사 메시지
  example_dialogs TEXT,                       -- JSON: few-shot 예시 대화
  content_rating TEXT NOT NULL DEFAULT 'sfw', -- 'sfw' | 'nsfw'
  visibility    TEXT NOT NULL DEFAULT 'private', -- 'private'|'unlisted'|'public'
  tags          TEXT,                         -- JSON 배열
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 유저 페르소나 (대화 시 "나"의 설정)
CREATE TABLE personas (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

-- 대화 세션
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  character_id  TEXT NOT NULL REFERENCES characters(id),
  persona_id    TEXT REFERENCES personas(id),
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 메시지
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL,             -- 'user'|'assistant'|'system'
  content         TEXT NOT NULL,
  token_count     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

-- 대화별 롤링 요약 (장기 기억 1차 구현)
CREATE TABLE conversation_memory (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  summary         TEXT,                      -- 누적 요약본
  summarized_upto INTEGER,                   -- 어느 message.created_at까지 요약했는지
  updated_at      INTEGER NOT NULL
);

-- 사용량/비용 집계 (게이트웨이 usage 기록)
CREATE TABLE usage_events (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT,
  model           TEXT NOT NULL,
  prompt_tokens   INTEGER,
  completion_tokens INTEGER,
  cost_usd        REAL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_usage_user ON usage_events(user_id, created_at);
```

### 4.3 설계 메모
- **시간은 epoch ms(INTEGER)** 로 통일 → SQLite/Postgres 이식 쉬움.
- **JSON 컬럼**(example_dialogs, tags)은 TEXT에 직렬화. Postgres 이전 시 `jsonb`로 승격 가능.
- `messages`는 가장 빠르게 커지는 테이블 → 인덱스 `(conversation_id, created_at)` 필수. 히스토리 로드는 항상 conversation 스코프 + LIMIT.

---

## 5. 데이터 접근 추상화 (D1 → Postgres 확장 경로)

### 5.1 전략: Repository 인터페이스 + 드라이버별 구현
ORM(Drizzle)이 D1·Postgres를 모두 지원하지만 **dialect가 다르다**(sqlite vs pg). 그래서 ORM에 직접 의존하지 않고, **도메인 단위 Repository 인터페이스**를 경계로 둔다. 애플리케이션 코드는 인터페이스만 알고, 구현체(D1/PG)는 부트스트랩에서 주입한다.

```ts
// lib/server/repositories/types.ts  — 애플리케이션이 의존하는 유일한 계약
export interface MessageRepo {
  listRecent(conversationId: string, limit: number): Promise<Message[]>;
  append(msg: NewMessage): Promise<Message>;
}
export interface CharacterRepo { /* ... */ }
export interface ConversationRepo { /* ... */ }
export interface UserRepo { /* ... */ }
export interface MemoryRepo { /* ... */ }
export interface UsageRepo { /* ... */ }

export interface Repositories {
  users: UserRepo;
  characters: CharacterRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  memory: MemoryRepo;
  usage: UsageRepo;
}
```

```ts
// lib/server/repositories/d1/index.ts  — 현재 구현
export function createD1Repositories(db: D1Database): Repositories { /* Drizzle(sqlite) */ }

// lib/server/repositories/pg/index.ts  — 추후
export function createPgRepositories(sql: NeonClient): Repositories { /* Drizzle(pg) */ }
```

```ts
// hooks.server.ts 에서 요청마다 주입
const repos = createD1Repositories(event.platform.env.DB);
event.locals.repos = repos;   // 라우트는 locals.repos 만 사용
```

### 5.2 효과
- 라우트/서비스 레이어는 **D1을 전혀 모른다** → 나중에 `createPgRepositories`로 바꾸면 끝.
- 마이그레이션은 점진 가능: 일부 테이블만 PG로 옮기고 라우팅(예: messages만 PG)도 인터페이스 뒤에서 처리.
- 마이그레이션 파일은 Drizzle Kit으로 dialect별 관리(`drizzle/sqlite/`, `drizzle/pg/`).

### 5.3 주의
- SQLite/PG 타입 차이: boolean(INTEGER 0/1 ↔ boolean), JSON(TEXT ↔ jsonb), 시퀀스/PK 생성(앱에서 cuid/uuid 생성으로 통일하여 DB 자동증가 의존 제거).
- 트랜잭션: D1은 배치(batch) 위주, PG는 완전한 트랜잭션. Repository 인터페이스에 `tx(fn)` 같은 추상을 두되 D1 구현은 batch로 근사.

---

## 6. 인증 (Google OAuth)

### 6.1 라이브러리
- **Arctic** (OAuth 2.0, edge 호환) — Google authorization code + PKCE.
- 세션은 **자체 관리**: 랜덤 토큰 생성 → SHA-256 해시를 `sessions.id`로 저장, 원본은 `HttpOnly; Secure; SameSite=Lax` 쿠키. (KV에 저장하면 만료 TTL 자동 처리 가능 — 트래픽 커지면 KV 권장)

### 6.2 플로우
```
/auth/google           → state+codeVerifier 쿠키 세팅, Google 인증 URL로 redirect
/auth/google/callback  → code 검증 → Google 유저정보 fetch
                          → oauth_accounts 조회/없으면 users+oauth_accounts 생성
                          → 세션 생성 → 쿠키 세팅 → / 로 redirect
hooks.server.ts        → 매 요청 쿠키→세션 검증→ locals.user (+ 만료 슬라이딩 갱신)
/auth/logout           → 세션 삭제 + 쿠키 제거
```

### 6.3 연령 게이트 (NSFW 전제)
- 가입 직후 또는 NSFW 캐릭터 첫 접근 시 **연령 확인 단계**(`users.age_verified`).
- 단순 체크박스 self-attestation은 최소선이며, 결제·법적 요건에 따라 더 강한 인증(생년월일/외부 연령확인)이 필요할 수 있음 → §9.

---

## 7. 채팅 파이프라인 & 프롬프트 구성

### 7.1 프롬프트 레이어
```
[system]
  1) 글로벌 가드레일/포맷 지침 (말투, OOC 금지, 길이 등)
  2) 캐릭터 정의: characters.persona (+ name, greeting 톤)
  3) 유저 페르소나: personas.description ("상대(유저)는 …")
  4) 장기 기억: conversation_memory.summary
  5) (few-shot) characters.example_dialogs
[messages]
  최근 N턴 (messages, role 유지). N은 모델 컨텍스트·비용으로 튜닝.
[user]
  이번 입력
```

### 7.2 컨텍스트 윈도우 관리
- 최근 N턴 + 롤링 요약 조합으로 **컨텍스트 무한 증가 방지**.
- 토큰 예산 = 모델 max - (system + 요약 + 응답 여유). 초과하면 오래된 턴부터 드롭.
- N턴이 임계치(예: 20턴)를 넘기면 **오래된 구간을 요약에 흡수**시키고 `summarized_upto` 갱신.

### 7.3 스트리밍 (Workers)
```ts
// routes/api/chat/+server.ts (개념)
export async function POST({ request, locals, platform }) {
  const { conversationId, content } = await request.json();
  const ctx = buildContext(locals.repos, conversationId);     // 캐릭터/기억/히스토리
  await locals.repos.messages.append({ ...userMsg });

  const model = routeModel(ctx.character.content_rating, locals.user); // §8
  const result = streamText({
    model,
    system: buildSystemPrompt(ctx),
    messages: ctx.history,
    onFinish: ({ text, usage }) => {
      platform.context.waitUntil((async () => {
        await locals.repos.messages.append({ role: 'assistant', content: text, ... });
        await locals.repos.usage.record({ ...usage, userId: locals.user.id });
        await maybeSummarize(locals.repos, conversationId);
      })());
    }
  });
  return result.toTextStreamResponse(); // SSE 스트림을 클라이언트로
}
```

---

## 8. AI Gateway 연동 & 모델 라우팅 (NSFW 핵심)

### 8.1 모델 추상화
```ts
// lib/server/ai/models.ts
type Tier = 'sfw' | 'nsfw';
interface ModelSpec { id: string; provider: string; maxTokens: number; }

// 환경변수/설정으로 주입 → 코드 수정 없이 모델 교체 가능
const REGISTRY: Record<Tier, ModelSpec[]> = {
  sfw:  [ /* 메인스트림 모델: 품질 좋은 instruct 모델 */ ],
  nsfw: [ /* 성인 콘텐츠 허용 호스팅 모델 (배포 전 카탈로그/약관 확인) */ ],
};

export function routeModel(rating: Tier, user: User) {
  if (rating === 'nsfw') {
    requireAgeVerified(user);            // 게이트
    return pickWithFallback(REGISTRY.nsfw);
  }
  return pickWithFallback(REGISTRY.sfw);
}
```

### 8.2 폴백 / 가용성
- AI Gateway의 다중 프로바이더 라우팅으로 1차 모델 실패 시 동급 모델로 폴백.
- 라우터는 `[primary, fallback...]` 순서를 tier별로 보유. 429/5xx 시 다음 후보.

### 8.3 비용·사용량
- `onFinish`의 `usage`(prompt/completion tokens) + 게이트웨이가 주는 비용을 `usage_events`에 적재 → 유저별 일/월 집계, 추후 크레딧제의 기반.

### 8.4 ⚠️ NSFW 검증 항목 (배포 전 필수)
1. AI Gateway 현재 카탈로그에서 **성인 콘텐츠를 허용하는 모델**이 무엇인지 확인.
2. 해당 모델/프로바이더 **이용약관**이 이 용도를 허용하는지 확인(메이저 3사는 대개 불가).
3. 불충분하면 **별도 호스팅 경로**(전용 inference 프로바이더)를 게이트웨이에 추가하거나 직접 연동하는 대안 설계.
> 이 불확실성 때문에 모델을 "레지스트리+설정"으로 분리해 둔 것. 코드 변경 없이 교체 가능.

---

## 9. NSFW / 콘텐츠 정책 & 컴플라이언스

> 성인 텍스트 콘텐츠는 합법이지만 **운영상·법적·결제상 요구사항**이 따라온다. MVP에 최소 골격을 넣고 단계적으로 강화.

- **연령 게이트**: `age_verified` 없이는 NSFW 캐릭터/대화 접근 불가. 가입 시 self-attestation은 최소선, 결제 도입 시 강한 연령확인 필요 가능.
- **금지 콘텐츠 가드레일**: 시스템 프롬프트 + 입력/출력 필터로 **미성년자 성적 묘사 등 불법 콘텐츠 절대 차단**. 캐릭터 나이 메타데이터를 강제(성인만)하고, 위반 패턴 탐지.
- **결제 프로세서 정책**: 성인 콘텐츠는 PG사 정책 영향이 큼 → 결제 도입 단계에서 성인 콘텐츠 허용 PG 선정 필요.
- **지역/약관**: 서비스 약관·개인정보처리방침, 신고/차단 기능, 호스팅·모델 프로바이더 약관 준수.
- **데이터 민감도**: 대화는 민감정보. 저장 최소화 옵션, 삭제 요청 처리(계정/대화 삭제 API) 설계에 포함.

---

## 10. 디렉토리 구조

```
havenchats.com/
├─ docs/
│  └─ ARCHITECTURE.md
├─ migrations/               # D1 마이그레이션 (0001~)
├─ worker/
│  ├─ tsconfig.json
│  └─ src/
│     ├─ index.ts            # Hono 앱: setRuntime, 세션 미들웨어, 라우터 마운트, onError, ASSETS 폴백
│     ├─ context.ts          # AppEnv 타입(c.env 바인딩 / c.var.user), requireUser
│     └─ routes/
│        ├─ auth.ts          # /auth/* (arctic google, 로그인/콜백/로그아웃)
│        ├─ img.ts           # /img/* (R2 서빙 + 엣지캐시/etag)
│        ├─ api.ts           # /api/* 라우터 조합
│        └─ api/             # chat·characters·styles·keys·profile·import·admin·pages
├─ src/
│  ├─ lib/
│  │  ├─ api/                # 요청/응답 공용 타입 + load.ts(loadJson) — Worker↔SPA 공유
│  │  ├─ server/
│  │  │  ├─ env.ts           # $env/dynamic/* shim(alias 매핑), setRuntime/getRuntimeEnv
│  │  │  ├─ waitUntil.ts     # getWaitUntil → ExecutionContext.waitUntil
│  │  │  ├─ auth.ts          # arctic google, 세션 토큰 sign/verify
│  │  │  ├─ db/              # raw D1 (users/characters/chats/styles/userKeys/admin) + remote.ts(getDB)
│  │  │  ├─ images.ts        # getImages → env.IMAGES
│  │  │  └─ ...              # crypto, novelai, imageStore, characterForm 등
│  │  └─ components/         # 채팅 UI, 캐릭터 카드 등
│  └─ routes/
│     ├─ +layout.{svelte,ts}          # ts=universal 로더(loadJson '/api/me'), ssr=false
│     ├─ +page.{svelte,ts}            # 홈/탐색 (로더가 /api/home 호출)
│     ├─ chat/[id]/...                # 채팅(클라 로더)
│     └─ ...                          # create·characters·user·styles 등 (모두 +page.ts)
├─ wrangler.jsonc            # name, main(worker), assets(Static), alias, D1/R2 바인딩
├─ svelte.config.js          # @sveltejs/adapter-static (fallback index.html)
├─ vite.config.ts            # SPA dev 서버 + /api·/auth·/img → :8787 프록시
└─ package.json
```

---

## 11. 환경/바인딩 설정

### 11.1 wrangler.jsonc (실제)
```jsonc
{
  "name": "havenchats",
  "main": "worker/src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  // 정적 SPA(adapter-static 빌드 결과)를 ASSETS 로 서빙.
  // /api,/auth,/img 만 Worker 로, 나머지는 Static Assets 직접 서빙.
  "assets": {
    "directory": "./build",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/auth/*", "/img/*"]
  },
  // SvelteKit 별칭을 Worker 빌드(esbuild)에서도 해석. $env/dynamic/* → env shim.
  "alias": {
    "$lib": "./src/lib",
    "$env/dynamic/private": "./src/lib/server/env.ts",
    "$env/dynamic/public": "./src/lib/server/env.ts"
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "haven", "database_id": "<id>", "migrations_dir": "./migrations" }
  ],
  "r2_buckets": [
    { "binding": "IMAGES", "bucket_name": "haven-images" }
  ],
  "observability": { "enabled": true }
}
```

### 11.2 시크릿/환경변수
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway 키 (없으면 mock 스트리머 폴백)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`(선택)
- `AUTH_SECRET` — 세션 서명. `KEY_SECRET` — 외부 API 키 암호화(미설정 시 `AUTH_SECRET` 폴백)
- `ALLOWED_EMAILS` — 로그인 허용 이메일(테스트용 화이트리스트)
- `PUBLIC_IMAGE_BASE`(선택) — 이미지 서빙 베이스(비면 `/img` 라우트)
- 로컬은 `.env`(또는 wrangler `.dev.vars`), 배포는 `wrangler secret put`. 바인딩·secret·var 가 모두 단일 `env` 객체로 들어와 `env.ts` shim 으로 읽힌다.

### 11.3 런타임 타입
`worker/src/context.ts` 의 `AppEnv` 가 Hono 앱 타입(바인딩 `c.env` + 요청변수 `c.var.user`)을 정의한다. 바인딩 형태는 `src/lib/server/env.ts` 의 `WorkerEnv`(`DB`, `IMAGES`, `ASSETS`, …)에 선언.
```ts
// worker/src/context.ts
export type AppEnv = {
  Bindings: WorkerEnv;                       // DB / IMAGES / ASSETS / secrets / vars
  Variables: { user: UserProfile | null };   // 세션 미들웨어가 채움
};
```

---

## 12. 보안 / 레이트리밋 / 남용 방지
- **인증·인가**: 모든 `/api/*`는 `locals.user` 확인. 리소스 소유권 검증(대화/캐릭터의 user_id 일치).
- **레이트리밋**: 유저/IP별 채팅 요청 카운터를 KV(TTL) 또는 DO로. 무료 티어 일일 한도.
- **입력 검증**: 메시지 길이 제한, 캐릭터 필드 길이 제한(프롬프트 인젝션·비용 폭증 방지).
- **시스템 프롬프트 보호**: 캐릭터 persona는 유저 입력을 신뢰하지 않고 분리. OOC 탈옥 시도 대비 가드레일.
- **쿠키**: HttpOnly + Secure + SameSite=Lax, 세션 만료/회전.

---

## 13. 결제 / 크레딧 (추후)
- `usage_events` 기반으로 **크레딧/토큰제** 또는 **구독제** 구현 가능.
- 성인 콘텐츠 허용 PG 선정이 전제(§9). 모델별 원가(usage 비용)와 판매가 마진 관리.
- 게이트: 무료 일일 한도 → 초과 시 결제 유도.

---

## 14. 배포 / CI
- 빌드: `npm run build`(vite → adapter-static → `build/`). 배포: `npm run deploy`(= build 후 `wrangler deploy` — Worker 번들 + Static Assets 업로드).
- D1 마이그레이션: `wrangler d1 migrations apply haven --local|--remote` (수동).
- 시크릿: `wrangler secret put <KEY>`.
- 로컬 개발(터미널 2개): `npm run dev:worker`(wrangler dev :8787, 로컬 D1/R2 + Hono) + `npm run dev`(vite :5173 SPA, `/api`·`/auth`·`/img` 를 :8787 로 프록시). 검증은 `npm run check`(svelte-check + `tsc -p worker/tsconfig.json`).

---

## 15. 단계별 로드맵

| 단계 | 내용 | 산출물 |
|---|---|---|
| **0. 스캐폴드** | SvelteKit(adapter-static SPA) + Hono Worker, wrangler 바인딩/assets | 빈 앱 배포 확인 |
| **1. 인증** | Google OAuth + 세션 + hooks | 로그인/로그아웃 동작 |
| **2. 데이터 레이어** | Drizzle(sqlite) 스키마 + Repository 인터페이스/구현 + 마이그레이션 | D1에 CRUD |
| **3. 캐릭터** | 캐릭터 생성/탐색/상세 | 캐릭터 빌더 |
| **4. 채팅 코어** | AI Gateway 연동 + 프롬프트 빌더 + 스트리밍 1개 동작 | 실제 대화 |
| **5. 기억** | 히스토리 로드 + 롤링 요약 | 일관성 유지 |
| **6. NSFW 라우팅** | 연령 게이트 + 모델 레지스트리/라우터 + 가드레일 | 성인 트래픽 분리 |
| **7. 운영** | 레이트리밋, usage 집계, 삭제 API | 베타 |
| **8+** | 결제/크레딧, Vectorize 장기기억, 마켓/그룹챗 | 확장 |

---

## 16. 열린 질문 / 리스크
1. **NSFW 모델 가용성** — AI Gateway에서 성인 콘텐츠 허용 모델 확보 가능 여부. (배포 전 검증 필수, §8.4)
2. **세션 저장소** — D1 vs KV. 트래픽 예측에 따라. (KV가 만료·읽기성능 유리)
3. **장기 기억 고도화** — 롤링 요약으로 시작, 수요 시 Vectorize 도입.
4. **요약 비용** — 매 임계치마다 LLM 요약 호출 = 추가 비용. 빈도/모델 튜닝 필요.
5. **연령확인 강도** — self-attestation → 결제 도입 시 강화 트리거 정의 필요.
6. **DO 미사용 결정** — 실시간 멀티유저(그룹챗/타이핑)가 로드맵에 들어오면 Durable Objects 재검토.

---

## 부록 A. 의존성 (모두 edge/Workers 호환)
- `hono` (Worker 백엔드 라우터)
- `@sveltejs/adapter-static` (정적 SPA 빌드)
- `arctic` (OAuth)
- `ai` + `@ai-sdk/gateway` (Vercel AI SDK v6 + AI Gateway)
- `fflate` (NovelAI ZIP 해제), `dompurify` (출력 sanitize)
- D1 접근은 raw prepared statements(ORM 미사용)
