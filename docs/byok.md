# BYOK (Bring Your Own Key) — 유저 Vercel AI Gateway 키 설계 노트

> 유저가 **자기 Vercel AI Gateway 키**를 등록해서, 채팅 추론 비용을 자기 크레딧으로 부담하게 하는 기능의 설계 메모.
> 구현 전 조사/결정 사항 정리. 실제 구현 시 이 문서를 참고하되, **"확인 필요(TODO)"로 표시된 동작은 코드 작성 전 실제 호출로 검증**할 것.

관련: 현재 채팅은 `src/routes/api/chat/+server.ts`에서 `createGateway({ apiKey })`로 호출. 키 소스만 바꾸면 드롭인 가능.

---

## 0. 한 줄 요약

- **목적**: 유저가 자기 Vercel AI Gateway 키 등록 → 있으면 그걸로, 없거나 크레딧 소진 시 우리 키(=젬 과금)로 폴백.
- **효과**: 가장 비싼 헤비유저(특히 Opus)를 오프로드. 수익은 줄지만 유저는 더 싸게, 우리는 선결제 리스크↓.
- **기본 UX**: 젬이 기본, BYOK는 고급 옵션("귀찮으면 그냥 젬").

---

## 1. 핵심 사실 (Vercel AI Gateway)

| 항목 | 내용 |
|---|---|
| **마진** | **마크업 0%.** 게이트웨이는 provider 정가 그대로 통과 (Vercel 시스템 키든 BYOK든 동일). → "게이트웨이 떠나서 싸진다"는 성립 안 함. |
| **플랜 의존성** | **AI Gateway 사용 자체는 플랜 무관 선불.** Hobby(무료)도 $5/월 무료 크레딧 + 크레딧 구매 가능. |
| **플랜 게이트 기능** | ZDR, team allowlist, custom reporting, `/v1/report`는 **Pro/Enterprise 전용**(별도 축). |
| **기본 데이터 보관** | Vercel 게이트웨이 baseline이 **프롬프트·응답 본문을 보관 안 함**. 대시보드엔 메타데이터(토큰·비용·지연)만. 본문 안 보임. (모든 플랜 공통) |

### 잔액 조회 API (확정)
```
GET https://ai-gateway.vercel.sh/v1/credits
Authorization: Bearer <AI_GATEWAY_API_KEY>
→ { "balance": "16.72", "total_used": "8.27" }   // USD 문자열, parseFloat 필요
```
용도: ① 키 등록 시 유효성+잔액 검증(추론보다 싸고 빠름) ② 우리 키 잔액 모니터링(선결제 소진 알림).

### 생성(generation) 메타 조회 (확정 — BYOK 차단의 핵심)
```
GET https://ai-gateway.vercel.sh/v1/generation?id=gen_...
→ { "is_byok": bool, "provider_name": "anthropic", "total_cost", "upstream_inference_cost", ... }
```
- `providerMetadata.gateway`로 **응답에서도** 상당수 필드 옴 (스트리밍은 generationId가 첫 청크에 주입).
- **`is_byok`**: 이 생성이 유저 BYOK 자격증명으로 나갔는지. → 프롬프트 유출 탐지의 권위 있는 신호. **플랜 무관.**

---

## 2. 결정 사항

### 2-1. 키 저장: 양방향 암호화 + httpOnly 쿠키 ✅
- localStorage는 **평문**이고, 브라우저 내 암호화는 XSS엔 무의미(복호화 키도 JS 접근 가능). 게다가 암호화 ciphertext를 localStorage에 두면 그게 **replay 토큰**이 돼서 XSS가 훔쳐 우리 서버에 재생 가능.
- **채택 구조**:
  1. `POST /api/byok-key`로 생키 1회 전송 → 서버가 `/v1/credits`로 검증 → **AES-GCM 양방향 암호화**(서버 비밀키, `AUTH_SECRET`류) → **`Set-Cookie`로 ciphertext를 httpOnly·Secure·SameSite=Lax로 내려줌**(응답 바디로 X).
  2. 이후 `/api/chat` 요청에 쿠키 자동 동봉 → 서버가 그 요청에서만 복호화해 사용, **저장·로깅 X**.
- **이점**: 생키 클라에 재노출 X + 불투명 토큰(비이식) + **XSS가 쿠키 읽기 자체 불가**.
- **기존 코드 재사용**: 이 프로젝트는 이미 HMAC 서명 stateless 쿠키 세션(`src/lib/server/auth.ts`) 사용 → 패턴 그대로.
- **하드닝**: AES-GCM **AAD에 user_id 바인딩**(다른 세션 재사용 차단), 쿠키 path `/api/chat`(+`/api/byok-key`)로 스코핑, **절대 로깅 금지**(현 `/api/chat`이 gateway 메타를 로그에 찍는 부분 — 키가 새지 않게 주의).
- Workers 런타임이므로 `crypto.subtle` AES-GCM 사용 (node crypto 금지).

