export type ContentRating = 'sfw' | 'nsfw';

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
	 * charx(캐릭터 카드 V3) import 로 만들어진 캐릭터 여부.
	 * true 면 프롬프트(description)는 클라이언트에 빈 문자열로 내려가고(서버 전용),
	 * 영구 비공개·수정 불가. 장면 이미지는 기기 한정(IndexedDB) → '기기간 공유'로만 R2 전환.
	 */
	imported: boolean;
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

export type Role = 'user' | 'assistant';

export interface ChatMessage {
	id: string;
	role: Role;
	content: string;
	/** assistant 응답 생성에 든 AI Gateway 추론 비용(USD, 실측). 없으면 미표시. */
	cost?: number;
}

/** DB 영속 메시지 — ChatMessage + 세션 내 순번(seq). */
export interface StoredMessage extends ChatMessage {
	seq: number;
}

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
