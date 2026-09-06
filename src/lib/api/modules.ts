import type { PromptModule } from '$lib/types';

/**
 * 모듈 Hub API 의 공용(요청/응답) 타입.
 * 워커 라우터(`worker/src/routes/api/modules.ts`)와 SPA 프론트가 같이 import 한다.
 */

/** GET /api/modules/page — 모듈 Hub 페이지(세 탭) 로더 응답. */
export interface ModulesPageData {
	/** 공유된 전체 모듈(Hub 피드). */
	shared: PromptModule[];
	/** 내가 즐겨찾기한 모듈(로그인 시). */
	favorites: PromptModule[];
	/** 내가 만든 모듈(공유/비공개 모두, 로그인 시). */
	saved: PromptModule[];
}

/** GET /api/modules/forchat — 채팅 모듈 모달 후보 응답. */
export interface ModulesForChatData {
	/** 내가 만든 모듈(공유/비공개 모두). */
	saved: PromptModule[];
	/** 내가 즐겨찾기한 모듈(내가 만든 건 saved 에 있으므로 제외). */
	favorites: PromptModule[];
}

/** POST /api/modules · PATCH /api/modules/:id — 생성/수정 JSON 본문. */
export interface ModuleUpsertBody {
	title: string;
	memo?: string;
	prompt: string;
	/** 기본 true(Hub 공개). */
	shared?: boolean;
}

/** 채팅 한 턴에 켤 수 있는 모듈 수 상한(클라·서버 공용). */
export const MAX_ACTIVE_MODULES = 8;
