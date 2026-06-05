# RisuAI 카드(charx/risum) import 고도화 로드맵

> 작성: 2026-06-05 · 상태: **계획(미착수)**
> 목적: charx import 시 "조용히 누락"되는 RisuAI 기능들을 단계적으로 흡수.
> 관련 코드: `src/lib/import/charx.ts`, `cardToCharacter.ts`, `cbs.ts`, `src/routes/api/import/charx/`

---

## 0. 배경 — 지금 상태

Haven은 현재 **charx(Character Card V3)** 만 import 한다. charx = ZIP 이고 내부는:

```
character.charx (ZIP)
├── card.json        ← V3 카드. 우리가 읽는 유일한 파일
├── module.risum     ← RisuModule(RPack 바이너리). 지금 완전 무시
└── assets/*.png
```

### 지금 들어오는 것 (정적 텍스트 — `cardToCharacter.ts:131-159`)
description/personality/scenario/system_prompt/post_history/mes_example → `description` 한 덩어리로 병합, first_mes+alternate_greetings → 오프닝, creator_notes → intro/tagline, tags, icon, 장면 이미지(로컬 IndexedDB 전용).

### 지금 누락/박제되는 것
| 항목 | 저장 위치 | 현재 처리 |
|---|---|---|
| 로어북(키워드 트리거) | `card.json` `character_book` | **constant만 흡수, 나머지 버림** (`cardToCharacter.ts:144-154`) |
| CBS 변수/분기 | 텍스트 내 `{{...}}` | **import 때 첫 값으로 박제** (`cbs.ts`, getvar=고정·random=첫값·if=한갈래) |
| 정규식 치환 | `module.risum` `regex[]` | 무시 |
| 트리거 | `module.risum` `trigger[]` | 무시 |
| CJS 커스텀 코드 | `module.risum` `cjs` | 무시 |

> **핵심 구분**: 로어북은 `card.json`에 있어 **RPack 디코딩 불필요**. 정규식/트리거/CJS는 `module.risum`(RPack 바이너리)에 있어 **RPack 디코더 + `readModule` 포팅이 선행돼야** 추출 가능.

### risum 포맷 요약 (참고)
- 헤더: 매직 `111` + 버전 `0` + UInt32LE 길이 + RPack(JSON) + asset 블록들 + EOF `0`
- 직렬화: JSON → **RPack**(256바이트 lookup table 난독화, 암호화 아님)
- 원본: `~/risu/risuAI/src/ts/process/modules.ts:34-227`, `rpack/rpack_js.js`
- 스키마 `RisuModule`: `name, description, lorebook[], regex[], cjs, trigger[], assets[], lowLevelAccess, mcp ...`

---

## 1. 기능별 상세 + 구현 방향

### 1-1. 로어북 (World Info) — **1순위, 가성비 최고**

**무엇**: 대화에 특정 키워드가 나오면 관련 설정 텍스트를 그때 프롬프트에 주입. "A를 언급하면 A의 비밀이 공개" 류 조건부 지식.

**왜 쉬움**: `card.json`에 있음 → RPack 불필요. 이미 `cardToCharacter.ts:144`에서 읽고 있고 *버리기만* 한다.

**런타임**: 우리 `/api/chat`은 이미 sliding window + rolling summary로 동적 컨텍스트를 조립 중 → **로어북 스캔 단계 1개 추가**가 자연스러움.
- 최근 메시지 N개를 스캔 → 키워드 매칭된 항목만 system 프롬프트에 주입
- constant 항목은 항상 주입

**핵심 80% / 나중에**: 핵심(키워드 매칭→주입)은 쉬움. RisuAI 풀 재현(정규식 키, recursion, scan depth, 토큰 예산, `@@`데코레이터)은 후순위.

