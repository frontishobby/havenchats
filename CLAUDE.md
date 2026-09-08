# Haven (havenchats.com)

캐릭터 AI 채팅 서비스 (babechat / caveduck 류). **소설 모드** 롤플레이, NSFW 포함(성인).
**2026-09-08 부터 서버 없는 정적 1인 모드** — 페이지는 정적 파일이고, 예전 Worker 백엔드(Hono 라우터 + DB 로직)가
**브라우저 안에서** sql.js(SQLite WASM) + IndexedDB 위에서 그대로 돈다. 저장소는 이 기기(IndexedDB) 또는 **Google Drive appDataFolder 동기화**.
로그인·계정 없음: `users` 테이블의 유일한 행이 '나'. 다른 Google 계정으로 Drive 를 연결하면 그 계정의 데이터가 따로 생긴다.

- **Prod**: https://havenchats.com — **GitHub Pages**(`.github/workflows/pages.yml`, main 푸시 시 빌드·배포). DNS 는 Cloudflare 에 그대로(CNAME → `frontishobby.github.io`, DNS only)
- 과거 설계(Worker/D1/R2 시절): `docs/ARCHITECTURE.md` (도메인 로직 설명은 유효)

## 스택

| 영역 | 선택 |
|---|---|
| 호스팅 | **GitHub Pages**(비공개 레포, Pro). `build/` 정적 파일. 딥링크는 `404.html`(= index.html 복사본)로 SPA 진입, `static/.nojekyll`(Jekyll 이 `_app/` 무시 방지), `static/CNAME`. https 오리진 필요(Google OAuth) |
| 프론트 | SvelteKit 정적 SPA(`adapter-static`, `ssr=false`), Svelte 5 |
| '백엔드' | **Hono 앱을 브라우저에서 실행**(`src/lib/local/app.ts`). `app.html` 의 fetch 래퍼가 같은 오리진 `/api/*`·`/img/*` 를 `window.__havenFetch` 로 보내고, `<img src="/img/…">` 는 서비스워커(`static/img-sw.js`)가 IndexedDB 에서 응답 |
| DB | **sql.js(SQLite WASM) 인메모리 + D1 호환 shim**(`src/lib/local/d1.ts`). 스냅샷(`db.export()`)을 IndexedDB `haven-meta.kv.db` 에 디바운스 저장. 스키마는 `migrations/*.sql` 을 그대로 적용(`_migrations` 테이블로 추적) |
| 이미지 | **IndexedDB `haven-images.objects` + R2 호환 shim**(`src/lib/local/r2.ts`). 키 규칙은 예전 R2 와 동일(`char/…`, `charimg/<cid>/<id>.<ext>`, `chatimg/<sid>/<mid>.<ext>`, `style/…`, `avatar/…`) |
| 동기화 | **Google Drive appDataFolder**(`src/lib/local/drive.ts`, `sync.svelte.ts`). GIS 토큰 모델(`drive.appdata` 스코프, 1시간 토큰). `haven.sqlite` 1파일 + 이미지 파일(name=키). 이미지는 **지연 다운로드**(서비스워커가 miss 시 Drive 에서 받아 캐시) |
| LLM | Vercel AI Gateway (AI SDK v6 `ai` + `@ai-sdk/gateway`) — **브라우저가 직접 호출**(CORS 허용 실측). 키는 유저 등록(로컬 DB `user_keys` 평문) |
| 이미지 생성 | NovelAI — 브라우저 직접 호출(기존과 동일). 구독 검증(`api.novelai.net`)은 CORS 불가라 생략 |

## 핵심 규칙 / 함정 (중요 — 작업 전 숙지)

