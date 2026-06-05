/**
 * CBS(Curly Braced Syntax) 평가 엔진 — 클라/서버 공용 순수함수.
 *
 * charx(RisuAI) 카드는 프롬프트에 `{{getvar::x}}`·`{{setvar}}`·`{{#if}}`·`{{random}}`·`{{calc}}`
 * 같은 매크로로 세션마다 변하는 상태를 표현한다. 이 엔진은 그걸 **컨텍스트(변수 상태·턴 index·
 * 시드 RNG)** 기준으로 평가한다.
 *  - 런타임(채팅): `evalCBS(text, ctx)` — ctx.vars 를 읽고/쓰며(setvar) 매 턴 동적 평가.
 *  - import 정적 평탄화(greeting·표시용): `resolveCBSStatic(text)` — 빈 상태·index=1·첫 옵션 고정.
 *
 * `{{char}}/{{나}}/{{user}}` 는 CBS 가 아니라 placeholders.ts 가 처리하므로 여기선 마스킹·보존만 한다.
 */

/** 평가 컨텍스트. vars 는 setvar/addvar 가 제자리 변이(mutate)한다. */
export interface CbsContext {
	/** 세션 변수($name → 값). 키는 소문자 정규화. */
	vars: Record<string, string>;
	/** 턴 번호(message_count). `{{index}}`/`{{getvar::index}}`. */
	index: number;
	/** 언어 코드. `{{lang}}`. */
	lang: string;
	/** [0,1) 결정적 난수원. random/roll 에 사용(턴 시드). */
	rng: () => number;
	/** 현재 시각(epoch ms). time/date/unixtime/datetimeformat 에 사용. 결정성 위해 ctx 로 주입. */
	now: number;
}

export interface CbsResult {
	text: string;
	/** 평가 못 해 제거한 매크로가 있었나(로깅/경고용). */
	usedScripting: boolean;
}

const MASK = { char: 'HVNCHAR', user: 'HVNUSER', na: 'HVNNA' };
// 이스케이프 매크로가 만든 리터럴 중괄호는 마지막 미지원-매크로 정리에 다시 지워지므로,
// 마스크로 내보냈다가 맨 끝(정리 후)에 복원한다.
const BRACE = { lb: 'HVNLB', rb: 'HVNRB', llb: 'HVNLLB', rrb: 'HVNRRB' };