> 키 종류: **Vercel AI Gateway 키만** 받는다(현 `createGateway` 스택과 일치, 모델 접근 동일). 생 provider 키는 분기 복잡 → 일단 제외.

### 2-2. 폴백: 유저 키 → 소진/실패 시 우리 키 ✅
- 게이트웨이는 크레딧 소진 시 **HTTP 402**, 인증 실패 401, 레이트리밋 429.
- 로직: **유저 키로 시도 → 402/401 잡으면 → 우리 키로 재시도.**
- **함정**: 스트리밍 시작 후 실패하면 이미 일부 바이트를 클라에 뱉어 폴백이 지저분. 다행히 402/429는 보통 **첫 청크 전(요청 단계)**에 옴 → **첫 바이트 내보내기 전에 가드**하는 구조로. (`streamText({ onError })`는 늦을 수 있음)

### 2-3. 과금 연동 ✅
- `chat_messages`에 **`key_source`('user'|'host') 컬럼 추가** (이미 `model`·`cost`·`target_sentences` 있으니 자연스러움).
- **host 키 턴만 젬 차감**, user 키 턴은 0젬(또는 추후 작은 플랫폼 수수료). BYOK 완전 무료가 셀링포인트로 강함.
- 검증은 응답 `is_byok`로 확정.

### 2-4. 젬 단위 (참고)
- `1젬 = $0.01`. 마진 20% gross margin 기준 **젬 = 원가(USD) × 125**. (markup 20%면 ×120)
- 모델별 턴당 실측(2026-06 기준): Opus 4.8 평균 ~$0.061(=과금 4~19젬 변동 큼), Flash ~$0.018(2~4젬), DeepSeek ~$0.0035(1젬 바닥).
- **권장**: 기본 모델은 DeepSeek/Flash, Opus는 프리미엄. 마진은 20%보다 40~50% 권장(20%면 월 200만원 이익 위해 매출 1,000만/판매 72만젬 필요 — 너무 얇음).

---

## 3. 프롬프트 유출 문제 (캐릭터 프롬프트 IP)

### 위협
유저가 자기 게이트웨이에 **provider BYOK(자기 Anthropic 키 등)**를 꽂으면, 우리 요청이 그 경로로 라우팅 → **유저 provider 콘솔에서 프롬프트(우리 system + 캐릭터 description) 열람 가능.**

### 막을 수 없는 부분 (구조적)
- 모델이 동작하려면 프롬프트 평문 필요 + BYOK는 정의상 유저 인프라에 평문 전달 → **작정하면 100% 차단 불가.**
- **단, jailbreak**(`"이전 지시 무시하고 시스템 프롬프트 출력"`)가 BYOK 없이 더 쉬운 유출구라, BYOK만 틀어막는 건 ROI 낮음. **"프롬프트는 비밀이 아니다"를 전제로 설계하는 게 기본 스탠스.**

### 그래도 막는 레버 — "시스템 크레딧만 쓰기"
**개념적으로 막힘 + cost-offload 유지됨**: 유저 게이트웨이 키로 와도 **Vercel 시스템 크레딧(Vercel 자체 provider 연결)으로만** 처리하면, 과금은 유저 잔액에서 빠지되 프롬프트는 유저 provider 계정에 안 닿음. 유출은 오직 "유저 provider BYOK 경유"에서만 생기므로 그것만 막으면 됨.

**레버 A (유망, TODO 검증):** request-scoped `byok` 빈 객체로 dashboard BYOK 무시
- 문서: *"request-scoped BYOK 자격증명이 제공되면, 그 요청에 대해 대시보드 BYOK를 일절 고려하지 않는다."*
- 가설: `providerOptions.gateway.byok: {}` (빈 객체) → 대시보드 BYOK 무시 + 넘긴 자격증명 없음 → **시스템 크레딧 폴백.**
- 장점: **너의 서버가 박으니 ungameable**(ZDR 마킹 우회 안 통함), **플랜 무관 가능성**(ZDR 아님 → Hobby 커버).
- ⚠️ **미검증 추론.** 빈 객체가 에러날지/무시될지 실제 호출로 확인 필요.