- **브라우저 런타임 = Web 표준 API만**. Node API 금지. `$lib/backend/**` 는 이름만 '백엔드'지 클라 번들이다(`$lib/server` 는 SvelteKit 이 클라 import 를 막아서 개명함). 새 API 는 `src/lib/backend/routes/api/*.ts` 에 Hono 라우트로 추가하면 SPA 의 `fetch('/api/…')` 가 그대로 탄다.
- **런타임 부팅 순서**: `src/hooks.client.ts` `init` → `initLocalRuntime()`(sql.js 로드 → IndexedDB 스냅샷 열기 → 마이그레이션 → users 유일 행 보장 → Hono 앱 → `window.__havenFetch` → 서비스워커 등록·제어권 대기) 이 끝나야 라우트 `load` 가 시작된다. 그 다음 `initStorage()`(Drive 모드면 초기 동기화, 기다리지 않음 — `StorageLanding` 오버레이가 `sync.ready` 까지 덮음).
- **env**: `$env/dynamic/private` 는 없다. `$lib/backend/env.ts` 의 `env` proxy 는 `setRuntime(env, ctx)` 로 넣은 `{ DB, IMAGES }` 만 갖는다. 공개 값은 `$env/dynamic/public`(`PUBLIC_GOOGLE_CLIENT_ID`, 빌드 시 인라인).
- **D1 shim 표면**: `prepare().bind().first/all/run/raw`, `batch`(트랜잭션), `exec`. bind 값은 boolean→0/1·undefined→null 로 정규화. 쓰기 쿼리(`SELECT/WITH/PRAGMA/EXPLAIN` 외)마다 `onWrite` → 400ms 디바운스 스냅샷 저장 + `onDatabaseSaved` 훅(Drive dirty). `waitUntil` 은 그냥 promise 추적(`ctx.pending`).
- **로컬 개발 = 1터미널**: `npm run dev`(vite :5173) 만. 데이터는 그 브라우저 프로필의 IndexedDB. Playwright MCP 프로필엔 구 데이터 1.8GB 가 import 돼 있을 수 있다.
- **이미지 URL 은 그대로 `/img/<key>?v=`**. 서비스워커가 첫 방문엔 아직 페이지를 제어하지 않으므로 런타임이 `controllerchange` 를 최대 3초 기다린다. `resized()` 는 항상 원본 URL(CF 리사이즈 없음).
- **저장소 모드**(`localStorage haven:storage`): `local` | `drive` | 미설정(랜딩). Drive 메타는 IndexedDB kv: `drive:index`(키→파일 id·md5), `drive:db`(**base** — 마지막으로 맞춘 원격 DB), `drive:dbDirty`, `drive:pendingPuts/Deletes`, `drive:deviceId`, `drive:token`(서비스워커용 복사본). **토큰 갱신은 팝업이 필요한데 자동으로 띄우지 않는다**(2026-09-09, 예전 문서 클릭 캡처 자동 갱신 제거 — 1시간마다 팝업이 떠서 불편): 만료되면 `needs-auth` 로 두고 변경은 로컬(dirty)에 쌓인다. 칩 '⚠ 재연결 · 대기 n' → 저장소 모달 '지금 동기화'(`syncNow`, `ensureToken(true)`)를 눌렀을 때만 GIS 팝업. GIS 토큰 모델은 refresh token 이 없고, 코드 플로우는 웹 클라이언트라 client_secret 이 필요(시크릿 보관 서버 없인 불가 — RisuAI 도 `sv.risuai.xyz/drive/token` 서버로 교환) → 서버 없는 지금 구조에선 수동 재연결이 결론.
- **Drive 동기화 설계(2026-09-08 재설계, `sync.svelte.ts` 머리 주석이 정본)**: ① **앱은 로컬 데이터로 즉시 뜬다** — `ready=false` 로 막는 건 모드 미선택·첫 연결인데 로컬이 비어 pull 해야 할 때·첫 연결 충돌만. ② **Drive 가 원본**, 로컬 = base + dirty. ③ 모든 경로(부팅·저장 후 3s 디바운스·주기 확인·'지금 동기화')가 **`reconcile` 하나**로 수렴: 원격 없음→push 생성 / base 없음→로컬 비었으면 pull 아니면 conflict / 원격==base→dirty 면 push / 원격!=base→clean 이면 pull, dirty 면 conflict. push 는 판정 직후 같은 작업 안에서만 → 덮어쓰기 방지(Drive CAS 없음, 작업 길이만큼 경쟁 창). `runOp` 가 직렬화. ④ **이미지는 대기열만** 처리(로컬 전체를 원격과 대조하는 스캔 금지 — 모바일에서 수십 초 먹던 원인). **올릴 때 이미지 먼저, DB 마지막** — 상대 기기는 DB md5 변화를 보고 받아가므로 그때 참조 이미지가 이미 Drive 에 있어야 함. 백업 가져오기만 `reconcileAfterImport` 가 전체를 대기열에 넣음. ⑤ **인덱스 증분 갱신**: pull 뒤 `listChangedSince(lastSyncAt-60s)`(요청 1회)로 바뀐 파일만 합치고, md5 가 달라진 키의 로컬 캐시를 `idb.objDelete` 로 지움(썸네일은 같은 키 `char/<id>.webp` 덮어쓰기라 안 지우면 서비스워커가 옛 파일 서빙; put 대기열 키 제외). 전체 `listAll` 은 첫 연결·'Drive 기준으로 맞추기'·전부 내려받기만. ⑥ **주기 확인**: 보이는 탭에서 20s(타 기기 3분 내 활동 시 8s) + 표시/포커스 전환 즉시(3s 스로틀) `getMeta` 1회 → md5 ≠ base 면 reconcile. `rt.busy`(진행 중 `/api` 요청 — 스트림 본문 끝까지 — 또는 waitUntil)면 pull 보류(`SyncDeferred`). ⑦ **충돌은 화면을 막지 않음**: `status='conflict'` 칩 → 저장소 모달에서 Drive/이 기기 선택(`resolveConflict`), 고르기 전까지 push/pull 정지. 첫 연결 충돌만 랜딩에서 선택. ⑧ **작성 기기 표시**: DB 파일 appProperties `deviceId`/`deviceName`(UA 기반 `Mac · a1b2`) → `sync.writer`/`otherActive` → 칩 '☁ <기기> 사용 중', 모달 '마지막으로 쓴 기기'. ⑨ **'Drive 기준으로 맞추기'**(`resetToDrive`): 대기열·이미지 캐시 전부 비움(`objClear`, 볼 때 재다운로드) → 전체 인덱스 → DB 교체. 올리지 않은 로컬 변경은 버림. 복구용.
- **데이터 규모(2026-09-08 이전분)**: DB 6.4MB, 이미지 7,269개 1.84GB(장면 그리드 6.2k·채팅 이미지 950). 그래서 이미지는 기기마다 전부 복사하지 않고 지연 다운로드하며, 백업 zip 은 fflate 스트리밍(`src/lib/local/backup.ts`, 1.9GB import 11초 실측).
- **Svelte 5 `$state` 배열 함정**: 배열에 push한 객체는 프록시로 감싸짐. 로컬 변수 ref로 mutate하면 반응성 X → **반드시 `arr[idx]`(프록시)로 수정**. (채팅 스트리밍 누적이 이걸로 동작)
- **AI SDK v6 `textStream`은 에러를 throw 안 함**(빈 스트림으로 끝남) → `streamText({ onError })`로 잡아야 함. (`/api/chat` 참고. 에러 시 채팅 버블에 일반 메시지 노출, 상세는 콘솔만)
- **프롬프트 캐싱**: system은 **고정 prefix**(제작자 `description` + 장면 이미지 카탈로그 + 상대(유저) 정보 + 가드레일)로 만들고, 가변 부분(분량·'나' 행동 지침)은 **마지막 유저 메시지 끝에 부착** → prefix 캐싱 유지. **요약(rolling summary) 블록은 system 맨 끝**에 둬서 갱신 전까지 prefix 캐시 재사용. `providerOptions.gateway.caching='auto'`.
- **토큰 전략**(`/api/chat`): ① **sliding window** — `seq > summary_upto_seq` 메시지만 모델에 전송. ② **rolling summary** — window 토큰이 `WINDOW_TOKEN_BUDGET`(6000) 초과 + `KEEP_RECENT`(12) 초과 시 백그라운드 요약(`waitUntil`). ③ **input 하드가드** — 모델 `contextLimit` 기준으로 요청 시점에 오래된 window를 동기적으로 잘라냄(최신은 항상 보존). ④ 단일 유저 메시지 `MAX_USER_MSG_TOKENS`(4000) 초과 시 413 거부.
- **모델 선택은 라우트에서 허용목록(`MODEL_IDS`) 검증** 후 사용. 각 모델은 `contextLimit`(input 가드 기준) 보유.
- **반복 억제**(`/api/chat`): 분량 지침은 '약 N문장 목표(최소 0.7N·최대 N), 반복이 아니라 장면 진행으로 채울 것' + '앞선 응답 문장·문단·상투 묘사 재사용 금지, 매 턴 장면 진행' 규칙을 응답 지침에 포함('최대 N' 상한만 주면 모델이 절반쯤에서 임의로 끊어 30문장 설정이 무의미해짐). DeepSeek·GLM 엔 `repetitionPenalties`(frequency 0.4·presence 0.3) 추가(Anthropic·Google·OpenAI GPT-5.x 추론 모델은 미지원 — SDK `unsupported` 경고만 남기므로 제외). 배경: DeepSeek V4 Pro 장문 세션에서 직전 응답 41문단 중 31문단이 글자 단위 복사되던 실측(2026-09).
- **DeepSeek 공급자 라우팅**(`buildProviderOptions`): 게이트웨이는 DeepSeek 을 11개 공급자 중 가중 추첨으로 고르는데 **Alibaba(Model Studio)는 자체 검열**로 성인 장면을 스트림 본문 에러 JSON(`data_inspection_failed`)으로 거부 → HTTP 에러가 아니라 폴백도 안 타고 `AI_TypeValidationError`(choices 누락)로 끝남(2026-09-06 실측). 또 Alibaba 경유는 frequencyPenalty unsupported. → `gateway.order`+`only: ['deepseek','fireworks','baseten','novita','deepinfra']`(alibaba 제외)로 고정. `order` 는 우선순위만 주고 미기재 공급자를 폴백으로 남기며, `only` 만 주면 목록 안에서 다시 가중 추첨이라 둘 다 필요(2026-09-07 라우팅 메타 실측). Claude 도 같은 이유로 `only: ['anthropic']`(Bedrock 경유 정책 차단 회피). 채팅 버블엔 검열 차단 안내 문구 분기(`isProviderCensorError`), 콘솔 메타 `streamError` 는 cause/value 까지 JSON 직렬화.
- **검열 턴 자동 취소**(`/api/chat`, 모델 무관, babechat 식): 스트림 종료 시 `isCensoredTurn` — finishReason `content-filter` / 공급자 검열 에러 / **모델의 거부 문구**(700자 이하 + "부적절·도와드릴 수 없·I can't assist·content policy…" 상투구 + `이름 | "…"` 대사 마커 없음)면 assistant 저장 안 함(onFinish 도 같은 판정) + 방금 저장한 유저 행 삭제 + 메타 프레임에 `censored:true`. 클라(`ChatView`)는 잠깐 보인 거부 문구·유저 버블을 걷어내고 **입력창에 원문 복원** + `sendError` 안내(표현 바꿔 재전송/모델 교체). 이어가기 턴은 유저 행이 없어 assistant 만 취소.
- **NSFW 검열 회피 프레이밍**(`chatAssembly.ts`, RisuAI '망원경(Lacuna)' 프리셋에서 회피 요소만 발췌, 2026-09-06): "성적 묘사 허용" 같은 직접 문구는 Vertex(Gemini 3.8+) 입력 필터에 걸리므로 쓰지 않는다. NSFW·비imported 캐릭터는 ① system 맨 앞 `<Ai mandate=…/>`(인과 타당 결과는 그대로 렌더링 + 🔞 이모지) + `<Identity=세계 시뮬레이터/>`, ② `# 필수 준수` 의 허용 줄을 '장면 유형 동등 취급 + 의성어' 영어 조항(`NSFW_RENDERING_LINES`)으로 대체, ③ window 맨 앞 assistant **사전 동의 턴**(`NSFW_PREAGREE_TURN`, 오프닝과 한 메시지로 병합) — 이 셋은 **모델 무관 전체 적용**. ④ Gemini 전용 **XML 프레임**(system 전문을 `<Security:InputParsing>`+`<World:Root>` 로 감싼 첫 user 메시지로 접고 입력/로어/지침/기억을 태그로 감싸는 `usesXmlFrame` 경로)은 **`XML_FRAME_ENABLED=false` 로 꺼둠** — 2026-09-06 실측(세션 재생 17회)에서 이 프레임만 텍스트 거부 3회, 프레임 없는 ①~③ 은 10회 전부 정상. 미성년 하드 가드 문구는 그대로 유지. SFW·imported 캐릭터는 변화 없음. Vertex 페일오버 회복 효과는 아직 미실측. 재현 스크립트 패턴: D1 에서 세션 메시지+캐릭터를 뽑아 `buildSystemPrompt`/`buildMessages` 로 변형별 조립 → `.env` 의 `AI_GATEWAY_API_KEY` 로 `generateText` N회(tsx, 레포 안 경로에서 실행해야 `ai` 모듈 해석됨).
- **장면 이미지(축×조합)**: 모델은 응답에 **위치코드**(`{AAB}` — 축별 value index를 A=0,B=1…로) 출력. DB 저장 시 `pinSceneCodes`로 **불변 토큰**(`{#entryId}`)으로 고정(이후 제작자가 축/값 순서 바꿔도 안 흔들림). 렌더러는 두 형식 모두 해석. 유틸은 `lib/imageCodes.ts`(클라/서버 공용 순수함수).
- **그리드 코드 폭 가변**: 축 값 26개 초과면 코드 두 글자(AA~ZZ, 최대 676), 조합 상한 6,000, `ImageAxis.fallback`(없는 조합이면 그 축을 기본값으로 재시도 — 인물×상황 희소 세트용). 대량 업로드는 `POST /api/characters/:id/scenes/bulk` + `scripts/scenes-bulk.mjs`(파일명 `키_키.webp` → combo, `HAVEN_COOKIE` 필요).
- **`{{나}}` 플레이스홀더**: 제작자 프롬프트·오프닝의 `{{나}}` → 유저 이름(없으면 '나')으로 치환.
- **NSFW 주의**: 메인스트림 모델(OpenAI/Anthropic/Google)은 성인물 거부. NSFW엔 허용 모델 필요. 미성년자 묘사 등 불법 콘텐츠 차단 가드레일은 system 프롬프트에 항상 포함.
- **검증은 `npm run check`/build로**. UI 변경마다 Playwright 띄우지 말 것 (사용자 선호).


