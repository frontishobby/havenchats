export type ContentRating = 'sfw' | 'nsfw';

/** 프로필 국가(NSFW 노출 게이트). 'KR'=대한민국(SFW만), 'PY'=파라과이(NSFW 허용). */
export type Country = 'KR' | 'PY';

/** 타깃 독자층. 'all'=공통, 'male'=남성향, 'female'=여성향. */
export type Audience = 'all' | 'male' | 'female';

/** 공개 범위. 'public'=모두에게 노출, 'private'=제작자 본인만(내 캐릭터). */
export type Visibility = 'public' | 'private';

/** 캐릭터 제작자 요약(상세 모달 표시·유저 페이지 링크용). name 미설정(프로필 미완성)이면 null. */
export interface Creator {
	id: string;
	name: string | null;
	avatarUrl: string | null;
}

/** 첫 상황(오프닝) 하나. name=선택용 이름(라벨), content=실제 첫 메시지 본문. */
export interface Opening {
	name: string;
	content: string;
}

/**
 * 로어북 항목 하나. 채팅 중 최근 대화에 keys 의 키워드가 등장하면 content 를 프롬프트에 주입한다.
 * constant=true 면 키워드와 무관하게 항상 주입. 주입 로직: src/lib/lorebook.ts
 */
export interface LoreEntry {
	/** 안정 식별자(uuid). */
	id: string;
	/** 트리거 키워드(소문자 부분일치). constant 항목은 매칭에 쓰이지 않는다. */
	keys: string[];
	/** 주입 본문. */
	content: string;
	/** true 면 항상 주입(상시 설정). */
	constant: boolean;
	/** 우선순위 — 높을수록 먼저 주입(예산 초과 시 낮은 항목부터 누락). 기본 0. */
	order: number;
}

/** 캐릭터의 로어북(항목 묶음). 없으면 null. */
export interface CharacterLorebook {
	entries: LoreEntry[];
}

/**
 * 캐릭터 스크립트 설정(서버 전용 — 프롬프트 조립에만 사용, 클라이언트 미노출).
 * 지금은 import 한 기본 변수만. 3·4순위에서 triggers/regex 로 확장.
 */
export interface CharacterScriptData {
	/** 세션 시작 시 변수 상태를 시딩하는 기본 변수(키=변수명 소문자). */
	defaultVariables?: Record<string, string>;
}

/**
 * imported(charx) 카드의 editdisplay 정규식 — 모델 출력의 `<img="감정">` 마커를 감정 스프라이트
 * HTML 로 바꾸는 표시용 치환. 채팅 렌더 시(클라) 적용: 정규식 in→out($캡처) → CBS 평가 → DOMPurify 세정.
 * 표시 전용이라 클라이언트로 내려간다. (src/lib/import/displayScripts.ts, htmlRender.ts)
 */
export interface DisplayScript {
	/** 정규식 패턴(RisuAI customscript.in). */
	in: string;
	/** 치환 템플릿(생 HTML + CBS 매크로, `$1`/`$&` 캡처 포함 가능). */
	out: string;
	/** 정규화된 정규식 flag(`g`/`i`/… 기본 `u`). */
	flags: string;
}

export interface Character {
	id: string;
	name: string;
	avatarUrl: string;
	tagline: string;
	/**
	 * 설명 — 캐릭터를 눌렀을 때 상세 모달에 보이는 소개글.
	 * 표시 전용이며 시스템 프롬프트(description)에는 포함되지 않는다. 비어있을 수 있다.
	 */
	intro: string;
	/**
	 * 제작자가 작성하는 시스템 프롬프트 본문 — 사실상 전체 프롬프트.
	 * 역할 선언(캐릭터 연기/내레이터/시뮬레이션/어시스턴트 등), 세계관·말투·설정,
	 * 출력 형식(소설 형식·대사 형식 등)까지 모두 제작자가 기호에 맞게 자유롭게 기입한다.
	 * 서버는 여기에 "상대(사용자) 정보"와 "가드레일"이라는 공통 부분만 덧붙인다.
	 * 조립 로직: src/routes/api/chat/+server.ts 의 buildSystemPrompt()
	 */
	description: string;
	/**
	 * 첫 상황(오프닝) 목록 — 각 항목이 채팅 시작 시 assistant 의 첫 메시지가 된다.
	 * 최소 1개(기본 상황) 필수. 2개 이상이면 상세 모달에서 이름(name)으로 골라 시작한다.
	 */
	greetings: Opening[];
	tags: string[];
	contentRating: ContentRating;
	/** 타깃 독자층(공통/남성향/여성향). */
	audience: Audience;
	/** 공개 범위. 'private'면 제작자 본인 프로필에서만 노출. */
	visibility: Visibility;
	/** 제작자 정보(프로필 사진·이름·유저 페이지 링크용). */
	creator: Creator;
	/** 인기도(누적 대화 수) */
	chats: number;
	/** 장면 이미지 세트(축×조합). 없으면 null. */
	imageSet: CharacterImageSet | null;
	/**
	 * 로어북(키워드로 켜지는 동적 설정). 없으면 null.
	 * imported 캐릭터의 로어북은 숨김 프롬프트라 클라이언트엔 null 로 내려가고(서버 전용),
	 * 채팅 조립 시 getCharacterLorebook() 으로만 서버에서 읽는다.
	 */
	lorebook: CharacterLorebook | null;
	/**
	 * 표시용 정규식(editdisplay) — imported 카드의 감정 스프라이트 HTML 렌더. 없으면 null.
	 * 표시 전용(숨김 프롬프트 아님)이라 클라이언트로 내려간다. 채팅 렌더에서 적용.
	 */
	displayScripts: DisplayScript[] | null;
	/**
	 * charx(캐릭터 카드 V3) import 로 만들어진 캐릭터 여부.
	 * true 면 프롬프트(description)는 클라이언트에 빈 문자열로 내려가고(서버 전용),
	 * 영구 비공개·수정 불가. 장면 이미지는 기기 한정(IndexedDB) → '기기간 공유'로만 R2 전환.
	 */
	imported: boolean;
	/** 제작자가 지정한 추천 그림체 id(선택). 없으면 null. */
	recommendedStyleId: string | null;
	/**
	 * 마지막 수정 시각(epoch ms). 이미지 캐시 버스팅 버전(`?v=`)으로 쓴다 — 썸네일·장면
	 * 이미지 키는 엔티티 id 로 고정이라, 재업로드 시 이 값이 바뀌어야 immutable 캐시가 안전.
	 */
	updatedAt: number;
}