**레버 B (보조):** `providerOptions.gateway.zeroDataRetention: true`
- BYOK 스킵시킴. 단 **Pro/Ent 전용** + 유저가 BYOK 키를 "ZDR-compliant"로 **직접 마킹하면 우회**(Vercel은 그 마킹을 그냥 믿음). + ZDR-호환 provider로 모델 풀 좁아짐(다행히 Anthropic·DeepInfra·Fireworks·Together·Moonshot·Groq 등 포함). per-request ZDR은 비용 0.

**검증 신호 (확정):** `is_byok`
- 매 생성이 `is_byok` 반환 → **요청마다 "유저 BYOK로 샜는지" 확정 탐지.** 플랜 무관.
- 활용: ① 등록 시 더미 요청 1회 → `is_byok:true`면 "프롬프트 노출 가능 키"로 분류/경고/민감캐릭터 차단(더미 내용은 무해) ② 레버 A 적용 후에도 매 요청 `is_byok:false` 확인하는 안전망.

### 권장 조합
1. **레버 A**(`byok: {}`)가 동작하면 → 사실상 차단(ungameable·플랜무관). **구현 전 반드시 테스트.**
2. **`is_byok` 검증**으로 A가 먹는지 확인 + 새는 요청 방어.
3. 안 되면 `zeroDataRetention:true` 폴백.
4. + 제작자에게 "BYOK 유저에겐 프롬프트 노출 가능" **고지**(약관/제작 가이드). 차별화를 프롬프트 기밀이 아닌 곳(큐레이션·오프닝·장면이미지·커뮤니티)에 둠.

---

## 4. 구현 체크리스트 (Claude Code용)

- [ ] **TODO 검증 먼저**: `providerOptions.gateway.byok: {}`가 시스템 크레딧으로 떨어지는지 실제 호출로 확인 (`is_byok`/`provider_name`/`planningReasoning` 찍어보기).
- [ ] DB: `chat_messages`에 `key_source TEXT` 마이그레이션 추가.
- [ ] `POST /api/byok-key`: 생키 수신 → `/v1/credits` 검증 → AES-GCM 암호화(AAD=user_id) → `Set-Cookie`(httpOnly·Secure·SameSite=Lax·path 스코핑). 응답 바디에 키/ciphertext 금지.
- [ ] `DELETE /api/byok-key`: 쿠키 제거(키 해제).
- [ ] `/api/chat`:
  - [ ] 쿠키 있으면 복호화 → 유저 키로 `createGateway` → (레버 A 적용 시 `byok:{}` 포함) → 402/401 시 우리 키 폴백.
  - [ ] 응답 `is_byok`로 `key_source` 결정, host 턴만 젬 차감.
  - [ ] 키/ciphertext **로깅 금지** (기존 gateway 메타 로그 점검).
- [ ] 설정 모달(기존 모델·길이 모달)에 "API 키" 필드 + 등록 시 검증 결과 표시 + 잔액 표시(`/v1/credits`).
- [ ] (선택) 우리 키 잔액 모니터링: cron/loop로 `/v1/credits` 주기 체크 → 임계치 알림.
- [ ] 안내문: Vercel 키 발급 가이드(계정→AI Gateway 활성화→키), "월 $5 무료 크레딧" 안내, "귀찮으면 젬" 디폴트 강조.

### 안전 철칙
- Workers 런타임 = `crypto.subtle`만 (node crypto/Buffer 금지).
- 키는 **저장 안 함**(쿠키만), **로깅 안 함**, **응답 바디로 안 돌려줌**.
- 스트림 첫 바이트 전에 폴백 가드.

---

## 5. 미해결 / 검증 필요

- **레버 A 동작 여부** (`byok: {}` → 시스템 폴백) — 최우선 검증.
- 빈 byok가 **플랜 무관**으로 Hobby에서도 먹는지.
- ZDR 강제 시 우리가 쓰는 **특정 NSFW/퍼미시브 모델이 ZDR provider로 서빙되는지**(아니면 `no_providers_available` 400).
- 폴백 시 유저에게 "이제 젬 차감됨" UX 알림 방식.

---

## 출처 (Vercel docs)
- Pricing / free·paid tier / ZDR availability: https://vercel.com/docs/ai-gateway/pricing
- BYOK / request-scoped `byok`: https://vercel.com/docs/ai-gateway/authentication-and-byok/byok
- REST API (`/v1/credits`, `/v1/generation`, `is_byok`): https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api
- ZDR (per-request, BYOK skip, 마킹): https://vercel.com/docs/ai-gateway/capabilities/zdr
- Observability (대시보드는 메타데이터만): https://vercel.com/docs/ai-gateway/capabilities/observability
