/**
 * 이미지 상황 프롬프트 공용 — 채팅 실시간 이미지(/api/chat/image/prepare)와
 * 캐릭터 썸네일(/api/characters/thumbnail)이 같은 **구조화 출력 스키마**와 후처리를 쓴다.
 *
 * 스키마는 NAI V4.5/V5 캐릭터 기능(char_captions 분리)에 맞춰 장면을 분해한다:
 *  - base: 배경·구도·인원수 태그·상호작용(source#/target#) 등 전역 캡션(태그).
 *  - scene: 자연어 장면 문장(1~2문장, 영어) — V5 만 조립에 사용. 인물은 역할 명사로만.
 *  - characters[]: 화면에 보이는 인물별 { name, appearance(고정 외형), outfit(현재 복장/노출 상태), state(포즈·표정) }.
 *    outfit 을 state 에서 분리한 이유: 채팅에선 복장 원장(session.outfits)으로 턴 간 이어 가기 위해.
 */
import { jsonSchema } from 'ai';

export interface ScenePromptCharacter {
	name: string;
	appearance: string;
	/** 현재 복장/노출 상태(태그). 채팅에선 복장 원장으로 턴 간 유지. */
	outfit: string;
	/** 포즈·행동·표정·프레이밍(복장 제외). */
	state: string;
}

export interface ScenePromptObject {
	base: string;
	scene: string;
	characters: ScenePromptCharacter[];
}

export const SCENE_PROMPT_SCHEMA = jsonSchema<ScenePromptObject>({
	type: 'object',
	additionalProperties: false,
	properties: {
		base: { type: 'string' },
		scene: { type: 'string' },
		characters: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					name: { type: 'string' },
					appearance: { type: 'string' },
					outfit: { type: 'string' },
					state: { type: 'string' }
				},
				required: ['name', 'appearance', 'outfit', 'state']
			}
		}
	},
	required: ['base', 'scene', 'characters']
});

/** 시스템 프롬프트 공용 꼬리 — 미성년 절대 금지 규칙(이미지 프롬프트 LLM 전부에 삽입). */
export const ADULT_ONLY_RULE = `- ABSOLUTE RULE: every person MUST be depicted as an adult (18+). NEVER output any tag or wording depicting minors, children, or age-regressed characters (e.g. loli, shota, child, kid, toddler, "young girl/boy", "little girl/boy"). If the input implies a minor, depict them as a clear adult instead. This overrides everything else.`;

/** 문자열 정규화(trim). 알 수 없는 값은 빈 문자열. */
export function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

export const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/;

/**
 * 태그 리스트 후처리. NovelAI 는 영어/danbooru 태그만 해석하므로, 모델이 (지시에도 불구하고)
 * 캐릭터 프롬프트의 '상태창'을 통짜로 베껴 넣는 걸 출력단에서 막는다.
 * — 줄·콤마 단위 세그먼트로 쪼개 한글이 들어간 조각은 통째로 제거 → 영어 태그만 ', ' 로 재조립.
 */
