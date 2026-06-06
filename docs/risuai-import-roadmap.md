# RisuAI 카드(charx/risum) import 고도화 로드맵

> 작성: 2026-06-05 · 최종 갱신: 2026-06-06 · 상태: **진행 중** (로어북·변수엔진·HTML표시·탐지경고 완료)
> 목적: charx import 시 "조용히 누락"되는 RisuAI 기능들을 단계적으로 흡수.
> 관련 코드: `src/lib/import/charx.ts`, `cardToCharacter.ts`, `cbs.ts`, `htmlRender.ts`, `displayScripts.ts`, `lorebook.ts`, `src/routes/api/import/charx/`

---

## 구현 현황 (요약)

| # | 기능 | 상태 | 핵심 위치 |
|---|---|---|---|
| 1-1 | 로어북(키워드 동적 설정) | ✅ 완료 | `lorebook.ts`, migration 0014 |
| 1-2 | 변수 엔진 + 동적 CBS | ✅ 완료 (+Tier1) | `cbs.ts`, migration 0015 |
| 1-3 | 경량 트리거 | ⬜ 미착수 | (변수엔진 위에 올림) |
| 1-4 | 정규식 치환 | 🟡 표시형 완료 / 텍스트형 보류 | §1-4b |
| 1-4b | HTML 표시 모드(감정 스프라이트) | ✅ 완료 | `htmlRender.ts`, `displayScripts.ts`, migration 0016 |
| 1-5 | 미지원 요소 탐지 + 경고 | ✅ 완료 | `risum.ts`, `capabilities.ts` |
| 1-6 | CJS 커스텀 코드(클라 샌드박스) | ⬜ 최후순위 | — |

**남은 핵심 작업**: 경량 트리거(§1-3) → 그 위에 Celis 류 인터랙티브 UI(상태창·설정 토글)와 텍스트형 정규식.

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

### 1-1. 로어북 (World Info) — ✅ 완료 (2026-06-06)

키워드로 켜지는 동적 설정("A 언급 시 A의 비밀 공개" 류). `characters.lorebook` JSON 컬럼(migration 0014) +
`src/lib/lorebook.ts`(정규화·선택·포맷 순수함수). import 가 card.json `character_book` + module.risum `lorebook`
를 머지·디둡(content 기준). `/api/chat` 가 최근 window 키워드 스캔 → 마지막 유저 메시지 끝(가변영역, prefix 캐시
보존)에 주입, constant 는 항상 주입. imported 는 서버 전용(getCharacterLorebook). 수동 편집 `CharacterLorebookModal.svelte`.
검증: 런타임 14/14 · 추출 10/10.

> 후순위(미구현): RisuAI 풀 재현(정규식 키·recursion·scan depth·토큰 예산·`@@` 데코레이터).

---

### 1-2. 변수 엔진 + 동적 CBS — ✅ 완료 (2026-06-06)

