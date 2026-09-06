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

/**
 * POST /api/characters/assist 응답 — `application/x-ndjson` 스트림(한 줄 = 이벤트 하나).
 *  - progress: 부분 객체 도착(누적 글자수·지금 쓰는 필드). 진행 표시용.
 *  - ping: 조용한 구간(추론 등) heartbeat — 연결 생존 확인용, 내용 없음.
 *  - done: 완성된 초안. 이후 스트림 종료.
 *  - error: 실패(타임아웃·LLM 오류·불완전 결과). 이후 스트림 종료.
 * 스트림 진입 전 실패(401/400/429/500)는 기존처럼 JSON `{ error, message }`.
 */
export type AssistStreamEvent =
	| { t: 'progress'; chars: number; field: string }
	| { t: 'ping' }
	| { t: 'done'; character: AssistDraft }
	| { t: 'error'; message: string; detail?: string };

/**
 * 썸네일 상황 프롬프트(구조화). LLM 이 만들고 패널에서 편집해 되돌려 보낸다.
 *  - base: 인원수·구도·배경·조명·상호작용 태그(전역 캡션).
 *  - scene: 자연어 장면 문장(영어, V5 그림체만 사용).
 *  - characters: 인물별 캡션(외형 + 현재 복장·포즈·표정) — NAI char_captions 로 분리 전송.
 */
export interface ThumbnailPrompt {
	base: string;
	scene: string;
	characters: string[];
}

/** POST /api/characters/thumbnail 요청 바디. */
export interface ThumbnailRequest {
	/** 캐릭터 설정(프롬프트 본문) — 외형 추출용. */
	description?: string;
	/** 그림체(스타일) 프롬프트. 없으면 그림체 미적용. */
	style?: string;
	/** NovelAI 생성 모델 id(고른 그림체에 박힌 값, 허용목록 검증). */
	naiModel?: string;
	/** 그림체의 선택 네거티브/퀄리티 프롬프트(`art_styles.negative/quality`). 비면 모델별 고정값. */
	styleNegative?: string | null;
	styleQuality?: string | null;
	/** 제작자의 자연어 연출 지시(한국어 OK). 어떤 장면·누가 몇 명 나오는지. 비면 주인공 단독 초상. */
	direction?: string;
	/** 편집된 구조화 프롬프트. 있고 regen 이 아니면 LLM 을 거치지 않고 그대로 사용. */
	prompt?: ThumbnailPrompt;
	/** true 면 prompt 가 있어도 설정+연출로 다시 생성. */
	regen?: boolean;
	/** NSFW 캐릭터면 positive 앞에 rating:nsfw. */
	nsfw?: boolean;
	/** 상황 프롬프트 LLM(IMAGE_PROMPT_MODEL_IDS 허용목록). 없으면 기본. */
	model?: string;
}