/**
 * 장면 이미지 바이트의 저장 위치.
 *  - 'r2'(또는 미지정): Cloudflare R2(charimg/<charId>/<id>.<ext>) — `/img` 로 서빙. 기본·기기간 공유.
 *  - 'local': 브라우저 IndexedDB 에만 존재(charx import 직후). 가져온 그 기기에서만 보이며,
 *             '기기간 공유'(promote)로 R2 에 올리면 'r2' 로 전환된다. 비공개 고정.
 */
export type ImageStorage = 'local' | 'r2';

/**
 * 장면 이미지 — 축(열) 하나. label=축 이름(예: "표정"), values=구분값 라벨 목록.
 * values 의 순서가 곧 코드 글자(0→A, 1→B …). 축당 최대 26개.
 */
export interface ImageAxis {
	label: string;
	values: string[];
}

/**
 * 장면 이미지 조합(행) 하나. id=불변 식별자(R2 키·메시지 고정에 사용),
 * combo=축별 value index(축 순서대로), ext=R2 오브젝트 확장자(webp|avif).
 * 위치코드(AAB)는 combo 에서 파생하며 저장하지 않는다.
 */
export interface ImageEntry {
	id: string;
	combo: number[];
	ext: string;
}

/**
 * 플랫 네임드 이미지 한 장. RisuAI 류 카드(charx) 호환 방식.
 *  - id: 불변 식별자 → R2 키(charimg/<charId>/<id>.<ext>). 공백·특수문자 없는 안전한 키.
 *  - name: 모델이 본문에 출력하는 매칭 토큰. `<img="name">` 의 name 과 정확히 일치(공백 가능).
 *  - ext: R2 오브젝트 확장자(webp|avif|png 등).
 * 그리드(축×조합)와 달리 조합 규칙 없이 이름→이미지 1:1 맵. import 무손실·불규칙 세트 수용.
 */
export interface NamedImage {
	id: string;
	name: string;
	ext: string;
}

/**
 * 그리드 방식 장면 이미지 세트(축×조합). 모델은 위치코드 {AAB} 를 출력.
 * 네이티브 제작 기본 방식 — 프롬프트 카탈로그가 조합 수에 안 휘둘리고(축만 나열),
 * 제작자가 축 단위로 재편집·핀 안정성 확보.
 */
export interface GridImageSet {
	kind: 'grid';
	axes: ImageAxis[];
	entries: ImageEntry[];
	/** 바이트 저장 위치. 'local'이면 IndexedDB(기기 한정), 미지정/'r2'면 클라우드. */
	storage?: ImageStorage;
}

/**
 * 플랫 네임드 방식 장면 이미지 세트. 모델은 본문에 `<img="name">` 토큰을 출력.
 * charx import·불규칙/대량/멀티캐릭터 갤러리에 적합(무손실).
 */
export interface NamedImageSet {
	kind: 'named';
	images: NamedImage[];
	/** 바이트 저장 위치. 'local'이면 IndexedDB(기기 한정), 미지정/'r2'면 클라우드. */
	storage?: ImageStorage;
}

/**
 * 캐릭터의 장면 이미지 세트(없으면 null). 두 방식을 kind 판별자로 공존:
 *  - 'grid'  : 축×조합 위치코드({AAB})
 *  - 'named' : 플랫 이름 토큰(`<img="name">`)
 * DB 의 옛 image_set JSON(축/조합만 있고 kind 없음)은 로드 시 'grid' 로 해석(하위호환).
 */
