/**
 * imported 카드(RisuAI charx) editdisplay 표시용 HTML 렌더 — **클라이언트 전용**.
 *
 * 우리 채팅은 소설 모드(산문)라 기본적으로 `{@html}` 없이 텍스트만 그린다. 하지만 일부 수입 카드는
 * 감정 스프라이트를 `<style>`+`<div>`+`<img>` 생 HTML 로 그리도록 설계돼 있다(editdisplay 정규식).
 * 그걸 **격리·세정**해서 안전하게 보여주기 위한 파이프라인. RisuAI parser.svelte.ts 레시피 포팅:
 *   ① `<style>` 본문을 hex 로 숨김(`<risu-style>`) → DOMPurify 가 CSS 를 못 건드리게
 *   ② DOMPurify.sanitize (script·on* 핸들러·javascript: 제거, iframe 은 YouTube 만, 위험요소 제거)
 *   ③ `<risu-style>` 복원 → CSS AST 파싱 → **모든 셀렉터에 `.chattext` 스코프 접두** → 재직렬화
 *      (카드 CSS 가 앱 전역으로 새지 않음. @import 는 외부 fetch/exfil 방지로 제거)
 *
 * 보안: untrusted 제작자 HTML + 모델 출력이 섞이므로 세정이 필수. CSS 는 JS 실행 불가(브라우저)지만
 * 전역 오염/외부요청을 스코프+@import 제거로 막는다. window 없으면(SSR) 빈 문자열.
 */
import DOMPurify from 'dompurify';
import { parse, stringify, type CssAtRuleAST } from '@adobe/css-tools';

let hooksReady = false;

/** RisuAI DOMPurify 훅 1회 등록(전역). */
function ensureHooks() {
	if (hooksReady) return;
	// iframe 은 YouTube embed 만 허용(나머지 제거).
	DOMPurify.addHook('uponSanitizeElement', (node, data) => {
		if (data.tagName === 'iframe') {
			const src = (node as Element).getAttribute?.('src') || '';
			if (!src.startsWith('https://www.youtube.com/embed/')) {
				node.parentNode?.removeChild(node);
			}
		}
	});
	// href 는 http(s) 만(→ javascript:/data: 차단), 외부링크는 새 탭.
	DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
		if (data.attrName === 'href') {
			if (data.attrValue.startsWith('http://') || data.attrValue.startsWith('https://')) {
				(node as Element).setAttribute?.('target', '_blank');
				(node as Element).setAttribute?.('rel', 'noopener noreferrer nofollow');
			} else {
				data.attrValue = '';
			}
		}
	});
	hooksReady = true;
}

// ── <style> hex 인코딩(DOMPurify 가 CSS 텍스트를 건드리지 못하게 숨김) ──
const styleRegex = /<style>([\s\S]+?)<\/style>/gi;
const styleDecodeRegex = /<risu-style>([0-9a-f]+)<\/risu-style>/gi;
const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(s: string): string {
	let out = '';
	for (const b of enc.encode(s)) out += b.toString(16).padStart(2, '0');
	return out;
}
function fromHex(h: string): string {
	const bytes = new Uint8Array(h.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return dec.decode(bytes);
}

function encodeStyle(txt: string): string {
	return txt.replace(styleRegex, (_, css: string) => `<risu-style>${toHex(css)}</risu-style>`);
}

/** CSS 규칙을 스코프 클래스 하위로 가둔다(재귀: media/supports 등). @import/@keyframes 는 셀렉터 접두 안 함. */
function scopeRule(rule: CssAtRuleAST, scope: string): CssAtRuleAST | null {
	const r = rule as unknown as {
		type: string;
		selectors?: string[];
		rules?: CssAtRuleAST[];
	};
	if (r.type === 'import') return null; // 외부/데이터 import 제거(폰트 fetch·CSS exfil 방지)
	if (r.type === 'rule' && r.selectors) {
		r.selectors = r.selectors.map((sel) => `${scope} ${sel}`);
	}
	if (
		(r.type === 'media' || r.type === 'supports' || r.type === 'document' || r.type === 'container') &&
		r.rules
	) {
		r.rules = r.rules.map((c) => scopeRule(c, scope)).filter((c): c is CssAtRuleAST => c !== null);
	}
	return rule;
}

function scopeCss(css: string, scope: string): string {
	try {
		const ast = parse(css, { silent: true });
		const rules = ast.stylesheet?.rules;
		if (rules) {
			ast.stylesheet.rules = rules
				.map((r) => scopeRule(r, scope))
				.filter((r): r is CssAtRuleAST => r !== null);
		}
		const out = stringify(ast, { compress: true });
		// 방어: 정규화된 CSS 에 태그 탈출 흔적이 남으면 통째 폐기.
		if (/<\/?(style|script)/i.test(out)) return '';
		return out;
	} catch {
		return '';
	}
}

function decodeStyle(html: string, scope: string): string {
	return html.replace(styleDecodeRegex, (_, hex: string) => `<style>${scopeCss(fromHex(hex), scope)}</style>`);
}

/**
 * 수입 카드 표시 HTML 을 세정·스코프해서 안전한 HTML 문자열로 반환. SSR(window 없음)에선 빈 문자열.
 * @param html  editdisplay 정규식+CBS 평가가 끝난 생 HTML
 * @param scope CSS 를 가둘 컨테이너 셀렉터(기본 `.chattext`)
 */
export function renderCardHtml(html: string, scope = '.chattext'): string {
	if (typeof window === 'undefined') return '';
	ensureHooks();
	const encoded = encodeStyle(html);
	const clean = DOMPurify.sanitize(encoded, {
		ADD_TAGS: ['iframe', 'risu-style'],
		ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'loading', 'decoding', 'target']
	});
	return decodeStyle(clean, scope);
}
