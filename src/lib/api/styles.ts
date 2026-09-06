import type { ArtStyle } from '$lib/types';

/**
 * 그림체(스타일) Hub API 의 공용(요청/응답) 타입.
 * 워커 라우터(`worker/src/routes/api/styles.ts`)와 SPA 프론트가 같이 import 한다.
 * 단일 엔티티는 `$lib/types`(ArtStyle)을 재사용하고, 여기엔 **합성(composite) 형태만** 정의한다.
 */

/** GET /api/styles/page — 그림체 Hub 페이지(세 탭) 로더 응답. */
export interface StylesPageData {
	/** 공유된 전체 그림체(Hub 피드). */
	shared: ArtStyle[];
	/** 내가 즐겨찾기한 그림체(로그인 시). */
	favorites: ArtStyle[];
	/** 내가 만든 그림체(공유/저장 모두, 로그인 시). */
	saved: ArtStyle[];
}

/** GET /api/styles/forchat — 채팅 이미지 모달 그림체 선택지 응답. */
export interface StylesForChatData {
	/** 내가 만든 그림체(공유/저장 모두). */
	saved: ArtStyle[];
	/** 내가 즐겨찾기한 그림체(내가 만든 건 saved 에 있으므로 제외). */
	favorites: ArtStyle[];
	/** 추천/즐겨찾기/저장이 하나도 없을 때 쓸 기본값(가장 먼저 공유된 그림체). */
	fallback: ArtStyle | null;
}

/** POST /api/styles/generate — 워크숍/썸네일 미리보기 생성 요청 본문. */
export interface StyleGenerateRequest {
	style?: string;
	situation?: string;
	resolution?: string;
	thumbnail?: boolean;
	/** NovelAI 모델 id(`lib/naiModels.ts` 허용목록). 없으면 기본(V5 Full). */
	model?: string;
	/** 선택 네거티브 프롬프트(비면 모델별 고정 네거티브). */
	negative?: string;
	/** 선택 퀄리티 프롬프트(비면 모델별 고정 퀄리티 꼬리). */
	quality?: string;
}

/**
 * POST /api/styles/generate — NDJSON 스트림 프레임.
 *  - frame: 중간 프레임(base64)
 *  - final: 최종 이미지(base64)
 *  - error: 생성 실패 사유
 */
export type StyleGenerateFrame =
	| { t: 'frame'; img: string }
	| { t: 'final'; img: string }
	| { t: 'error'; message: string };