## 디렉토리

```
src/
  app.html            # SPA 셸 + **fetch 래퍼**(/api·/img → window.__havenFetch, SvelteKit 이 fetch 를 캡처하기 전에 설치) + 부트 스켈레톤
  hooks.client.ts     # init: initLocalRuntime() await → initStorage()(비동기)
  lib/
    local/            # ⭐ 브라우저 런타임('서버' 대체)
      runtime.ts      # 부팅·스냅샷 영속화(flush/replaceDatabase/exportDatabase)·훅(onDatabaseSaved/onObjectsChanged)·서비스워커 등록
      app.ts          # Hono 앱(미들웨어: setRuntime + users 유일 행 → c.var.user) + localFetch
      d1.ts r2.ts     # D1/R2 호환 shim (sql.js / IndexedDB)
      idb.ts          # IndexedDB 헬퍼(haven-meta.kv, haven-images.objects — 서비스워커와 스키마 공유)
      schema.ts       # migrations/*.sql 글롭 적용(_migrations)
      drive.ts        # GIS 토큰 + Drive v3 REST(appDataFolder)
      sync.svelte.ts  # 저장소 모드·동기화 엔진·반응형 상태 `sync`
      backup.ts       # zip 내보내기/가져오기(스트리밍)
    backend/          # 구 Worker 코드(이름만 유지). routes/api/*.ts = Hono 라우터, db/*.ts = raw SQL, chatAssembly·imagePrompt·novelai 등 도메인 로직
      routes/api/     # chat.ts(스트리밍 등 채팅 전체)·characters.ts·styles.ts·modules.ts·keys.ts·profile.ts·import.ts·pages.ts(/me·/home)
      routes/img.ts   # fetch('/img/…') 경로(서비스워커와 별개)
      context.ts      # AppEnv·requireUser(항상 통과)
      env.ts          # setRuntime/getRuntimeEnv + `env` proxy
    api/              # 요청·응답 공용 타입 + loadJson
    components/       # StorageLanding(첫 화면 저장소 선택/재연결/충돌)·StorageModal(상태·동기화·백업)·기존 컴포넌트
    state/            # profileModal/apiKeyModal/storageModal/privacyMode.svelte.ts
    admin.ts nsfw.ts  # isAdmin/canSeeNsfw — 항상 true(1인). 호출부는 남아 있음
  routes/             # 클라 렌더 + universal 로더(변경 없음: /, /create, /import, /characters/[id]/{edit,assets}, /chat/[id](/session/[sid])(/debug), /styles, /modules)
static/img-sw.js      # 이미지 서비스워커(IndexedDB → 없으면 Drive 지연 다운로드)
migrations/           # SQLite 스키마(구 D1 마이그레이션 그대로 사용)
scripts/export-legacy.mjs  # 구 D1 덤프 + havenchats.com/img → 백업 zip
wrangler.jsonc        # assets-only 배포 설정
```