**⚠️ 로어북이 두 군데에 분산** (실제 charx 3종 스캔으로 확인, 2026-06-05):
- `card.json` `character_book.entries` — 지금 cardToCharacter 가 *상시(constant)만* 흡수
- `module.risum` `lorebook[]` — charx export 가 `char.globalLore` 를 여기로 넣음. 현재 완전 미흡수
- **둘이 중복/분산될 수 있음** (예: Celis.charx = character_book 8개 **＋** module.risum lorebook 8개). 정식 구현 시 **두 출처를 머지 + 디둡(content/comment 기준)** 필요. 안 그러면 같은 설정이 두 번 주입됨.
- 참고: `extensions.risuai.triggerscript/customScripts` 는 charx 에선 **항상 비어 있음**(risum 으로 이동) → 트리거/정규식 탐지는 risum 디코드가 필수임을 실증.

**캐싱 주의**: 로어북은 가변 주입이라 system **고정 prefix**를 깨면 프롬프트 캐시가 날아간다. 로어북 블록은 가변 영역(마지막 유저 메시지 끝 또는 rolling summary처럼 prefix 뒤쪽)에 배치할 것. (CLAUDE.md 프롬프트 캐싱 규칙 참고)

---

### 1-2. 변수 엔진 + 동적 CBS — **2순위, 토대**

**무엇**: 세션별 상태 변수(`$호감도`, `$기분`...). 지금은 import 때 박제 → 런타임에 살아 움직이게.

**저장**: `chat_sessions`에 JSON 컬럼 `script_state` 추가. `{ "$호감도": "50" }` 형태.

**런타임**: CBS 평가를 import-time → **chat-time(`/api/chat`)로 이동**. 매 턴 `script_state` 읽어서 `{{getvar}}`/`{{#if}}` 평가. 이게 트리거의 전제.

**파급**: 이거 하면 호감도/진행도 같은 **상태머신형 캐릭터가 박제 → 동적**으로 살아남.

---

### 1-3. 경량 트리거 — **3순위**

**무엇**: `if 조건 then 효과` 자동화 규칙. 캐릭터 카드를 작은 게임으로. (`triggers.ts:20-26`)
- 발동 시점(type): `start`/`input`/`output`/`request`/`display`/`manual`
- 조건: 변수 비교 / 텍스트 존재(최근 N개) / 턴 수
- 효과: setvar, systemprompt 주입, impersonate, modifychat, (runLLM/runImgGen=위험군)

**우리 구현 범위 (경량)**:
| 효과 | 난이도 | 채택 |
|---|---|---|
| 조건 평가(변수/텍스트/턴수) | 쉬움(순수함수) | ✅ |
| setvar | 쉬움(`script_state` 갱신) | ✅ |
| systemprompt 주입 | 쉬움(프롬프트 조립 중) | ✅ |
| impersonate (메시지 주입) | 중간 | ✅ append-only 한정 |
| modifychat (과거 메시지 변조) | 중간 | ⚠️ 스킵(정규식으로 흡수) |
| runLLM / runImgGen | 어려움/위험(lowLevelAccess) | ❌ |
| V2 인터프리터(v2If/v2Loop/v2Calculate...) | 매우 높음(=비주얼 프로그래밍 언어) | ❌ 클론 영역 |

**effect 상세 메모**
- **impersonate**: 유저/캐릭터가 말한 것처럼 메시지 주입 → "조건 되면 캐릭터가 알아서 사건 발생"(컷신). **효용 높음.** 단 우리 영속화(유저=즉시저장, assistant=onFinish, 사이드바 미리보기)와 충돌 안 나게 **스트림 종료 후 새 seq로 INSERT만** 허용.
- **modifychat**: 기존 메시지 행 UPDATE → seq 정합성·영속화 타이밍과 가장 안 맞음. 수요 대부분은 **출력 정규식 치환**으로 대체 가능 → 스킵 권장.

---

### 1-4. 정규식 치환 스크립트 — **4순위**

**무엇**: `module.risum` `regex[]`(customscript). `{in: 정규식, out: 치환, type: editinput/editoutput/editdisplay}`. 모델 입출력/표시 텍스트를 후처리.

**구현**:
- **`editdisplay`(렌더링만 변경, 모델은 못 봄) 우선** — 안전하고 쉬움. modifychat 수요 상당수 흡수.
- `editoutput`(저장/전송 텍스트 변경)은 신중.

