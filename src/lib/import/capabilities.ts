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
 * 주의: "있다/없다"만 정확. 향후 트리거/정규식 엔진을 구현하면(로드맵 docs/risuai-import-roadmap.md)
 * effect.type 별 supported/skipped 분류로 세분화한다. 지금은 전부 "동작 안 함"으로 본다.
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

/** 카드 + (있으면) risum module 을 스캔해 미지원 동적 기능 경고 문자열을 만든다. */
export function scanUnsupported(card: V3Card, module: RisuModuleMeta | null): string[] {
	const warns: string[] = [];
	const ext = ((card.data as { extensions?: { risuai?: RisuExt } } | undefined)?.extensions
		?.risuai ?? {}) as RisuExt;

	const triggers = arr(module?.trigger).length + arr(ext.triggerscript).length;
	if (triggers > 0) {
		warns.push(
			`트리거(자동 규칙) ${triggers}개는 재현되지 않아요 — 호감도·조건부 이벤트·자동 분기 같은 동작이 빠집니다.`
		);
	}

	const regex = arr(module?.regex).length + arr(ext.customScripts).length;
	if (regex > 0) {
		warns.push(
			`정규식 치환 스크립트 ${regex}개는 적용되지 않아요 — 출력 가공·서식 정리·텍스트 필터가 빠집니다.`
		);
	}

	if (str(module?.cjs).trim() || str(ext.virtualscript).trim()) {
		warns.push('커스텀 코드(스크립트)가 들어있지만 Haven 에선 실행되지 않아요.');
	}

	// 로어북(card.json character_book + module.risum lorebook)은 이제 가져와 채팅 시 키워드 주입한다 → 경고 없음.

	if (module?.lowLevelAccess || ext.lowLevelAccess) {
		warns.push('저수준 시스템 접근을 요구하는 스크립트가 있어요 — 동작하지 않습니다.');
	}

	return warns;
}
