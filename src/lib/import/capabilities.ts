/**
 * charx 의 **동적 기능 탐지** — 가져오면 빠지거나 동작하지 않는 것들을 사용자 경고로 노출.
 *
 * 텍스트(성격/세계관/오프닝)는 cardToCharacter 가 거의 다 가져온다. 하지만 트리거·정규식·CJS·
 * 키워드 로어북처럼 "런타임에 동작하는" 기능은 아직 Haven 에 엔진이 없어 재현되지 않는다.
 * 여기선 그것들이 카드에 **들어있는지**를 구조적으로 스캔해서 "조용한 누락 → 명시 고지"로 바꾼다.
 *
 * 데이터 출처(원본 RisuAI):
 *  - charx export 는 트리거/정규식을 `module.risum` 으로 옮긴다 → readModuleMeta 로 디코드한 module.
 *  - PNG 유래 카드는 `card.json data.extensions.risuai` 에 남아있을 수 있다 → 보너스로 함께 스캔.
 *
 * 트리거 분류(effect 기준):
 *  - empty: 효과 없음, 또는 v2Header(빈 마커)만 → 편집 중 남은 빈 슬롯. **경고 안 함.**
 *  - code : `triggerlua`(Lua)/`triggercode` 등 코드 효과 → CJS 급 프로그래밍. 미지원(영구).
 *  - v2   : `v2*` 블록 프로그래밍 언어. 미지원(영구).
 *  - v1   : 그 외 조건→효과(setvar/systemprompt/impersonate…). 경량 트리거로 지원 예정(로드맵 3순위).
 * 주의: "있다/없다"만 정확. 그게 없어도 카드가 쓸 만한지는 알 수 없다(핵심 기믹이면 껍데기, 곁다리면 무해).
 */

import type { V3Card } from './cardToCharacter';
import type { RisuModuleMeta } from './risum';

interface RisuExt {
	triggerscript?: unknown;
	customScripts?: unknown;
	virtualscript?: unknown;
	lowLevelAccess?: unknown;
}

function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/** 트리거 하나를 분류: 'empty' | 'code'(Lua/코드) | 'v2'(블록 프로그래밍) | 'v1'(조건→효과). */
function classifyTrigger(t: unknown): 'empty' | 'code' | 'v2' | 'v1' {
	const effects = arr((t as { effect?: unknown })?.effect);
	// 의미 있는 효과만(빈 v2Header 마커는 제외).
	const meaningful = effects.filter((e) => {
		const type = str((e as { type?: unknown })?.type);
		if (type === 'v2Header') return str((e as { code?: unknown })?.code).trim() !== '';
		return type !== '';
	});
	if (meaningful.length === 0) return 'empty';
	const types = meaningful.map((e) => str((e as { type?: unknown })?.type));
	if (types.some((t2) => t2 === 'triggerlua' || t2 === 'triggercode')) return 'code';
	if (types.some((t2) => t2.startsWith('v2'))) return 'v2';
	return 'v1';
}

/** 카드 + (있으면) risum module 을 스캔해 미지원 동적 기능 경고 문자열을 만든다. */
export function scanUnsupported(card: V3Card, module: RisuModuleMeta | null): string[] {
	const warns: string[] = [];
	const ext = ((card.data as { extensions?: { risuai?: RisuExt } } | undefined)?.extensions
		?.risuai ?? {}) as RisuExt;

	// 트리거 분류(빈 슬롯은 경고 안 함).
	const triggers = [...arr(module?.trigger), ...arr(ext.triggerscript)];
	let v1 = 0;
	let v2 = 0;
	let code = 0;
	for (const t of triggers) {
		const c = classifyTrigger(t);
		if (c === 'v1') v1++;
		else if (c === 'v2') v2++;
		else if (c === 'code') code++;
		// 'empty' 는 무시
	}
	if (v1 > 0) {
		warns.push(`트리거(조건→효과) ${v1}개는 아직 동작하지 않아요 — 호감도·조건부 이벤트 등(지원 예정).`);
	}
	if (v2 > 0) {
		warns.push(`프로그래밍형 트리거(V2) ${v2}개는 동작하지 않아요 — 복잡한 스크립트라 미지원이에요.`);
	}
	if (code > 0) {
		warns.push(`스크립트(Lua 코드) 트리거 ${code}개는 실행되지 않아요 — 미지원이에요.`);
	}

	const regex = arr(module?.regex).length + arr(ext.customScripts).length;
	if (regex > 0) {
		warns.push(`정규식 치환 스크립트 ${regex}개는 적용되지 않아요 — 출력 가공·서식 정리·필터가 빠집니다.`);
	}

	if (str(module?.cjs).trim() || str(ext.virtualscript).trim()) {
		warns.push('커스텀 코드(JavaScript)가 들어있지만 실행되지 않아요 — 미지원이에요.');
	}

	// 로어북·CBS 변수/조건/랜덤은 이제 가져와 동작하므로 경고 없음.

	if (module?.lowLevelAccess || ext.lowLevelAccess) {
		warns.push('저수준 시스템 접근을 요구하는 스크립트가 있어요 — 동작하지 않습니다.');
	}

	return warns;
}
