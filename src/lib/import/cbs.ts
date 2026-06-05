/**
 * CBS(Curly Braced Syntax) 베스트에포트 리졸버 — charx import 전용 (순수 함수).
 *
 * RisuAI 카드는 프롬프트/오프닝에 `{{...}}` 매크로를 박아두고 자체 엔진으로 평가한다.
 * Haven 엔 그 엔진이 없으므로, **흔한 패턴만** 로컬에서 풀어내고 못 푸는 건 제거 + 플래그한다.
 * 완전한 RisuAI 호환이 아니다(고급 스크립팅·module.risum 연동은 재현 안 됨).
 *
 * 처리:
 *  - `{{char}}`/`{{user}}`/`{{나}}` → **보존**(Haven 프롬프트 조립이 네이티브로 치환). $lib/placeholders 참고.
 *  - `$FirstMessage` 등 `$토큰` → 제거(RisuAI 내장 슬롯 마커).
 *  - `{{getvar::index}}`→"1"(첫 메시지), `{{getvar::lang}}`→"ko"(한국어 서비스), 그 외 getvar→""
 *  - `{{equal::a::b}}`, `{{not::x}}`, `{{and::..}}`, `{{or::..}}` → 논리 평가
 *  - `{{setvar::..}}`, `{{random::a::b}}`(첫 값), `{{roll::..}}` 등 부수효과/난수는 무해화
 *  - `{{#if_pure COND}}…{{/if_pure}}`, `{{#if COND}}…{{/if}}` → 조건 평가로 분기 채택
 *  - 그래도 남는 미지원 `{{...}}` → 제거하고 usedScripting=true 플래그
 */

/** 알려진 변수 기본값 — 첫 메시지(index=1) · 한국어(lang=ko) 갈래를 채택. */
const KNOWN_VARS: Record<string, string> = {
	index: '1',
	lang: 'ko',
	language: 'ko'
};

// char/user/나 보존용 마스크 토큰(정규식 안전·충돌 없는 사설 마커).
const MASK = {
	char: 'HVNCHAR',
	user: 'HVNUSER',
	na: 'HVNNA'
};

export interface CbsResult {
	text: string;
	/** 풀지 못해 제거한 매크로가 있었나(= 수동 확인 권장). */
	usedScripting: boolean;
}

/** 텍스트에 CBS 매크로(char/user/나 제외)나 $슬롯이 들어있나(빠른 감지). */
export function hasScripting(text: string): boolean {
	if (/\$[A-Za-z]\w*/.test(text)) return true;
	// {{char}}/{{user}}/{{나}} 외의 {{...}} 가 있으면 스크립팅으로 간주.
	const stripped = text.replace(/\{\{\s*(?:char|user|나)\s*\}\}/gi, '');
	return /\{\{[\s\S]*?\}\}/.test(stripped) || /\{\{[#/]/.test(stripped);
}

function truthy(v: string): boolean {
	const t = v.trim();
	return t !== '' && t !== '0' && t.toLowerCase() !== 'false';
}

/** 단일 인라인 매크로(내부에 중첩 {{}} 없음) 평가. 모르면 null(=미지원, 호출부가 제거+플래그). */
function evalInline(content: string): string | null {
	const parts = content.split('::').map((p) => p.trim());
	const head = parts[0].toLowerCase();
	switch (head) {
		case 'getvar':
		case 'getglobalvar':
			return KNOWN_VARS[(parts[1] ?? '').toLowerCase()] ?? '';
		case 'setvar':
		case 'setglobalvar':
		case 'addvar':
			return ''; // 부수효과 무시
		case 'equal':
		case 'equals':
			return parts[1] === parts[2] ? '1' : '0';
		case 'notequal':
		case 'not_equal':
			return parts[1] !== parts[2] ? '1' : '0';
		case 'not':
			return truthy(parts[1] ?? '') ? '0' : '1';
		case 'and':
			return parts.slice(1).every(truthy) ? '1' : '0';
		case 'or':
			return parts.slice(1).some(truthy) ? '1' : '0';
		case 'random':
		case 'pick':
			return parts[1] ?? ''; // 첫 후보로 고정(결정적)
		case 'roll':
		case 'dice':
			return '1';
		case 'blank':
			return '';
		case 'br':
		case 'newline':
			return '\n';
		default:
			return null; // 미지원
	}
}

// 내부에 다른 {{ }} 가 없는 가장 안쪽 매크로. (#, / 로 시작하는 블록 토큰은 별도 처리)
const INNERMOST = /\{\{([^{}]*?)\}\}/;
// if_pure / if 블록 — **가장 안쪽**부터 매칭(본문에 중첩 {{#if 없음) → 안→밖 순서로 해소.
// RisuAI 블록 닫기는 범용 `{{/}}` (또는 {{/if}}, {{/if_pure}}) 를 쓴다.
const IF_BLOCK =
	/\{\{#if(?:_pure)?\s+([^{}]*?)\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/(?:if(?:_pure)?)?\}\}/;

/** 본문의 CBS 를 베스트에포트로 평가/정리한다. */
export function resolveCBS(input: string): CbsResult {
	let usedScripting = false;
	// char/user/나 보존 → 마스킹.
	let text = input
		.replace(/\{\{\s*char\s*\}\}/gi, MASK.char)
		.replace(/\{\{\s*user\s*\}\}/gi, MASK.user)
		.replace(/\{\{\s*나\s*\}\}/g, MASK.na);

	// $슬롯 마커 제거($FirstMessage, $EraseMessage 등).
	if (/\$[A-Za-z]\w*/.test(text)) {
		text = text.replace(/\$[A-Za-z]\w*/g, '');
	}

	// 안→밖 순서로 해소: 매 라운드 (A) 모든 인라인 매크로를 먼저 평가 → 블록 조건이 리터럴이 됨,
	// 그 다음 (B) if 블록을 가장 안쪽부터 분기. 변화가 없을 때까지 반복.
	for (let round = 0; round < 5000; round++) {
		let changed = false;

		// (A) 블록 토큰(#, /)이 아닌 가장 안쪽 인라인 매크로를 전부 평가.
		for (let guard = 0; guard < 100000; guard++) {
			const re = new RegExp(INNERMOST, 'g');
			let hit: RegExpExecArray | null = null;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text))) {
				const c = m[1].trim();
				if (!c.startsWith('#') && !c.startsWith('/')) {
					hit = m;
					break;
				}
			}
			if (!hit) break;
			const val = evalInline(hit[1].trim());
			if (val === null) usedScripting = true;
			text = text.slice(0, hit.index) + (val ?? '') + text.slice(hit.index + hit[0].length);
			changed = true;
		}

		// (B) if 블록 하나(가장 안쪽) 분기.
		const block = IF_BLOCK.exec(text);
		if (block) {
			const body = truthy(block[1]) ? block[2] : '';
			text = text.slice(0, block.index) + body + text.slice(block.index + block[0].length);
			changed = true;
		}

		if (!changed) break;
	}

	// 남은 미지원 매크로/블록 토큰 제거 + 플래그.
	if (/\{\{[\s\S]*?\}\}/.test(text)) {
		usedScripting = true;
		text = text.replace(/\{\{[\s\S]*?\}\}/g, '');
	}

	// 마스크 복원.
	text = text.split(MASK.char).join('{{char}}').split(MASK.user).join('{{user}}').split(MASK.na).join('{{나}}');

	// 과도한 빈 줄 정리(3줄 이상 → 2줄).
	text = text.replace(/\n{3,}/g, '\n\n').trim();

	return { text, usedScripting };
}