## DB 스키마 (SQLite, 브라우저 안 — 구 D1 스키마 그대로)

- **users**: `id`(uuid PK), `email`(unique), `display_name`(대화용 이름), `avatar_url`(**R2 오브젝트 키** 저장 → `/img/<key>`로 서빙), `age_verified`, `persona`, `preference`('male'|'female'), `created_at`/`updated_at`(epoch ms)
- **oauth_accounts**: `(provider, provider_user_id)` PK → `user_id`
- **characters**(유저 제작): `id`(uuid PK), `creator_id`→users, `name`, `tagline`, `intro`(상세모달 표시용, 프롬프트엔 미포함), `description`(시스템 프롬프트 본문), `thumbnail_key`(카드용 1024², R2 키), `full_image_key`(0028, 상세용 2048² — 저장 시 업스케일, NULL 가능), `audience`('all'|'male'|'female'), `content_rating`('sfw'|'nsfw'), `tags`(JSON), `greetings`(JSON, 오프닝 목록), `image_set`(JSON, 축×조합 장면이미지/NULL), `chats`(누적 대화수), `created_at`/`updated_at`
- **chat_sessions**: `id`(uuid PK), `user_id`, `character_id`(빌트인slug+uuid 혼재 가능 → **FK 미설정**), `model`(마지막 사용), `summary`/`summary_upto_seq`(요약 상태), `message_count`(마지막 seq), `created_at`/`updated_at`/`last_message_at`. `appearances`(JSON, 실시간 이미지 **외형 원장** — 동적 NPC 고정 외형, 주인공·유저 제외), `outfits`(JSON, **복장 원장** — 인물별 현재 복장/노출 상태, 주인공·유저 포함. 상황 프롬프트에 `[Current outfits]`로 주입해 '텍스트가 바꾸지 않으면 그대로 복사' → 옷 벗은 상태가 최근 3턴 창 밖으로 밀려도 유지. 재생성(replaceId)은 읽기만)
- **chat_messages**: `id`(uuid PK), `session_id`→sessions, `seq`(세션 내 1-based), `role`('user'|'assistant'|**'image_generation'**), `content`(image_generation 은 **R2 키**), `token_est`, `input_tokens`(assistant 행에 그 응답 생성 시 input 토큰 실측/추정), `cost`(assistant=추론비용, image_generation=Gemini 상황프롬프트 비용), `created_at`. unique(session_id, seq). **`image_generation` 행은 LLM window/요약에서 제외**(`getWindow`·프리뷰 서브쿼리에서 `role != 'image_generation'`), 표시·페이징엔 포함.
- **user_keys**: `(user_id, provider)` PK, `ciphertext`(이름만 남았고 **평문** 저장), `meta`(JSON: NovelAI `{tier,active,isOpus}`), `created_at`/`updated_at`. provider `'novelai'`·`'gateway'`.
- **art_styles**(그림체 Hub): `id`(uuid PK), `creator_id`→users, `title`, `memo`, `prompt`(화풍 태그), `model`(NovelAI 모델 id, 기본 `nai-diffusion-4-5-full` — 기존 행=V4.5), `negative`/`quality`(NULL 허용, 선택 네거티브·퀄리티 프롬프트 — 0026), `thumbnail_key`(R2 `style/<id>.<ext>` — 고정 표준 장면 SFW 썸네일), `created_at`/`updated_at`
- **art_style_favorites**: `(user_id, style_id)` PK — 채팅 이미지 모달에서 고를 수 있는 후보. `characters.recommended_style_id`(추가됨): 제작자 추천 그림체.
- **prompt_modules**(모듈 Hub, 0027): `id`(uuid PK), `creator_id`→users, `title`, `memo`(표시용, 프롬프트 미포함), `prompt`(본문, ≤4000자), `shared`(1=Hub 공개/0=비공개), `created_at`/`updated_at`. **prompt_module_favorites**: `(user_id, module_id)` PK — 채팅 모듈 모달 후보(내 것 + 즐겨찾기).
- 세션 id = 내부 user uuid. 프로필 완료 = `display_name` 존재. 오프닝(greeting)은 세션 시작 시 seq=1 메시지로 저장(세션별 앵커). **캐릭터 데이터는 세션에 스냅샷하지 않음** — characters 테이블이 source of truth.