**보안**: 제작자 임의 정규식 → **ReDoS 위험**. 입력 길이 제한 + 패턴 검증(또는 안전 정규식 엔진). Workers엔 동기 정규식 타임아웃이 없으니 입력 크기로 방어.

---

### 1-5. 미지원 요소 탐지 + 경고 — **4.5순위 (가성비 ★)** ✅ **구현됨 (2026-06-05)**

> 구현: `src/lib/import/risum.ts`(RPack 디코더 + readModuleMeta), `src/lib/import/capabilities.ts`(scanUnsupported),
> `charx.ts parseCharx` 에서 호출 → `card.warnings` 병합 → import 미리보기 UI 에 노출.
> 실제 charx 3종(Catrina/Celis/무인도)으로 검증 — 트리거·정규식·모듈로어북 탐지 정상. (아래 본문은 설계 메모)


**무엇**: import 시 카드에 우리가 미지원하는 요소가 들어있는지 **구조적으로 스캔**해서 사용자에게 명세.

**왜 거의 공짜**: 3~4순위 추출을 하려면 어차피 **RPack 디코더 + `readModule`**을 포팅함 → 그 순간 `RisuModule` 객체 전체가 메모리에. **객체 트리만 훑으면 됨.**

```ts
const SUPPORTED_EFFECTS = new Set(['setvar','systemprompt','impersonate']);
for (const t of module.trigger ?? [])
  for (const e of t.effect)
    if (!SUPPORTED_EFFECTS.has(e.type)) skipped.push(e.type); // runLLM, modifychat, v2If...
if (module.cjs?.trim()) skipped.push('cjs');
// regex[].type === 'editoutput' 등도 분류
```

**산출물(사용자 노출)**:
```
✅ 로어북 8개 가져옴
✅ 트리거 3개 중 2개 적용 (호감도, 감정추적)
⚠️ 트리거 1개 스킵 — runLLM(추가 AI 호출) 미지원
⚠️ 정규식 5개 중 4개 적용, 1개 스킵(출력 변조형)
❌ 커스텀 코드(CJS) 있음 — 미동작
```

**한계(정직)**: "있다/없다"는 100% 정확. "정확히 동작하냐"는 보장 못 함(우리 변수엔진과 미묘한 차이 가능) → import 캐릭터를 `imported:true`(수정불가)로 두고 경고 유지하는 현 방침이 옳음. 텍스트 박힌 CBS는 `cbs.ts` `usedScripting` 플래그가 이미 잡음 → 구조 스캔과 합치면 사각지대 거의 없음.

> **단독 선행 가능**: 3~4순위 실제 구현 없이 **RPack 디코더 + 스캔 + 경고만** 먼저 붙여도 "조용히 누락 → 명시적 고지"로 개선됨. 로어북 다음 가성비 2순위.

---

### 1-6. CJS 커스텀 코드 (클라이언트 샌드박스) — **최후순위, 수요 확인 후**

**무엇**: `module.risum` `cjs` = 제작자 임의 JS. 이벤트 훅으로 동작.

**서버 실행은 불가**: Workers = 공유 인프라(D1·R2·시크릿). untrusted JS 절대 금지.

**클라이언트는 가능** — 위험 모델이 바뀜: 유저 본인 브라우저에서 **자기가 고른** 코드 실행 → 피해가 그 유저 1명으로 격리. RisuAI도 클라에서 돌림.

**단 `eval` 금지** — 메인 컨텍스트 eval = 세션 쿠키 탈취·우리 API 도용·XSS. 반드시 샌드박스:
- **A. sandboxed iframe**(`sandbox="allow-scripts"`, same-origin 없이 = null origin) + `postMessage` RPC + CSP로 네트워크 차단. 가벼움.
- **B. QuickJS-WASM**: JS-in-JS, fetch/DOM/네트워크 자체가 없고 우리가 노출한 함수만 보임. 가장 안전, 무거움. **권장.**

