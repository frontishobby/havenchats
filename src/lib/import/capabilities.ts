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
 * 두 가지를 돌려준다:
 *  - warnings: 사람이 읽는 경고(트리거 효과 카테고리·정규식·코드·저수준 접근 여부 포함).
 *  - scripts : 원본 소스(트리거 JSON·Lua/JS 코드·정규식). '스크립트 분석'(실험적, LLM) 기능 입력.
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

/** LLM 분석으로 보낼 수 있는 원본 스크립트 한 조각. */
export interface ScriptArtifact {
	/** 사람이 읽는 라벨(예: "트리거: 호감도", "커스텀 코드 (module.cjs)"). */
	label: string;
	/** 원본 소스 — 트리거는 JSON, 스크립트는 코드 그대로. */
	source: string;
}

export interface CapabilityScan {
	warnings: string[];
	scripts: ScriptArtifact[];
}

function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/** 효과 하나가 "의미 있는지"(빈 v2Header 마커·빈 type 제외). */
function isMeaningfulEffect(e: unknown): boolean {
	const type = str((e as { type?: unknown })?.type);
	if (type === '') return false;
	if (type === 'v2Header') return str((e as { code?: unknown })?.code).trim() !== '';
	return true;
}

/**
 * trigger effect.type → 사람이 읽는 기능 카테고리.
 * 고신호(AI 호출·이미지·네트워크 등)는 개별 카테고리로, v2 마이크로 op 의 긴 꼬리는 한 버킷으로 묶는다.
 * 모르는 type 은 null(경고에 안 셈).
 */
function effectCategory(type: string): string | null {
	switch (type) {
		case 'runLLM':
		case 'v2RunLLM':
		case 'sendAIprompt':
		case 'v2SendAIprompt':
		case 'runAxLLM':
			return 'AI 모델 추가 호출';
		case 'runImgGen':
		case 'v2ImgGen':
			return '이미지 생성';
		case 'checkSimilarity':
		case 'v2CheckSimilarity':
			return '유사도 기억 검색';
		case 'triggerlua':
		case 'triggercode':
			return '코드 실행(Lua)';
		case 'extractRegex':
		case 'v2ExtractRegex':
		case 'v2RegexTest':
		case 'v2ReplaceString':
			return '정규식 치환';
		case 'modifychat':
		case 'v2ModifyChat':
		case 'cutchat':
		case 'v2CutChat':
		case 'v2UpdateChatAt':
			return '대화 내용 수정';
		case 'impersonate':
		case 'v2Impersonate':
			return "'나' 대신 발화";
		case 'systemprompt':
		case 'v2SystemPrompt':
		case 'v2SetAuthorNote':
		case 'v2SetReplaceGlobalNote':
			return '시스템 프롬프트 주입';
		case 'v2SetCharacterDesc':
		case 'v2SetPersonaDesc':
			return '캐릭터/페르소나 설정 변경';
		case 'v2CreateLorebook':
		case 'v2ModifyLorebook':
		case 'v2ModifyLorebookByIndex':
		case 'v2DeleteLorebookByIndex':
		case 'v2SetLorebookActivation':
		case 'v2SetLorebookAlwaysActive':
			return '로어북 조작';
		case 'showAlert':
		case 'v2ShowAlert':
		case 'v2GetAlertInput':
		case 'v2GetAlertSelect':
			return '알림·입력 요청';
		case 'setvar':
		case 'v2SetVar':
		case 'v2DeclareLocalVar':
			return '변수 설정';
		case 'stop':
		case 'v2StopTrigger':
		case 'v2StopPromptSending':
			return '진행 중단';
		default:
			// v2 마이크로 op(배열/딕셔너리/문자열/조회/조건·반복 등) → 한 버킷.
			if (type.startsWith('v2')) return '변수·로직 연산';
			return null;
	}
}

/** 카드 + (있으면) risum module 을 스캔해 미지원 동적 기능 경고 + 원본 스크립트를 모은다. */
export function scanUnsupported(card: V3Card, module: RisuModuleMeta | null): CapabilityScan {
	const warnings: string[] = [];
	const scripts: ScriptArtifact[] = [];
	const ext = ((card.data as { extensions?: { risuai?: RisuExt } } | undefined)?.extensions
		?.risuai ?? {}) as RisuExt;

	// 트리거: 의미 있는 효과 카테고리 수집 + 원본 보존(빈 슬롯은 건너뜀).
	const triggers = [...arr(module?.trigger), ...arr(ext.triggerscript)];
	const cats = new Set<string>();
	let triggerCount = 0;
	triggers.forEach((t, i) => {
		const effects = arr((t as { effect?: unknown })?.effect).filter(isMeaningfulEffect);
		if (effects.length === 0) return; // 편집 중 남은 빈 슬롯.
		triggerCount++;
		for (const e of effects) {
			const c = effectCategory(str((e as { type?: unknown })?.type));
			if (c) cats.add(c);
		}
		const name = str((t as { comment?: unknown })?.comment).trim();
		scripts.push({
			label: `트리거: ${name || `#${i + 1}`}`,
			source: JSON.stringify(t, null, 2)
		});
	});
	if (triggerCount > 0) {
		const catList = cats.size ? ` — ${[...cats].join(', ')}` : '';
		warnings.push(`트리거 ${triggerCount}개가 들어있지만 동작하지 않아요${catList}.`);
	}

	// 정규식 치환(module.regex + extensions.customScripts).
	const regexList = [...arr(module?.regex), ...arr(ext.customScripts)];
	if (regexList.length > 0) {
		warnings.push(
			`정규식 치환 스크립트 ${regexList.length}개는 적용되지 않아요 — 출력 가공·서식 정리·필터가 빠집니다.`
		);
		scripts.push({
			label: `정규식 치환 ${regexList.length}개`,
			source: JSON.stringify(regexList, null, 2)
		});
	}

	// 커스텀 코드(JS/Lua 모듈).
	const cjs = str(module?.cjs).trim();
	const vscript = str(ext.virtualscript).trim();
	if (cjs || vscript) {
		warnings.push('커스텀 코드(JavaScript)가 들어있지만 실행되지 않아요 — 미지원이에요.');
		if (cjs) scripts.push({ label: '커스텀 코드 (module.cjs)', source: cjs });
		if (vscript) scripts.push({ label: '커스텀 코드 (virtualscript)', source: vscript });
	}

	// 로어북·CBS 변수/조건/랜덤은 이제 가져와 동작하므로 경고 없음.

	if (module?.lowLevelAccess || ext.lowLevelAccess) {
		warnings.push(
			'저수준 시스템 접근(AI 모델·외부 네트워크·저장소 직접 접근) 권한이 켜져 있어요 — 동작하지 않습니다.'
		);
	}

	return { warnings, scripts };
}
