# haven-d1-api

비-Workers 호스트(Vercel 등)에 올린 Haven 앱이 D1(`haven`)을 HTTP 로 쓰기 위한 **얇은 프록시 Worker**.
D1Database 의 `prepare/bind` 인터페이스를 그대로 미러링한다.

앱 쪽은 이 엔드포인트를 호출하는 "원격 D1 클라이언트" shim 으로 기존 `src/lib/server/db/*` 코드를 거의 그대로 재사용한다.

## 엔드포인트

모두 `POST`, `Authorization: Bearer <APP_SECRET>` 필요. (`/health` 만 예외, `GET`)

| 경로 | 바디 | D1 대응 |
|---|---|---|
| `GET /health` | — | 헬스체크(인증 불필요) |
| `/query/all` | `{ sql, params? }` | `prepare(sql).bind(...params).all()` |
| `/query/first` | `{ sql, params? }` | `prepare(sql).bind(...params).first()` → `{ result }` |
| `/query/run` | `{ sql, params? }` | `prepare(sql).bind(...params).run()` |
| `/query/batch` | `{ statements: [{ sql, params? }] }` | `batch([...])` |
| `/query/exec` | `{ sql }` | `exec(sql)` (DDL/멀티문) |

## 배포

루트의 wrangler 를 재사용한다(별도 install 불필요). 루트에서:

```bash
export $(grep -E '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=' .env | xargs)

# 공유 시크릿 생성·등록 (한 번)
openssl rand -base64 32 | npx wrangler secret put APP_SECRET --config d1-worker/wrangler.jsonc

# 배포
npx wrangler deploy --config d1-worker/wrangler.jsonc
```

## 보안

- `/query/*` 는 임의 SQL 을 실행하므로 **시크릿이 곧 DB 전체 권한**이다. 강한 랜덤값을 쓰고 절대 노출 금지.
- 앱(Vercel) 쪽엔 같은 값을 env `D1_API_SECRET` 로 보관하고 Bearer 헤더로 전송한다.
- 추후 강화: 특정 statement 화이트리스트 / 도메인 RPC 엔드포인트로 좁히기.
