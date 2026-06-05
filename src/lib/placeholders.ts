/**
 * 프롬프트 플레이스홀더 치환 (순수 함수 — 클라이언트·서버 공용).
 *
 * 지원 토큰(대소문자 무시):
 *  - `{{char}}`        → 캐릭터 이름. **캐릭터-불변**이라 시스템 프롬프트 prefix 에 직접
 *                       치환해도 교차-유저 캐싱이 깨지지 않는다.
 *  - `{{나}}`/`{{user}}` → 사용자 이름(없으면 '나'). **유저-가변**이라 시스템 프롬프트의
 *                       캐시 prefix(=제작자 description)에는 치환하지 말고, 모델에 의미만
 *                       설명한다. 오프닝·UI 렌더처럼 유저 단위로 이미 갈라지는 곳에서만 치환.
 *
 * RisuAI(charx) 카드의 {{char}}/{{user}} 도 이 치환으로 그대로 동작한다.
 */

const CHAR_RE = /\{\{\s*char\s*\}\}/gi;
const USER_RE = /\{\{\s*(?:user|나)\s*\}\}/gi;

/** {{char}} → 캐릭터 이름. 캐싱 안전(유저 불변). */
export function fillCharName(text: string, charName: string): string {
	return charName ? text.replace(CHAR_RE, charName) : text;
}

/** {{나}}/{{user}} → 사용자 이름(없으면 '나'). 캐시 prefix 엔 쓰지 말 것. */
export function fillUserName(text: string, userName: string | null | undefined): string {
	const label = (userName && userName.trim()) || '나';
	return text.replace(USER_RE, label);
}

/** 오프닝·UI 렌더용 — {{char}}·{{나}}·{{user}} 전부 치환. */
export function personalize(
	text: string,
	charName: string,
	userName: string | null | undefined
): string {
	return fillUserName(fillCharName(text, charName), userName);
}