export function sanitizeTags(raw: string): string {
	return raw
		.split(/[\r\n,]+/)
		.map((s) => s.trim())
		.filter((s) => s && !HANGUL_RE.test(s))
		.join(', ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 자연어 장면 문장 후처리. 문장 안의 콤마는 살려야 하므로 **줄 단위**로만 쪼개 한글 줄을 버리고,
 * 공백 정리 후 끝의 마침표/콤마를 떼어 낸다(뒤에 ', ' 로 태그가 이어지므로).
 */
export function sanitizeScene(raw: string): string {
	return raw
		.split(/[\r\n]+/)
		.map((s) => s.trim())
		.filter((s) => s && !HANGUL_RE.test(s))
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/[.,\s]+$/, '')
		.trim();
}

/**
 * 옷에 가려지는 신체 특징 규칙(시스템 프롬프트 공용). 제작자가 description 에 유두·음모·배 문신 같은
 * 특징을 적어 두면 LLM 이 "고정 외형" 이라며 매 턴 appearance 에 박고, NAI 는 태그를 '보이게' 그리려고
 * 옷을 벗기거나 들춘다. → 가려지는 특징은 appearance 금지, 실제로 노출된 순간에만 state 에 넣게 한다.
 */
export const HIDDEN_FEATURE_RULE = [
	`- HIDDEN FEATURES: body details that clothing normally covers — nipples, areolae, pubic hair, genitals, abs/toned stomach, tan lines, and any tattoo, scar, mole, birthmark or piercing on the breasts, chest, stomach, back, hips, thighs or buttocks — must NEVER go in "appearance", even if the reference lists them as permanent traits. Mention them ONLY in "outfit" (as part of the undress state), and ONLY when that body part is actually uncovered at this moment.`,
	`- Never undress, unbutton, lift or open clothing that neither the text nor the recorded outfit does: if the person is dressed, "outfit" MUST begin with "fully clothed" followed by the garments, and nothing under the clothes may be tagged.`
].join('\n');

/** 옷을 입은 상태에선 그릴 수 없는(가려지는) 특징 태그 — 세그먼트 단위로 매칭. */
const HIDDEN_FEATURE_RE =
	/\b(nipples?|areolae?|pubic|pussy|vagina|vulva|clitoris|clit|labia|penis|cock|testicles|anus|genitals?|abs|six ?pack|toned stomach|tan ?lines?|womb tattoo|(?:stomach|belly|abdomen|abdominal|breast|chest|back|hip|thigh|thighs|butt|buttocks|ass|crotch|groin|pubic|shoulder blade|waist|rib|ribs) (?:tattoo|scar|mole|birthmark|piercing)|(?:tattoo|scar|mole|birthmark|piercing)s? (?:on|across|under|below|between|over) (?:the |her |his |their )?(?:stomach|belly|abdomen|lower abdomen|breasts?|chest|back|lower back|hips?|thighs?|butt|buttocks|ass|crotch|groin|shoulder blades?|waist|ribs?|navel)|navel piercing|belly button piercing|nipple piercings?|genital piercings?)\b/i;

/** outfit/state 에 노출 신호가 있는지 — 있으면 가려진 특징도 그대로 둔다(부위별 세분화는 안 함). */
const EXPOSURE_RE =
	/\b(naked|nude|nudity|topless|bottomless|braless|pantsless|no bra|no panties|no shirt|no pants|undress(?:ed|ing)?|strip(?:ped|ping)?|breasts? out|exposed|open shirt|open clothes|open jacket|open robe|clothes (?:lift|pull|down)|shirt (?:lift|pull)|skirt (?:lift|pull)|dress (?:lift|pull)|panties (?:aside|pull|down)|clothing aside|see-through|wet (?:shirt|clothes)|cleavage|midriff|navel|crop top|bikini|swimsuit|lingerie|underwear|bra only|panties only|towel|bath(?:ing|tub)?|shower(?:ing)?|onsen|hot spring|sex|vaginal|anal|fellatio|cunnilingus|paizuri|masturbat\w*|cum|after sex|nipples?|pussy|penis|spread legs)\b/i;

/**
 * 옷을 입은 장면이면 appearance 에서 가려지는 특징 태그를 떼어 낸다(LLM 이 규칙을 어겨도 출력단에서 차단).
 * 원장(session.appearances)에 이미 박힌 외형에도 매 턴 적용되므로 소급된다.
 * `exposure` 는 노출 판정 대상 문자열 — 호출자가 outfit 과 state 를 합쳐 넘긴다.
 */
export function stripHiddenFeatures(appearance: string, exposure: string): string {
	if (!appearance || EXPOSURE_RE.test(exposure)) return appearance;
	return appearance
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s && !HIDDEN_FEATURE_RE.test(s))
		.join(', ');
}

/*
 * ── 옷 입은 카드(dressed) 모드 ──
 * 캐릭터 썸네일에서 연출이 비어 있거나(또는 연출에 벗기는 지시가 없는데) 설정문의 성적 묘사(유두·성기·
 * 속옷 취향 등)가 LLM 출력으로 새어 들어와 NAI 가 전신+노출 컷을 그리던 문제의 출력단 가드.
 * 시스템 프롬프트 규칙과 별개로, 연출이 벗기라고 하지 않았으면 base_caption 의 nsfw 태그를 빼고
 * 카드 프레이밍(상반신)을 강제한다. 의상 태그 자체는 건드리지 않는다(설정의 의상을 존중).
 */

/** 연출(한국어/영어)에 노출·탈의를 요구하는 신호가 있는지. 없으면 dressed 모드. */
const KO_UNDRESS_RE =
	/(나체|알몸|누드|벗|탈의|노출|속옷|란제리|팬티|브래?지어|젖꼭지|유두|가슴을 드러|보지|성기|자지|음부|정사|섹스|삽입|자위|목욕|샤워|온천|비키니|수영복|비치는|시스루)/;
export function directionRequestsUndress(direction: string): boolean {
	const d = direction.trim();
	if (!d) return false;
	return EXPOSURE_RE.test(d) || KO_UNDRESS_RE.test(d);
}

/** 카드 프레이밍 태그(이 중 하나가 있으면 그대로 둔다). */
const CARD_FRAMING_RE =
	/\b(upper body|cowboy shot|portrait|close-up|bust|half body|head and shoulders)\b/i;
/** 카드에 부적합한 프레이밍 — 전신·원경·하체 강조. */
const NON_CARD_FRAMING_RE =
	/\b(full body|wide shot|very wide shot|long shot|from below|lower body|feet out of frame|thigh focus|ass focus|crotch focus|from behind)\b/i;

/** base 의 프레이밍을 카드용으로 강제: 전신·원경 조각을 떼고, 프레이밍 태그가 없으면 'upper body' 추가. */
export function enforceCardFraming(base: string): string {
	const kept = base
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s && !NON_CARD_FRAMING_RE.test(s));
	if (!kept.some((s) => CARD_FRAMING_RE.test(s))) kept.push('upper body');
	return kept.join(', ');
}
