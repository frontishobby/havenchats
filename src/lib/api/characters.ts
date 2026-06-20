/**
 * /api/characters 의 요청/응답 공용 타입.
 * 워커 라우터(worker/src/routes/api/characters.ts)와 SPA 프런트가 함께 import 한다.
 * 단순 shape 은 $lib/types 를 재사용하고, 여러 필드를 묶는 합성 shape 만 여기서 정의한다.
 */
import type { Audience, Character } from '$lib/types';

/** GET /api/characters/:id/edit-data — 수정 폼 로더 응답.
 *  비로그인/권한 미달 등으로 SPA 가 이동해야 하면 `{ redirect }` 만 온다. */
export interface CharacterEditData {
	character: Character;
	ownerId: string;
	/** 관리자가 import 캐릭터를 편집할 때만 스크립트 변수 편집 노출. */
	allowScriptVars: boolean;
	defaultVariables: Record<string, string> | null;
}

/** GET /api/characters/:id/assets-data — 에셋 미리보기 로더 응답. */
export interface CharacterAssetsData {
	character: Character;
}

/** SvelteKit redirect 를 SPA 로 위임하는 응답(로더가 redirect 하던 자리). */
export interface RedirectResponse {
	redirect: string;
}

/** 제작 폼의 현재 내용(assist 수정 모드용 — 있으면 보존하며 새 요청만 반영). */
export interface AssistCurrentDraft {
	name?: string;
	tagline?: string;
	intro?: string;
	description?: string;
	tags?: string[];
	greetings?: { name?: string; content?: string }[];
	audience?: string;
	nsfw?: boolean;
}

/** POST /api/characters/assist 요청 바디. */
export interface AssistRequest {
	/** 자연어 러프 설정. */
	rough?: string;
	/** 제작 폼의 현재 NSFW 토글(힌트). */
	nsfw?: boolean;
	/** 생성에 사용할 모델 id(허용목록 검증). 없으면 기본 모델. */
	model?: string;
	/** 제작 폼의 현재 내용(있고 비어있지 않으면 수정 모드). */
	current?: AssistCurrentDraft;
}

/** assist 가 폼에 채워 돌려주는 캐릭터 초안. */
export interface AssistDraft {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	tags: string[];
	greetings: { name: string; content: string }[];
	audience: Audience;
	nsfw: boolean;
}

/** POST /api/characters/assist 성공 응답. */
export interface AssistResponse {
	ok: true;
	character: AssistDraft;
}
