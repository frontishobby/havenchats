/**
 * NovelAI 이미지 생성 모델 레지스트리 — 클라/서버 공용(순수 데이터).
 *
 * 그림체(art_styles.model)는 특정 모델 세대에 맞춰 깎이므로 모델 id 를 그림체에 박고,
 * 워크숍 미리보기·썸네일·채팅 실시간 이미지 모두 **고른 그림체의 모델**로 요청한다.
 * V4.5 시절에 만든 기존 그림체는 마이그레이션 기본값으로 V4.5 Full 마킹.
 *
 * 요청 바디 차이(NovelAI 프런트 캐패빌리티 테이블 기준, 2026-08-21):
 *  - V5: params_version 4, noise_schedule 은 karras 고정, SMEA/Decrisper/Variety+ 없음,
 *    cfg_rescale 유지, 인물 캡션 최대 32(V4.5 는 6). v4_prompt/v4_negative_prompt 바디 이름은 그대로.
 *  - Opus 무료 생성: V4.5 이하는 무제한, V5 는 사용량 배터리(소진 시 Anlas 차감).
 */

export interface NaiModel {
	id: string;
	/** UI 표기("V5 Full"). */
	label: string;
	/** 배지용 짧은 표기("V5"/"V5C"/"V4.5"). */
	short: string;
	version: 'v5' | 'v4.5';
	/** 인물(char_captions) 최대 개수. */
	maxCharacters: number;
}

export const NAI_MODELS: readonly NaiModel[] = [
	{ id: 'nai-diffusion-5-full', label: 'V5 Full', short: 'V5', version: 'v5', maxCharacters: 32 },
	{ id: 'nai-diffusion-5-curated', label: 'V5 Curated', short: 'V5C', version: 'v5', maxCharacters: 32 },
	{ id: 'nai-diffusion-4-5-full', label: 'V4.5 Full', short: 'V4.5', version: 'v4.5', maxCharacters: 6 }
] as const;

/** 새 그림체·그림체 미지정 시 기본 모델. */
export const DEFAULT_NAI_MODEL = 'nai-diffusion-5-full';
/** V5 이전에 만들어진 그림체(마이그레이션 기본값). */
export const LEGACY_NAI_MODEL = 'nai-diffusion-4-5-full';

const BY_ID = new Map(NAI_MODELS.map((m) => [m.id, m]));

export function isNaiModelId(v: unknown): v is string {
	return typeof v === 'string' && BY_ID.has(v);
}

/** 모델 조회. 미허용/미지정이면 기본(V5 Full). */
export function getNaiModel(id: string | null | undefined): NaiModel {
	return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_NAI_MODEL)!;
}

/** 요청값 정규화 — 허용목록에 있으면 그대로, 아니면 기본 모델 id. */
export function pickNaiModel(id: unknown): string {
	return isNaiModelId(id) ? id : DEFAULT_NAI_MODEL;
}
