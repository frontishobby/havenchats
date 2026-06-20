import type { NamedImage } from '$lib/types';

/**
 * charx 가져오기(import) API 의 공용(응답) 타입.
 * 워커 라우터(`worker/src/routes/api/import.ts`)와 SPA 프론트가 같이 import 한다.
 */

/** POST /api/import/charx — ① 생성 단계 응답(캐릭터 id + id 할당된 이미지 manifest). */
export interface ImportCreateResult {
	id: string;
	images: NamedImage[];
}

/** POST /api/import/charx/:id/assets — ② 배치 업로드 응답. */
export interface ImportAssetsResult {
	/** 업로드 성공한 이미지 id 목록. */
	uploaded: string[];
	/** 업로드 실패(혹은 형식/용량 거부)한 이미지 id 목록. */
	failed: string[];
}

/** POST /api/import/charx/:id/finalize — ③ 마무리(image_set 확정) 응답. */
export interface ImportFinalizeResult {
	ok: true;
	count: number;
}

/** POST /api/import/analyze-script — 스크립트 분석 응답. */
export interface ImportAnalyzeResult {
	analysis: string;
	model: string;
	analyzed: number;
}