두 방식 모두 CJS는 **우리가 정한 브릿지 API(트리거와 동일 표면: getVar/setVar/getMessages/injectPrompt)** 하고만 대화. 직접 fetch/쿠키/DOM 차단.

**남는 리스크**: 프롬프트 인젝션(자기 대화 한정, 피해 작음) / 무한루프(타임아웃·Worker kill) / API 표면 버그(최소화) / **명시적 동의 UX**(RisuAI `lowLevelAccess` 확인처럼).

**판단**: 기술적 가능 + 클라 격리면 합리적 안전선. 단 공수 큼(샌드박스+RPC+API설계+동의UX+타임아웃) + CJS 카드 희귀 → **맨 뒤**. 95%는 1-5 탐지+경고로 충분.

---

## 2. 공통 인프라 작업

1. **RPack 디코더 + `readModule` 포팅** — `~/risu/risuAI/src/ts/process/modules.ts:98-227`, `rpack/rpack_js.js`. 순수 함수라 Workers 포팅 가능. 정규식/트리거/CJS *추출·탐지*의 전제(로어북엔 불필요).
2. **DB 스키마**
   - `chat_sessions.script_state` (JSON) — 변수 엔진
   - 로어북 테이블 `lorebook_entries` (character_id, keys[], secondkey, content, constant, selective, insert_order, priority) — 또는 `characters.image_set`처럼 JSON 컬럼
3. **`/api/chat` 파이프라인 확장** — 현재 system 조립 흐름에 단계 삽입:
   ```
   [기존] system(고정 prefix) + window + summary
   [추가] ① 트리거(input) 평가 → script_state 갱신 / systemprompt 주입 / impersonate
          ② 로어북 스캔 → 키워드 매칭 주입 (가변영역, prefix 캐시 보존)
          ③ CBS 평가(script_state 기반)
          ④ (output 후) 트리거(output) 평가
          ⑤ 정규식 치환(editdisplay/editoutput)
   ```
   캐싱 규칙 준수: 가변 주입은 prefix 뒤(마지막 유저 메시지 끝/summary 근처)로.
4. **import 매핑 확장** (`cardToCharacter.ts`) — 버리던 로어북/트리거/정규식을 네이티브 스키마로 매핑 + skipped 명세 생성.

---

## 3. 권장 순서 (가성비선)

```
1   로어북            ← card.json, RPack 불필요. 쉽고 효과 큼
2   변수엔진          ← chat_sessions.script_state. 트리거 토대
3   경량 트리거        ← 조건평가 + setvar + systemprompt주입 + impersonate(append)
4   정규식 치환        ← editdisplay 우선. modifychat 수요 흡수
4.5 미지원 탐지+경고    ← RPack 디코더 + 구조 스캔. 조용한 누락 → 명시 고지
──────────────── 여기까지가 가성비선 ────────────────
(수요 확인 후) CJS 클라 샌드박스 실행 ← QuickJS-WASM + 브릿지 + 동의 UX
스킵: modifychat(과거변조), runLLM/runImgGen, V2 비주얼 인터프리터, 서버사이드 CJS
```

**한 줄 요약**: 읽을거리(성격/세계관/오프닝)는 이미 거의 다 살아 있음. 이 로드맵은 **움직이는 것(키워드 로어북·변수 상태·조건 분기·정규식)을 박제 → 동적으로** 되살리는 작업. CJS만 빼면 전부 기술적으로 가능하며, CJS도 클라 샌드박스로 조건부 가능.

---

## 4. 참고 출처 (RisuAI 원본)
- risum 포맷/모듈: `~/risu/risuAI/src/ts/process/modules.ts`
- RPack: `~/risu/risuAI/src/ts/rpack/rpack_js.js`, `rpack_map.bin`
- charx ZIP 처리: `~/risu/risuAI/src/ts/process/processzip.ts`
- 트리거: `~/risu/risuAI/src/ts/process/triggers.ts` (타입 `:20-74`, 효과 `:30-49`, 실행 `:1237-1314`)
- 우리 import: `src/lib/import/charx.ts`, `cardToCharacter.ts`, `cbs.ts`, `src/routes/api/import/charx/`
