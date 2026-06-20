/**
 * 프로필 저장 API 의 공용(요청/응답) 타입.
 * 워커 라우터(`worker/src/routes/api/profile.ts`)와 SPA 프론트가 같이 import 한다.
 *
 * 요청은 `multipart/form-data`(아바타 파일 포함)라 본문 타입은 두지 않고,
 * 폼 필드 이름만 상수로 공유한다(name, persona_name, preference, persona, country, country_code, avatar).
 */

/** POST /api/profile — 저장 성공 응답. */
export interface ProfileSaveResult {
	ok: true;
}
