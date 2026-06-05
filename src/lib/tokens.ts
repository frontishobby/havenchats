/**
 * 프롬프트 토큰 추정 (언어 인지, 순수 함수 — 클라·서버 공용).
 *
 * 정확한 토크나이저가 아니라 폼 길이 제한·표시용 근사치다. 핵심은 언어별 밀도 차이:
 *  - 한국어/CJK: 글자당 토큰이 많다 → 0.5 토큰/글자 (기존 estimateTokens 와 동일 가정)
 *  - 영어/라틴 등: 글자당 토큰이 적다(영어는 한국어의 약 절반) → 0.25 토큰/글자
 *
 * 그래서 같은 글자 수라도 영어가 토큰을 덜 먹는 실제 동작을 반영한다.
 */

function isCJK(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x11ff) || // 한글 자모
		(codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK 구두점
		(codePoint >= 0x3040 && codePoint <= 0x30ff) || // 히라가나·가타카나
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 확장 A
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 통합 한자
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 한글 음절
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 호환 한자
		(codePoint >= 0xff00 && codePoint <= 0xffef) // 전각·반각
	);
}

/** 언어 인지 토큰 추정. CJK 0.5/글자, 그 외 0.25/글자. */
export function estimatePromptTokens(text: string): number {
	let total = 0;
	let cjk = 0;
	for (const ch of text) {
		total++;
		if (isCJK(ch.codePointAt(0) ?? 0)) cjk++;
	}
	const other = total - cjk;
	return Math.ceil(cjk * 0.5 + other * 0.25);
}