세션별 상태 변수(`$호감도`, `$기분`...)를 import 박제 → 런타임 평가로. `src/lib/cbs.ts`(evalCBS: getvar/setvar/
addvar/calc/random/roll/#if/#when, 비교·수학·문자열·시간 매크로, 시드 RNG), `chat_sessions.script_state`·
`characters.script_data` JSON 컬럼(migration 0015). import 가 description·로어북 CBS 를 원시 보존(greeting·notes
만 정적 평탄화) + defaultVariables 추출. `/api/chat` 가 매 턴 ctx(세션변수∪기본변수+index+rng)로 평가 → setvar
변이 영속(updateScriptState). CBS 없으면 noop(prefix 캐시 유지). 검증: evalCBS 19/19 · 변수체인 7/7.

> Tier 2 일부는 §1-4b 에서 추가(assetlist/array/filter/`#each`/slot/settempvar). 메시지참조·char필드주입은 트리거(§1-3)
> 와 함께, 에셋/감정/암호화/환경 매크로(~50개)는 우리 아키텍처에 무의미 → 영구 스킵.

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

### 1-4. 정규식 치환 스크립트 — 🟡 표시형 완료 / 텍스트형 보류

`module.risum` `regex[]`(customscript). `{in, out, type, flag}`. `out` 에 `$1` 그룹·CBS 매크로 결합 가능. type 별 처리:
- **`editdisplay` (HTML 출력 = 대부분)** → ✅ **완료** — 감정 스프라이트 HTML 렌더(§1-4b).
- **`editoutput`/`editinput`/`editprocess` (텍스트 가공)** → 보류. 단독 효용 낮고 CBS 조건과 얽혀 복잡 → 안전 정규식 한정 후순위.
- **`disabled` (에디터 구분선/라벨, in 비어있음)** → 무시.

> 초기 판단(2026-06-06)은 "editdisplay = HTML 뿜어 산문 모드와 충돌 → 포팅 안 함"이었으나, §1-4b 에서 DOMPurify+CSS
> 스코핑으로 안전하게 렌더 가능해져 **표시형은 완료로 전환**. capabilities 경고도 editdisplay·disabled 는 제외(나머지만 ⚠️).

**보안**: 제작자 임의 정규식 = ReDoS 위험 → 입력 길이 제한(`displayScripts.ts` MAX_DISPLAY_INPUT)으로 방어(Workers/브라우저 동기 타임아웃 부재 대비).

---

### 1-4b. HTML 표시 모드 (editdisplay HTML 렌더링) — ✅ 완료 (감정 스프라이트 한정, 2026-06-06)

수입 카드의 editdisplay 정규식이 모델 `<img="감정">` 마커를 격리·세정된 감정 스프라이트 HTML 로 렌더(옵션 A 채택).
**파이프라인(클라)**: 정규식 in→out($캡처) → CBS 평가(에셋 리졸브) → DOMPurify 세정 + CSS `.chattext` 스코핑 → innerHTML.

- `src/lib/htmlRender.ts`: encodeStyle(`<style>`→hex) → DOMPurify(훅: script·on*·`javascript:`·비유튜브 iframe 제거,
  href http(s)만+target/rel) → decodeStyle(@adobe/css-tools 로 셀렉터에 `.chattext` 접두, `@import` 제거).
- `src/lib/cbs.ts`: 에셋/배열 매크로 추가(raw/img/asset/path/emotion·assetlist·array·filter·`#each`/slot·settempvar),
  CbsContext 에 assets/resolveAsset/temp.
- `src/lib/import/displayScripts.ts`: risum editdisplay 추출·정규식 적용·NamedImageSet 에셋 리졸버(ext/대소문자
  정규화 + 편집거리 퍼지).
- `characters.display_scripts` 컬럼(migration 0016, 표시 전용 → 클라 전달).
- `/api/chat`: display 카드면 buildImageCatalog·pinSceneCodes 스킵(카드 자체 `<img>` 출력 규약에 위임 — 카탈로그 주입 시 변형 접미사 충돌).
- `chat/[id]/+page.svelte`: 라인별 매칭 시 정규식→CBS(순수, SSR/클라 동일)→`<div class="chattext" use:cardHtml>` 로
  세정 후 innerHTML 주입(액션=클라 전용 → hydration 안전).

**범위**: 감정 스프라이트(Catrina/Da-yeon/무인도)만. Celis 류 인터랙티브 UI(설정 토글·risu-trigger·세션변수 게이팅)와
양피지 상태창 등 풀 UI 는 트리거(§1-3)/첫메시지 HTML 영역이라 제외. 검증: CBS 6/6 · 실카드 3종 e2e · 보안 13/13(jsdom).

> 설계 근거(RisuAI 원본): `{@html}` + DOMPurify + CSS AST 스코핑(Shadow DOM 아님). 파이프라인 `parser/parser.svelte.ts:736~`,
> DOMPurify 훅 `:46-119`, CSS 스코핑 `:893-953`, 에셋 리졸버 `:482-629`. 우리는 markdown-it 생략(감정 마커는 순수 HTML),
> class 접두(`x-risu-`) 생략(`.chattext` 스코핑만으로 격리 충분).

---

### 1-5. 미지원 요소 탐지 + 경고 — ✅ 완료 (2026-06-05)

import 시 카드의 미지원 요소를 구조 스캔해 미리보기 UI 에 명시("조용히 누락" → 명시 고지). `src/lib/import/risum.ts`
(RPack 디코더 + readModuleMeta), `capabilities.ts`(scanUnsupported) → `card.warnings`. 트리거를 V1(조건→효과)/
V2(블록 프로그래밍)/CJS(JavaScript)로 분리 표기. **지원되는 것(로어북·CBS 변수·editdisplay·disabled)은 경고에서 제외**,
미지원(텍스트형 정규식·V2 트리거·CJS·lowLevelAccess)만 ⚠️. 검증: 실카드 3종.

> 한계(정직): "있다/없다"는 정확하나 "정확히 동작"은 미보장(우리 엔진과 미묘한 차이 가능) → imported 캐릭터는
> `imported:true`(수정불가) + 경고 유지 방침. 텍스트 박힌 CBS 는 `cbs.ts` usedScripting 플래그가 보조로 잡음.

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
1   로어북            ✅ card.json, RPack 불필요. 쉽고 효과 큼
2   변수엔진          ✅ chat_sessions.script_state. 트리거 토대
4.5 미지원 탐지+경고    ✅ RPack 디코더 + 구조 스캔. 조용한 누락 → 명시 고지
4   정규식 치환(표시형)  ✅ editdisplay → 감정 스프라이트 HTML(§1-4b)
──────────────── 여기까지 완료 ────────────────
3   경량 트리거        ⬜ 조건평가 + setvar + systemprompt주입 + impersonate(append) ← 다음
   ↳ 그 위에: Celis 류 인터랙티브 UI(상태창·설정 토글) + 텍스트형 정규식
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