const INNERMOST = /\{\{([^{}]*?)\}\}/;
const IF_BLOCK =
	/\{\{#if(?:_pure)?\s+([^{}]*?)\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/(?:if(?:_pure)?)?\}\}/;
// 현대식 조건 블록 {{#when COND}}…{{:else}}…{{/when}} — 가장 안쪽부터.
const WHEN_BLOCK =
	/\{\{#when\s+([^{}]*?)\}\}((?:(?!\{\{#when)[\s\S])*?)\{\{\/when\}\}/;

/** 텍스트에 CBS 매크로(char/user/나 제외)나 $슬롯이 있나(빠른 감지). */
export function hasScripting(text: string): boolean {
	if (/\$[A-Za-z]\w*/.test(text)) return true;
	const stripped = text.replace(/\{\{\s*(?:char|user|나)\s*\}\}/gi, '');
	return /\{\{[\s\S]*?\}\}/.test(stripped) || /\{\{[#/]/.test(stripped);
}

/** sessionId+index 로 시드한 결정적 RNG(mulberry32). Math.random 미사용 → 재평가 안정. */
export function makeRng(seed: string): () => number {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = h >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function truthy(v: string): boolean {
	const t = v.trim();
	return t !== '' && t !== '0' && t.toLowerCase() !== 'false';
}

/** 안전한 사칙연산 평가(+ - * / % ^ 괄호, 단항부호). 직접 eval 금지. 실패 시 ''. */
function calc(expr: string): string {
	const toks = expr.match(/\d+\.?\d*|[()+\-*/%^]/g);
	if (!toks) return '';
	let i = 0;
	const peek = () => toks[i];
	const next = () => toks[i++];
	const factor = (): number => {
		if (peek() === '(') {
			next();
			const v = expr2();
			if (peek() === ')') next();
			return v;
		}
		if (peek() === '-') {
			next();
			return -factor();
		}
		if (peek() === '+') {
			next();
			return factor();
		}
		const n = Number(next());
		return Number.isFinite(n) ? n : NaN;
	};
	// 거듭제곱(^) — 우결합, * / 보다 우선.
	const power = (): number => {
		const b = factor();
		if (peek() === '^') {
			next();
			return Math.pow(b, power());
		}
		return b;
	};
	const term = (): number => {
		let v = power();
		while (peek() === '*' || peek() === '/' || peek() === '%') {
			const op = next();
			const r = power();
			v = op === '*' ? v * r : op === '/' ? v / r : v % r;
		}
		return v;
	};
	function expr2(): number {
		let v = term();
		while (peek() === '+' || peek() === '-') {
			const op = next();
			const r = term();
			v = op === '+' ? v + r : v - r;
		}
		return v;
	}
	const result = expr2();
	if (!Number.isFinite(result)) return '';
	return Number.isInteger(result) ? String(result) : String(Math.round(result * 1e6) / 1e6);
}

/** 숫자 변환(실패 0). 정수면 정수 문자열, 아니면 소수 정리. */
function num(v: string): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
function numStr(n: number): string {
	if (!Number.isFinite(n)) return '0';
	return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

/**
 * datetimeformat 패턴 치환 — RisuAI dateTimeFormat 와 동일한 토큰·순서(dayjs 식, 로컬 시각).
 * 토큰: YYYY YY MMMM MMM MM DDDD DD dddd ddd HH hh mm ss X x A. (단일 M/D/h 는 RisuAI 에 없음)
 * 순차 치환이라 긴 토큰부터(YYYY→YY 등). 원본: parser/parser.svelte.ts dateTimeFormat.
 */
function formatDateTime(ms: number, pattern: string): string {
	if (!pattern) return '';
	let main = pattern.startsWith(':') ? pattern.slice(1) : pattern;
	if (main.length > 300) return '';
	const d = new Date(ms);
	const intl = (opt: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', opt).format(d);
	return main
		.replace(/YYYY/g, String(d.getFullYear()))
		.replace(/YY/g, String(d.getFullYear()).slice(2))
		.replace(/MMMM/g, intl({ month: 'long' }))
		.replace(/MMM/g, intl({ month: 'short' }))
		.replace(/MM/g, String(d.getMonth() + 1).padStart(2, '0'))
		.replace(/DDDD/g, String(
			Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000)
		))
		.replace(/DD/g, String(d.getDate()).padStart(2, '0'))
		.replace(/dddd/g, intl({ weekday: 'long' }))
		.replace(/ddd/g, intl({ weekday: 'short' }))
		.replace(/HH/g, String(d.getHours()).padStart(2, '0'))
		.replace(/hh/g, String(d.getHours() % 12 || 12).padStart(2, '0'))
		.replace(/mm/g, String(d.getMinutes()).padStart(2, '0'))
		.replace(/ss/g, String(d.getSeconds()).padStart(2, '0'))
		.replace(/X/g, String(Math.floor(d.getTime() / 1000)))
		.replace(/x/g, String(d.getTime()))
		.replace(/A/g, d.getHours() >= 12 ? 'PM' : 'AM');
}

/** JSON 배열 문자열로 파싱(실패 시 빈 배열). split/join 등 배열 매크로 공용. */
function asArray(v: string): string[] {
	try {
		const p = JSON.parse(v);
		if (Array.isArray(p)) return p.map((x) => String(x));
	} catch {
		// 무시
	}
	return [];
}

/**
 * {{#when COND}} 조건 평가. 인라인 매크로는 이미 풀려 COND 는 리터럴 토큰 문자열이다.
 * 지원: 단일(truthy) · `not X` · `var X`(변수 truthy) · `A is/isnot B` · `A >|<|>=|<= B` · `A and/or B`.
 */
function evalWhenCond(cond: string, ctx: CbsContext): boolean {
	const toks = cond.trim().split(/\s+/).filter(Boolean);
	if (toks.length === 0) return false;
	if (toks.length === 1) return truthy(toks[0]);
	if (toks[0] === 'not') return !truthy(toks.slice(1).join(' '));
	if (toks[0] === 'var') return truthy(ctx.vars[(toks[1] ?? '').toLowerCase()] ?? '');
	const a = toks[0];
	const op = toks[1];
	const b = toks.slice(2).join(' ');
	switch (op) {
		case 'is':
		case '==':
			return a === b;
		case 'isnot':
		case '!=':
			return a !== b;
		case '>':
			return num(a) > num(b);
		case '<':
			return num(a) < num(b);
		case '>=':
			return num(a) >= num(b);
		case '<=':
			return num(a) <= num(b);
		case 'and':
			return truthy(a) && truthy(b);
		case 'or':
			return truthy(a) || truthy(b);
		default:
			return truthy(cond);
	}
}

/** 단일 인라인 매크로(내부 {{}} 없음) 평가. 모르면 null(=미지원, 호출부가 제거+플래그). ctx 변이 가능. */
function evalInline(content: string, ctx: CbsContext): string | null {
	const raw = content.split('::'); // 공백 유지(replace/split/join 구분자용)
	const parts = raw.map((p) => p.trim());
	const head = parts[0].toLowerCase();
	const vget = (name: string): string => {
		const k = name.toLowerCase();
		if (k === 'index') return String(ctx.index);
		if (k === 'lang' || k === 'language') return ctx.lang;
		return ctx.vars[k] ?? '';
	};
	switch (head) {
		case 'getvar':
		case 'getglobalvar':
			return vget(parts[1] ?? '');
		case 'setvar':
		case 'setglobalvar': {
			const k = (parts[1] ?? '').toLowerCase();
			if (k) ctx.vars[k] = parts[2] ?? '';
			return '';
		}
		case 'setdefaultvar': {
			const k = (parts[1] ?? '').toLowerCase();
			if (k && !(k in ctx.vars)) ctx.vars[k] = parts[2] ?? '';
			return '';
		}
		case 'addvar':
		case 'addglobalvar': {
			const k = (parts[1] ?? '').toLowerCase();
			if (k) ctx.vars[k] = String((Number(ctx.vars[k]) || 0) + (Number(parts[2]) || 0));
			return '';
		}
		case 'calc':
		case '?':
			return calc(parts.slice(1).join('::'));
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
		case 'pick': {
			const opts = parts.slice(1);
			if (opts.length === 0) return '';
			return opts[Math.floor(ctx.rng() * opts.length)] ?? opts[0];
		}
		case 'roll':
		case 'dice': {
			// RisuAI 표기법: NdM(주사위 N개·M면) 또는 단일 M(=1dM). 무인자 → '1'.
			if (!parts[1]) return '1';
			const notation = parts[1].toLowerCase().split('d');
			let nDice = 1;
			let sides = 6;
			if (notation.length === 2) {
				nDice = Number(notation[0] || 1);
				sides = Number(notation[1] || 6);
			} else {
				sides = Number(notation[0]);
			}
			if (!Number.isFinite(nDice) || !Number.isFinite(sides) || nDice < 1 || sides < 1) return 'NaN';
			let total = 0;
			for (let k = 0; k < nDice; k++) total += 1 + Math.floor(ctx.rng() * sides);
			return String(total);
		}
		case 'index':
			return String(ctx.index);
		case 'lang':
			return ctx.lang;
		case 'blank':
		case 'none':
			return '';
		case 'br':
		case 'newline':
			return '\n';

		// ── 비교 연산 ──
		case 'greater':
			return num(parts[1]) > num(parts[2]) ? '1' : '0';
		case 'less':
			return num(parts[1]) < num(parts[2]) ? '1' : '0';
		case 'greaterequal':
		case 'greater_equal':
			return num(parts[1]) >= num(parts[2]) ? '1' : '0';
		case 'lessequal':
		case 'less_equal':
			return num(parts[1]) <= num(parts[2]) ? '1' : '0';

		// ── 수학 함수 ──
		case 'round':
			return numStr(Math.round(num(parts[1])));
		case 'floor':
			return numStr(Math.floor(num(parts[1])));
		case 'ceil':
			return numStr(Math.ceil(num(parts[1])));
		case 'abs':
			return numStr(Math.abs(num(parts[1])));
		case 'remaind':
			return numStr(num(parts[1]) % num(parts[2]));
		case 'pow':
			return numStr(Math.pow(num(parts[1]), num(parts[2])));
		case 'min':
			return numStr(Math.min(...parts.slice(1).map(num)));
		case 'max':
			return numStr(Math.max(...parts.slice(1).map(num)));
		case 'sum':
			return numStr(parts.slice(1).reduce((s, x) => s + num(x), 0));
		case 'average': {
			const ns = parts.slice(1).map(num);
			return ns.length ? numStr(ns.reduce((s, x) => s + x, 0) / ns.length) : '0';
		}
		case 'randint': {
			const lo = Math.floor(num(parts[1]));
			const hi = Math.floor(num(parts[2]));
			return String(lo + Math.floor(ctx.rng() * Math.max(1, hi - lo + 1)));
		}

		// ── 문자열 (구분자·치환문자는 공백 유지 위해 raw 사용) ──
		case 'replace':
			return (raw[1] ?? '').split(raw[2] ?? '').join(raw[3] ?? '');
		case 'trim':
			return (parts[1] ?? '').trim();
		case 'length':
			return String((parts[1] ?? '').length);
		case 'lower':
		case 'tolowercase':
			return (parts[1] ?? '').toLowerCase();
		case 'upper':
		case 'touppercase':
			return (parts[1] ?? '').toUpperCase();
		case 'capitalize':
			return (parts[1] ?? '').replace(/^./, (c) => c.toUpperCase());
		case 'startswith':
			return (parts[1] ?? '').startsWith(parts[2] ?? '') ? '1' : '0';
		case 'endswith':
			return (parts[1] ?? '').endsWith(parts[2] ?? '') ? '1' : '0';
		case 'contains':
			return (parts[1] ?? '').includes(parts[2] ?? '') ? '1' : '0';
		case 'reverse':
			return [...(parts[1] ?? '')].reverse().join('');
		case 'tonumber':
			// RisuAI: 숫자/소수점 문자만 남겨 이어붙임 ("lv1a2"→"12").
			return [...(parts[1] ?? '')].filter((v) => !isNaN(Number(v)) || v === '.').join('');
		case 'split':
			return JSON.stringify((raw[1] ?? '').split(raw[2] ?? ''));
		case 'join':
			return asArray(parts[1] ?? '').join(raw[2] ?? '');
		case 'spread':
			return asArray(parts[1] ?? '').join('::');
		case 'arraylength':
			return String(asArray(parts[1] ?? '').length);

		// ── 시간/날짜(ctx.now 기준) — RisuAI: 무인자는 비패딩, 인자는 dateTimeFormat ──
		case 'unixtime':
			return String(Math.floor(ctx.now / 1000));
		case 'time': {
			const d = new Date(ctx.now);
			return raw[1] ? formatDateTime(ctx.now, raw[1]) : `${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`;
		}
		case 'date':
		case 'datetimeformat':
		case 'datetime': {
			const d = new Date(ctx.now);
			return raw[1]
				? formatDateTime(ctx.now, raw[1])
				: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
		}
		case 'isotime':
			return new Date(ctx.now).toISOString().slice(11, 19);
		case 'isodate':
			return new Date(ctx.now).toISOString().slice(0, 10);

		// ── 이스케이프/표시(리터럴 문자) — 중괄호는 마스크로 내보내 끝에서 복원 ──
		case 'decbo':
		case 'displayescapedcurlybracketopen':
			return BRACE.lb;
		case 'decbc':
		case 'displayescapedcurlybracketclose':
			return BRACE.rb;
		case 'bo':
		case 'ddecbo':
			return BRACE.llb;
		case 'bc':
		case 'ddecbc':
			return BRACE.rrb;
		case 'debo':
		case 'displayescapedbracketopen':
			return '(';
		case 'debc':
		case 'displayescapedbracketclose':
			return ')';
		case 'dec':
		case 'displayescapedcolon':
			return ':';

		// ── 주석(표시 안 함) ──
		case '//':
		case 'comment':
			return '';

		default:
			return null;
	}
}

/**
 * 본문의 CBS 를 ctx 기준으로 평가/정리. ctx.vars 는 setvar/addvar 로 변이된다.
 * 안→밖 순서로 인라인 매크로를 모두 풀고(블록 조건이 리터럴이 됨), if 블록을 가장 안쪽부터 분기.
 */
export function evalCBS(input: string, ctx: CbsContext): CbsResult {
	let usedScripting = false;
	let text = input
		.replace(/\{\{\s*char\s*\}\}/gi, MASK.char)
		.replace(/\{\{\s*user\s*\}\}/gi, MASK.user)
		.replace(/\{\{\s*나\s*\}\}/g, MASK.na);

	// $슬롯 마커 제거($FirstMessage 등).
	if (/\$[A-Za-z]\w*/.test(text)) text = text.replace(/\$[A-Za-z]\w*/g, '');

	for (let round = 0; round < 5000; round++) {
		let changed = false;

		// (A) 블록 토큰(#, /) 아닌 가장 안쪽 인라인 매크로를 전부 평가.
		for (let guard = 0; guard < 100000; guard++) {
			const re = new RegExp(INNERMOST, 'g');
			let hit: RegExpExecArray | null = null;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text))) {
				const c = m[1].trim();
				// 블록 토큰(#if/#when/#each), 종료(/if), 분기(:else)는 인라인 평가에서 제외 → 블록 처리에 맡긴다.
				if (!c.startsWith('#') && !c.startsWith('/') && !c.startsWith(':')) {
					hit = m;
					break;
				}
			}
			if (!hit) break;
			// trim 하지 않고 넘긴다 — evalInline 이 head·인자는 자체 trim 하되 replace/split 구분자는 공백 보존.
			const val = evalInline(hit[1], ctx);
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

		// (C) when 블록 하나(가장 안쪽) 분기 — {{:else}} 지원.
		const when = WHEN_BLOCK.exec(text);
		if (when) {
			const elseIdx = when[2].indexOf('{{:else}}');
			const thenBody = elseIdx >= 0 ? when[2].slice(0, elseIdx) : when[2];
			const elseBody = elseIdx >= 0 ? when[2].slice(elseIdx + '{{:else}}'.length) : '';
			const body = evalWhenCond(when[1], ctx) ? thenBody : elseBody;
			text = text.slice(0, when.index) + body + text.slice(when.index + when[0].length);
			changed = true;
		}

		if (!changed) break;
	}

	// 남은 미지원 매크로/블록 토큰 제거 + 플래그.
	if (/\{\{[\s\S]*?\}\}/.test(text)) {
		usedScripting = true;
		text = text.replace(/\{\{[\s\S]*?\}\}/g, '');
	}

	// 마스크 복원(placeholders 가 이후 치환).
	text = text
		.split(MASK.char)
		.join('{{char}}')
		.split(MASK.user)
		.join('{{user}}')
		.split(MASK.na)
		.join('{{나}}');

	// 이스케이프 중괄호 복원(정리 후라 다시 안 지워짐).
	text = text
		.split(BRACE.llb)
		.join('{{')
		.split(BRACE.rrb)
		.join('}}')
		.split(BRACE.lb)
		.join('{')
		.split(BRACE.rb)
		.join('}');

	text = text.replace(/\n{3,}/g, '\n\n').trim();
	return { text, usedScripting };
}

/** import 정적 컨텍스트 — 빈 변수·index=1·첫 옵션 고정(기존 평탄화 동작 재현). */
function staticCtx(): CbsContext {
	return { vars: {}, index: 1, lang: 'ko', rng: () => 0, now: Date.now() };
}

/** 정적 평가(결과 텍스트만) — greeting·표시용 필드의 import 평탄화. */
export function resolveCBSStatic(text: string): string {
	return evalCBS(text, staticCtx()).text;
}

/** 정적 평가(텍스트+usedScripting) — import 호환용. */
export function resolveCBS(text: string): CbsResult {
	return evalCBS(text, staticCtx());
}