export type CharacterImageSet = GridImageSet | NamedImageSet;

/**
 * 메시지 역할.
 *  - 'user'/'assistant': 일반 대화. 모델에 전송되는 sliding window 대상.
 *  - 'image_generation': 실시간 이미지 생성 결과(content = R2 오브젝트 키). 세션에 표시만 하고
 *    이후 LLM 프롬프트(window/요약)에서는 제외된다.
 */
/**
 * 그림체(아트 스타일) — 유저가 만들어 Hub 에 공유하는 그림체 프롬프트.
 * prompt 는 그림체(아티스트/스타일) 태그. 채팅 이미지 생성 시 자동 상황 프롬프트와 합쳐진다.
 * thumbnailUrl 은 고정 표준 장면으로 생성한 일관 썸네일(servable URL, 없으면 null).
 */
export interface ArtStyle {
	id: string;
	creatorId: string;
	creatorName: string | null;
	title: string;
	memo: string | null;
	/** 그림체(스타일) 프롬프트 본문. */
	prompt: string;
	/** 이 그림체가 깎인 NovelAI 모델 id(`lib/naiModels.ts`). 채팅·워크숍·썸네일은 이 모델로 생성. */
	model: string;
	/** 썸네일 servable URL(`/img/<key>?v=updatedAt`). 없으면 null. */
	thumbnailUrl: string | null;
	/** Hub 공개 여부. false=저장(비공개, 본인 채팅 전용), true=공유(Hub 노출). */
	shared: boolean;
	/** 현재 유저가 즐겨찾기했는지(목록·상세에서 채워짐). */
	favorited: boolean;
	createdAt: number;
	updatedAt: number;
}

export type Role = 'user' | 'assistant' | 'image_generation';

export interface ChatMessage {
	id: string;
	role: Role;
	content: string;
	/** assistant 응답 생성에 든 AI Gateway 추론 비용(USD, 실측). 없으면 미표시. */
	cost?: number;
	/** 응답 실패·비정상 종료 시 사용자에게 보여줄 사유(클라 임시 표시용, 영속 X). */
	errorReason?: string;
	/** 생성 중 표시용(클라 임시 — 실시간 이미지 생성 진행 중). 영속 X. */
	pending?: boolean;
	/** 스트리밍 중간 프레임 프리뷰(클라 임시 object URL — image_generation). 영속 X. */
	previewUrl?: string;
	/**
	 * 렌더 키(클라 임시). 실시간 이미지는 commit 시 id 가 임시→서버 id 로 바뀌는데, 목록을 id 로 키잉하면
	 * 그 순간 DOM 이 통째로 재생성돼 이미지가 깜빡인다 → 생성 시 부여한 이 키로 키잉해 엘리먼트를 유지.
	 */
	clientKey?: string;
}

/** DB 영속 메시지 — ChatMessage + 세션 내 순번(seq). */
export interface StoredMessage extends ChatMessage {
	seq: number;
}

/**
 * 외형 원장 한 항목 — 인물 첫 등장 시 고정한 외형 태그 + 마지막 등장 시점.
 * 옷·표정·포즈(가변 상태)는 여기 넣지 않는다(매 턴 새로 그림).
 */
export interface AppearanceEntry {
	/** 고정 외형 danbooru 태그(머리·눈·체형·고유특징). */
	appearance: string;
	/** 마지막 등장 턴 기준값(session.messageCount). 원장 상한 초과 시 오래된 것부터 evict. */
	lastSeen: number;
}

/** 세션별 외형 원장 — 정규화된 인물 name → 고정 외형. 동적 NPC 외형 일관성용. */
export type AppearanceLedger = Record<string, AppearanceEntry>;

/** 대화 세션. summary/summary_upto_seq 가 토큰 전략(요약+window)의 상태. */
export interface ChatSession {
	id: string;
	userId: string;
	characterId: string;
	model: string | null;
	summary: string | null;
	summaryUptoSeq: number;
	/** 유저가 직접 넣는 "상시 기억"(최대 100자). 존재 시 system↔history 사이에 주입. */
	memory: string | null;
	/** 세션 변수 상태(CBS getvar/setvar). 키=변수명(소문자), 값=문자열. 없으면 null. */
	scriptState: Record<string, string> | null;
	/** 외형 원장(실시간 이미지에서 동적 NPC 외형 고정). 없으면 null. */
	appearances: AppearanceLedger | null;
	messageCount: number;
	createdAt: number;
	updatedAt: number;
	lastMessageAt: number | null;
}

/** 사이드바(최근 채팅) 한 줄. 세션 + 캐릭터 메타 + 마지막 대사 미리보기. */
export interface RecentChat {
	sessionId: string;
	characterId: string;
	characterName: string;
	avatarUrl: string;
	preview: string;
	lastMessageAt: number | null;
}
