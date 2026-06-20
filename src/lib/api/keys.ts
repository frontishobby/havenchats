/**
 * 외부 API 키 관리 API 의 공용(요청/응답) 타입.
 * 워커 라우터(`worker/src/routes/api/keys.ts`)와 SPA 프론트가 같이 import 한다.
 * provider: 'gateway'(Vercel AI Gateway — 챗/상황프롬프트 LLM), 'novelai'(이미지 생성).
 */

/** POST /api/keys/{gateway,novelai} — 키 등록 요청 본문. */
export interface KeyRegisterRequest {
	key?: string;
}

/** GET/POST/DELETE /api/keys/gateway — Vercel AI Gateway 키 상태. */
export interface GatewayKeyStatus {
	registered: boolean;
	/** GET 응답에만 포함(등록 시점). epoch ms 또는 null. */
	updatedAt?: number | null;
}

/** GET/POST/DELETE /api/keys/novelai — NovelAI 키 상태 + 등급 스냅샷. */
export interface NovelaiKeyStatus {
	registered: boolean;
	isOpus: boolean;
	/** NovelAI 구독 tier(검증 스냅샷). 미등록이면 null. */
	tier: number | null;
	/** GET 응답에만 포함(등록 시점). epoch ms 또는 null. */
	updatedAt?: number | null;
}