- `users`·`oauth_accounts`·`*_favorites`·`visibility`·`shared`·`country`·`preference`·`blocked_reason` 컬럼/테이블은 스키마엔 남아 있지만 1인 모드에선 의미 없음(유저 1행, 전부 내 것). `user_keys.ciphertext` 는 **평문**.

## 구현된 기능

- **메인**: 캐릭터 그리드 + 검색(내 캐릭터 전부). 태그 필터 칩은 제거.
- **캐릭터 제작/관리**: `/create`로 캐릭터 등록(이름·소개·프롬프트·태그·오프닝 다중·썸네일·장면 이미지). 소유자만 수정(`/characters/[id]/edit`)·삭제. 폼/이미지 파싱은 `characterForm.ts`, R2 정리는 `imageStore.ts`.
- **AI 도우미(제작 폼)**: `CharacterAssistPanel`(러프 입력 → `POST /api/characters/assist` — `streamObject` 구조화 출력을 **NDJSON 스트림**(`progress`/`ping`/`done`/`error`, 타입 `AssistStreamEvent`)으로 흘려 폼 채움·기존 내용 보존 수정. 비스트리밍 `generateObject` 시절 12k+ 토큰 응답을 기다리는 동안 어느 홉도 바이트를 안 보내 무한 대기가 났던 것을 고침: 서버 heartbeat 10s·상한 5분·`maxRetries:1`, 클라 60s 무수신 감지·취소 버튼) + `CharacterThumbnailPanel`(NovelAI 썸네일 — **1024×1024 생성**, '이 썸네일 사용'은 webp 로 폼에 등록만 하고 원본 PNG 를 들고 있다가 **저장 시 NAI 2x 업스케일(2048²)** 해 `charfull/<id>.webp` 로 함께 저장(`imageFull` 필드 → `full_image_key`). 카드는 1024, 상세 모달은 2048 을 쓴다. 수동 업로드 썸네일은 업스케일 없음. **연출이 비면 'dressed 모드'**(`directionRequestsUndress` 가 한/영 탈의 신호를 못 찾으면): 시스템 프롬프트가 설정에서 직업·장소·소품·표정을 뽑아 **대표 인물 1~2명의 아이덴티티에 맞는 장면 상반신 컷**을 만들게 하고(의상은 설정대로 존중, 성적 묘사만 무시), 출력단에선 `enforceCardFraming`(full body·하체 강조 조각 제거, 프레이밍 없으면 upper body)과 base_caption nsfw 태그 생략만 한다 — 의상 태그 강제 제거·`fully clothed` 강제는 안 함(설정문 성적 묘사가 새어 들어와 전신 노출 컷이 나오던 문제, 2026-09-08). 패널에서 편집한 프롬프트는 그대로 존중. **자연어 연출**(선택, 한국어) + 설정을 `POST /api/characters/thumbnail` 이 `generateObject` 로 `{ base, scene, characters[] }` 구조화(스키마·sanitizer 는 채팅 이미지와 공용 `lib/server/imagePrompt.ts`) → 인물별 캡션을 NAI `char_captions` 로 분리해 **여러 인물 동시 등장** 가능. 패널에서 base/장면 문장/인물 캡션을 편집해 그림만 다시 뽑거나(`prompt` 전송) '↻ 설정·연출 반영'으로 재생성(`regen`). 상황 프롬프트 모델은 `IMAGE_PROMPT_MODELS`(GLM 5.3 Flash), 미성년 하드차단 동일 적용). **허용 모델 `ASSIST_MODELS`: Claude Opus 4.6·GPT-5.6 Sol·DeepSeek V4 Pro·GLM 5.3 Flash(기본)** — 구조화 출력 안정 모델만(Gemini Flash 는 NSFW 설정 입력 content-filter 로 제외. DeepSeek V4 Pro 는 Opus·Sol 이 NSFW 설정을 거부할 때의 상위 대안 — 2026-09-07 실측 4/4 정상, 30~35s). PC(≥1080px)는 폼 우측 sticky 열, **모바일은 우하단 ✦ FAB → 바텀시트**(탭: 캐릭터 생성/썸네일) — 같은 DOM 인스턴스를 CSS 로만 배치 전환.
- **유저 프로필 페이지**(`/user/[id]`): 공개 프로필 + 제작 캐릭터 목록. 본인이면 전체, 외부 방문자에겐 NSFW 숨김.
- **채팅**: **소설 모드**(말풍선 X, 산문). 괄호 `()`/`*..*` 지시문=기울임, 대사=`발화자 | "대사"`(`|` 제거·이름 강조). **장면 이미지** 인라인 표시(위치코드/핀 토큰). 실시간 스트리밍.
- **대화 영속화**: 세션+메시지 D1 저장. 유저 메시지는 즉시 저장(스트림 끊겨도 유실 방지), assistant는 `onFinish`에 저장. **사이드바 최근 채팅**(`listRecentSessions`, 마지막 대사 미리보기). `/chat/[id]/session/[sessionId]` 경로로 이어가기(구버전 `?s=`도 하위호환). 새 세션은 첫 전송 시 lazy 생성 후 `replaceState`로 세션 URL로 교체(기본은 항상 새 세션).
- **장기 맥락**: sliding window + rolling summary(백그라운드 갱신). 요약은 모달에서 조회/수동 수정 가능(`/api/chat/summary`).
- **채팅 설정 모달**: **모델 선택**(아이콘 드롭다운, 가격 내림차순 7개: Claude Opus 4.6(RP 커뮤니티 합의 최고·검열 최약. Opus 4.8·5 는 하드검열 강화라 제외, 2026-09-07)·Kimi K3·GPT-5.6 Sol·Gemini 3.8 Flash·DeepSeek V4 Pro 0813·GLM 5.3 Flash·DeepSeek V4 Flash 0731(기본)), **답변 길이**(5~30문장 슬라이더), **'나' 행동·대사 생성**(0금지/1적정/2풍부). localStorage 저장.
- **이어가기(자동 진행)**: 입력창을 비운 채 전송 버튼(»)을 누르면 `/api/chat` 에 `continue:true` 로 보내 **유저 메시지 없이** 캐릭터가 직전 장면을 이어 쓴다. 서버는 user 행을 저장하지 않고, `buildMessages` 가 마지막 assistant 뒤에 `CONTINUE_DIRECTIVE`(이어가기 지시)+로어+응답 지침을 합성 user 메시지로 붙인다. DB 엔 assistant 행이 연달아 쌓이므로 `buildMessages` 가 **연속 assistant 를 한 메시지로 병합**해 모델에 보낸다. Enter 는 빈 입력이면 무시(버튼만). 이어갈 assistant 가 없으면(오프닝 없는 새 세션) 400.
- **입력 제안**(전송 버튼 왼쪽 💬): `POST /api/chat/suggest`(`SuggestRequestBody`) — 캐릭터 description·요약·최근 대화 꼬리(8개)·페르소나를 system 에 넣고 **DeepSeek V4 Pro 고정**(`SUGGEST_MODEL_ID`, noThinking)으로 유저가 다음에 할 법한 입력 후보 3개를 번호 목록으로 받아 파싱(`parseSuggestions`). 컴포저 위 칩으로 표시, 클릭 시 **입력창에 채움**(바로 전송 X). 제안 비용은 `pendingSuggestCost` 로 모아 다음 유저 메시지의 `inputCost` 에 합산 기록.
- **입력 필터**(채팅 헤더 🪄 버튼, 🖼 왼쪽): 켜면 컴포저 위에 **지시 한 줄**(예: "무협지 풍으로")이 나타나고, 전송 시 클라가 먼저 `POST /api/chat/rewrite`(`RewriteRequestBody`)로 원문을 보내 서버가 **캐릭터 description(참고)·요약·최근 대화 꼬리(8개)·유저 페르소나**를 system 에 넣고 `generateText`(noThinking) 로 지시 문체로 **다시 쓴 입력문**을 받은 뒤, 그 텍스트로 `/api/chat` 을 호출한다(DB 에는 변환문이 user 메시지로 저장. 변환 비용은 `inputCost` 로 되돌려 보내 user 행 `cost` 에 기록·버블 옆 표시). 변환 중엔 유저 버블에 pending 표시, 실패 시 버블 제거·입력 복원·에러 표시. 변환 모델은 **채팅 모델 목록(MODELS) 전체** 선택 가능(기본 DeepSeek V4 Flash), 설정은 localStorage(`haven:filter:*`). 규칙: 의도·행동·대사 보존, 캐릭터 반응 대필 금지, 분량 ≤1.5배, 미성년 가드.
- **실시간 이미지 생성(NovelAI)**: 채팅 헤더 🖼 버튼으로 켜면(localStorage) 매 assistant 턴 직후 클라가 ① `POST /api/chat/image/prepare` → 서버가 LLM(`generateObject` **구조화 출력**)으로 마지막 응답을 `{ base, scene, characters[{name, appearance, outfit, state}] }` 로 분해(인물 캡션 = 외형 + **outfit**(복장/노출 — 세션 `outfits` 복장 원장으로 턴 간 유지) + state(포즈·표정). `scene`=자연어 장면 1~2문장, V5 만 조립에 사용·V4.5 는 버림. 이 비용이 메시지 cost)·미성년 하드차단·**NovelAI 요청 바디**(`buildGeneratePayload`) 반환 → ② **브라우저가 `image.novelai.net` 을 직접 호출**(`lib/novelaiClient.ts`: `/ai/generate-image-stream` + `parameters.stream='msgpack'` → 4B 길이 프리픽스 + msgpack, intermediate=JPEG 프리뷰·final=PNG. 실패 시 `/ai/generate-image` ZIP 폴백(fflate). 토큰은 `GET /api/keys/novelai/token` 으로 받아 메모리에만) → 최종 PNG 를 **webp 변환**(`lib/imagePreview.ts blobToWebp`: canvas.toBlob → WebKit(사파리·iOS 전 브라우저)은 webp 인코딩 미지원이라 `lib/webpEncode.worker.ts` 의 libwebp WASM(`@jsquash/webp`, ~100KB br) 워커로 폴백. 그림체 워크숍 썸네일·캐릭터 썸네일도 동일 함수) → ③ `POST /api/chat/image/commit?sessionId&replaceId&assistantMsgId&cost` 에 바이너리 업로드 → R2(`chatimg/<sessionId>/<id>.<ext>`) 저장 + `role=image_generation` 메시지 영속. **Worker 는 NovelAI 프레임을 만지지 않는다**(무료 플랜 CPU 10ms 대응 — 예전 서버 SSE→NDJSON 재전송은 요청당 CPU 0.4~1.2s). **NAI 모델은 그림체에 박힌 값**(`art_styles.model`, 허용목록 `lib/naiModels.ts`: V5 Full(기본)·V5 Curated·V4.5 Full — 2026-08-21 V5 출시, 기존 그림체는 마이그레이션 0024 기본값으로 V4.5 마킹). 워크숍 미리보기·썸네일·채팅(`naiModel`) 모두 고른 그림체의 모델로 요청하고, `buildGeneratePayload`가 모델별 `params_version`(V5=4)·CFG(`imageParamsFor`)·퀄리티 꼬리(`qualityTailFor`)를 고른다. NAI **멀티 캐릭터 기능**(`char_captions` 인물별 분리 → 속성 누출 방지), 위치는 AUTO(`use_coords:false`+`use_order`), 인물 최대 V4.5=6·V5=32(모델별 상한), {{나}}는 프레임에 보일 때만 별도 엔트리. **상황 프롬프트 모델은 구조화 출력 안정 + NSFW 비거부 모델로 한정**(`IMAGE_PROMPT_MODELS`: GLM 5.3 Flash(기본)·MiniMax M3 — MODELS 와 별개 목록, `findImagePromptModel` 로 조회. Gemini Flash 는 BLOCK_NONE 에도 노골적 장면 content-filter 라 제외). 해상도(세로 832×1216/정사각 1024×1024/가로 1216×832 — 가로형이면 상황 프롬프트 user 끝에 `[Canvas] LANDSCAPE` 구도 힌트 부착)·**1명 고정**(`solo`, localStorage `haven:img:solo` — 다인 장면에서 NAI 디테일 붕괴 방지. user 끝에 `[Solo]` 힌트(주인공 1명·POV/프레임 밖 처리) + 서버 후처리: 인물 엔트리를 첫 1개로 자르고(`char` 강제 X — 주인공이 육체 없는 AI/내레이터형이면 기기가 그려지는 실측) `enforceCountBase` 로 base 의 인원수·source#/target# 태그 제거 후 `1girl/1boy, solo` 강제. 상황 프롬프트 공통 규칙에 '비육체 주인공은 인물 엔트리 금지, 장면의 실제 인물을 그림' 추가. 하위 토글 **'남성 1명 추가 허용'**(`soloMale`, localStorage `haven:img:soloMale`): `[Solo+1]` 힌트 — 기본 1명, 포옹·정사 등 상대 남성 몸이 프레임에 꼭 필요할 때만 남성 1명(보통 유저)을 2번째 엔트리로 허용. 서버 `pickSoloEntries` 가 '남성 아닌 첫 인물 + 남성 첫 인물' 최대 2명만 남기고, 2명이면 base 를 `1boy, 1girl`(상호작용 태그 유지)로 정리)·**그림체(즐겨찾기에서 택1)**·상황프롬프트 모델·'빠른 생성 우선'은 헤더 모달에서 설정. NSFW 캐릭터면 base_caption 앞에 `rating:nsfw`. 미성년 하드차단은 base+모든 인물 캡션 합본 검사. 캐릭터 description 통짜를 외형 레퍼런스로 LLM 에 주입. 키는 **프로필 메뉴 > API 키 관리**에서 등록(NovelAI **Opus 등급** 검증(`api.novelai.net` 은 CORS 불가 → 서버) 후 암호화 저장). 고정 프롬프트/파라미터·검증·서버측 ZIP 해제는 `lib/server/novelai.ts`. 썸네일(`characters/thumbnail`)·그림체(`styles/generate`)는 아직 서버 NDJSON 스트림 경로(`generateImageStream`). Gemini 는 `gateway.order:['google','vertex']` 페일오버 — **google(AI Studio) 우선**: Vertex 는 Gemini 3.8+ 에서 NSFW 허용 지시가 든 프롬프트를 입력 단계에서 content-filter 차단(빈 응답, 페일오버 안 탐).
- **그림체**(`/styles`, 내 목록만 — Hub 공유·즐겨찾기 개념 제거): **깎기 워크숍**(`StyleWorkshopModal`)에서 화풍+상황(테스트)으로 자기 NovelAI 키로 미리보기 생성 → 공유 시 제목·메모 + **고정 표준 장면**(`THUMBNAIL_SITUATION`, SFW)으로 일관 썸네일 리롤·결정 → R2 저장. 카드(썸네일+제목+작성자) 클릭 시 상세(프롬프트+즐겨찾기). **선택 퀄리티·네거티브 프롬프트**(워크숍 접이식 섹션, `art_styles.negative/quality`): 비면 모델별 고정 `QUALITY_TAIL(_V5)`/`NEGATIVE_PROMPT(_V5)`, 있으면 **통째로 대체**(`resolveQualityTail`/`negativeFor(model, custom)`) — 단 네거티브 앞 아동 차단 접두(`MINOR_BLOCK_NEGATIVE`)는 항상 유지, V5 연도·complexity 자동 주입은 그림체 또는 퀄리티에 이미 있으면 생략. 워크숍 미리보기·썸네일·채팅(`styleNegative/styleQuality`)·캐릭터 썸네일 모두 고른 그림체의 값을 보낸다. 채팅 이미지 모달은 즐겨찾기 그림체 중 택1(캐릭터 추천 그림체 상단). 캐릭터 제작 폼에서 추천 그림체 지정 가능. 본인 그림체는 상세의 '수정'으로 같은 워크숍 모달을 채워 열어 수정(`edit` prop → `PATCH /api/styles/:id` multipart, 썸네일은 선택·미첨부 시 유지, 공개 여부는 그대로. JSON `{shared}` PATCH 는 공개 토글). API: `/api/styles*`(목록·생성·수정·상세·삭제·즐겨찾기·`mine`·`generate`).
- **모듈**(`/modules`, 내 목록만): 캐릭터 무관·재사용 가능한 **일반 지침**(출력 규칙 추가, 문체, 금기 등)(`ModuleEditorModal`: 제목·메모·본문, JSON `POST/PATCH /api/modules(/:id)`, `{shared}` 만 보내면 공개 토글). 채팅 헤더 🧩 버튼(설정 왼쪽) 모달에서 **내 모듈 + 즐겨찾기** 중 여러 개를 켜고 끔(최대 `MAX_ACTIVE_MODULES`=8, 켠 순서 번호 표시, localStorage `haven:modules:active` JSON 배열 — 전역 설정). 전송 시 `moduleIds` 로 보내면 서버가 `getModulesForChat`(공유 or 본인 소유만, 클라 순서 유지)로 해석해 `assembleTurn({modules})` → `buildModulesBlock`(`[추가 규칙 — 모듈]` 헤더 + `## 제목`/본문, `{{char}}`·`{{나}}` 치환) → **프롬프트 가장 마지막**: `[응답 지침]` 뒤 같은 user 메시지에 부착(이어가기 턴도 동일, XML 프레임이면 `<Guide:Modules>`). 꼬리 블록이라 prefix 캐시 무영향. 디버그 스냅샷 `modulesBlock`·패널 '모듈' 섹션, `/api/chat/inspect` 도 `moduleIds` 수용.
- **프로필**: 첫 실행 시 프로필 모달(이름·대화용 이름·페르소나·아바타). 네비바 이름 클릭 › 프로필 설정 / API 키 관리 / 저장소 · 백업 / charx 가져오기.
- **저장소**(`StorageLanding`/`StorageModal`): 첫 화면에서 'Google Drive 에 저장' 또는 '이 기기에만 저장'. Drive 모드는 헤더 칩(☁ 동기화됨/대기 n/⚠ 재연결/⚠ 충돌/<기기> 사용 중)으로 상태 표시, 모달에서 지금 동기화·충돌 선택·**Drive 기준으로 맞추기**(`resetToDrive`, 복구용)·이미지 전부 내려받기·연결 해제·**오래된 채팅 정리**(최근 50개만 보유, 생성 이미지 포함 삭제)·zip 내보내기/가져오기.


## 환경 변수

서버가 없으므로 **공개 값만** 있고 빌드 시 인라인된다(`.env`, gitignore / `.env.example` 참고).
- `PUBLIC_GOOGLE_CLIENT_ID`(선택) — GIS 용 OAuth 클라이언트 ID(비밀 아님). 비우면 `src/lib/local/drive.ts` 의 기본값. **Google 콘솔에서 '승인된 JavaScript 원본'에 `https://havenchats.com`·`http://localhost:5173` 등록 필요**, 클라이언트 시크릿·리디렉트 URI 불필요. OAuth 앱은 '테스트' 상태 + 테스트 사용자에 본인만.
- `AI_GATEWAY_API_KEY`(선택) — 재현 스크립트(tsx)용. 앱은 유저가 등록한 키(로컬 DB)를 쓴다.
- NovelAI·Gateway 키는 앱 '프로필 › API 키 관리'에서 등록 → 로컬 DB `user_keys` 평문(Drive 스냅샷에도 포함됨 — appDataFolder 는 본인만 접근).

## 명령어

```bash
npm run dev            # vite (:5173) — 이게 전부. API/DB/이미지는 브라우저 안
npm run check          # svelte-check (커밋 전 필수)
npm run build          # vite build → build/ (정적 SPA)
npm run preview        # build + vite preview
# 배포 = main 푸시 → GitHub Actions(pages.yml)

# 구 데이터 이전(1회): D1 덤프 → 백업 zip → 앱 '저장소 · 백업 › zip 가져오기' → API 키 재등록
npx wrangler d1 export haven --remote --output haven-d1.sql
node scripts/export-legacy.mjs haven-d1.sql --out haven-legacy-backup.zip   # 이미지는 https://havenchats.com/img/<key> 에서 받음(구 Worker 살아있을 때)
```

## 인프라

- **GitHub Pages**(레포 `frontishobby/havenchats.com`, Settings › Pages › Source = GitHub Actions, 커스텀 도메인 `havenchats.com`). 워크플로 `.github/workflows/pages.yml`: `npm ci` → `npm run build` → `upload-pages-artifact(build)` → `deploy-pages`.
- **Cloudflare 는 DNS 만**: `havenchats.com` CNAME → `frontishobby.github.io`(DNS only/회색 구름 — GitHub 가 인증서 발급). Worker `havenchats`·D1 `haven`·R2 `haven-images`(계정 `frontishobby`)는 이전 검증 후 삭제 대상, wrangler 는 레포에서 제거됨. 구 무료 계정 `HavenChats` 리소스도 삭제 대상.
- **Google Drive**: 유저 계정의 appDataFolder(앱 전용 숨김 폴더, 15GB 무료 용량 공유). 파일 = `haven.sqlite` + 이미지(name=키). 다른 앱/유저는 못 봄.
- **Google OAuth 클라이언트**(웹): `965110096401-…apps.googleusercontent.com`. JS 원본에 prod·localhost 등록.

## 아직 안 된 것 / 다음 단계

- **Drive 실사용 검증 미완**: 코드는 GIS 토큰·REST·동기화 엔진까지 있으나 실제 Google 계정으로 end-to-end 는 아직(헤드리스에서 OAuth 팝업 불가). 첫 연결 시 Google 콘솔 JS 원본 등록이 선행돼야 한다.
- **구 Worker/D1/R2 삭제**: zip 이전 확인 후. 삭제 전엔 `scripts/export-legacy.mjs` 가 (구 Worker 가 서빙하는) `/img/<key>` 에서 이미지를 받을 수 있다 — DNS 를 GitHub 로 바꾸면 `--base https://havenchats.workers.dev` 류 옛 주소를 써야 한다.
- 다기기 동기화는 통째 스냅샷 단위(주기 pull + push 선행조건 + 충돌 선택). 행 단위 변경 로그(트리거 `_changes` → ops 파일, PK upsert LWW)로 바꾸면 메시지 1건에 6MB 업로드가 사라진다 — 다음 단계 후보.
- 캐릭터 삭제 시 고아 이미지 정리 없음. 세션은 '저장소 · 백업 › 정리'(최근 50개만 보유, `POST /api/chat/prune`)가 이미지까지 지운다.
- 모바일 사파리는 IndexedDB 용량·서비스워커 제약이 커서 1.8GB 이미지 캐시가 부담 — 지연 다운로드라 필요한 것만 받지만 캐시 축출은 미처리.
- `isAdmin`/`canSeeNsfw`/`visibility`/`shared`/`favorites` 등 다인 흔적이 코드·스키마에 남아 있음(동작은 전부 허용). 점진 제거.
- 빌트인 캐릭터 없음, 결제 없음, 장기 기억은 rolling summary 까지(변경 없음).
