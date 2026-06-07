<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { invalidate, replaceState } from '$app/navigation';
	import { MODELS, DEFAULT_MODEL_ID, getModel } from '$lib/data/models';
	import { openLogin } from '$lib/state/loginModal.svelte';
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';
	import { base64ToBlob } from '$lib/imagePreview';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import CharacterDetailModal from '$lib/components/CharacterDetailModal.svelte';
	import {
		resolveSceneLine,
		looksLikeSceneToken,
		stripSceneTokens,
		isLocalSet,
		isGrid,
		isNamed
	} from '$lib/imageCodes';
	import { localSceneURL, getLocalSceneBlob, localSceneKey } from '$lib/import/localImages';
	import { compileScripts, makeAssetResolver, evalDisplayLine } from '$lib/import/displayScripts';
	import { renderCardHtml } from '$lib/htmlRender';
	import { personalize as fillPlaceholders } from '$lib/placeholders';
	import type { ChatMessage, Character, ArtStyle } from '$lib/types';
	import type { ChatDebugSnapshot, ImageDebug } from '$lib/chatDebug';
	import ChatDebugPanel from '$lib/components/ChatDebugPanel.svelte';

	/** 메인·디버그 라우트가 공용으로 넘기는 페이지 데이터(두 loader 가 같은 형태 반환). */
	interface ChatPageData {
		character: Character;
		user: App.Locals['user'];
		openingIndex: number;
		sessionId: string | null;
		resumed: ChatMessage[] | null;
		oldestSeq: number;
		hasMore: boolean;
		recommendedStyle: ArtStyle | null;
	}

	const SENTENCE_MIN = 5;
	const SENTENCE_MAX = 30;
	const SENTENCE_KEY = 'haven:maxSentences';

	const USER_ACTS_KEY = 'haven:userActs';
	const USER_ACTS_LABELS = ['금지', '적정', '풍부'];

	const MODEL_KEY = 'haven:model';

	// ── 실시간 이미지 생성(NovelAI) 설정 ──
	const IMG_ENABLED_KEY = 'haven:img:enabled';
	const IMG_RES_KEY = 'haven:img:resolution';
	const IMG_STYLE_ID_KEY = 'haven:img:styleId';
	const IMG_PROMPT_MODEL_KEY = 'haven:img:promptModel';
	const IMG_EARLY_KEY = 'haven:img:early';
	const IMG_IGNORE_ASSETS_KEY = 'haven:img:ignoreAssets';
	// '빠른 생성 우선': 스트리밍 응답이 이만큼(자) 도달하면 마지막 부분을 포기하고 이미지를 미리 발사.
	const IMG_EARLY_TRIGGER_CHARS = 600;
	const IMG_RESOLUTIONS = ['832x1216', '1024x1024'] as const;
	type ImgResolution = (typeof IMG_RESOLUTIONS)[number];
	// 상황 프롬프트 생성 기본 모델(이미지 설정에서 변경 가능).
	const DEFAULT_IMG_PROMPT_MODEL = 'google/gemini-3.5-flash';

	// 서버가 스트림 끝에 붙이는 응답 메타 프레임 구분자(서버 META_SEP 와 동일).
	const META_SEP = '␞';

	// AI 응답 메타(finishReason·usage 등)를 브라우저 콘솔에 출력. 잘림 진단용.
	function logResponseMeta(jsonText: string) {
		try {
			const meta = JSON.parse(jsonText);
			console.log('[haven] AI 응답 메타', meta);
			if (meta.finishReason && meta.finishReason !== 'stop') {
				console.warn(
					`[haven] finishReason="${meta.finishReason}" — 응답이 정상 종료(stop)가 아닙니다.` +
						` (length=토큰상한 도달, content-filter=안전필터 차단)`
				);
			}
		} catch (e) {
			console.error('[haven] 응답 메타 파싱 실패', e, jsonText);
		}
	}

	// 메타 프레임에서 이번 응답의 AI Gateway 추론 비용(USD)을 뽑는다. providerMetadata.gateway.cost
	// 는 "0.0270609" 같은 숫자/문자열 → 숫자로. 없거나 파싱 불가면 null.
	function parseCost(jsonText: string): number | null {
		try {
			const raw = JSON.parse(jsonText)?.providerMetadata?.gateway?.cost;
			if (raw == null) return null;
			const n = typeof raw === 'number' ? raw : Number(raw);
			return Number.isFinite(n) ? n : null;
		} catch {
			return null;
		}
	}

	// 응답 실패·비정상 종료 시 화면에 보여줄 사유. 서버 에러(streamError)를 우선,
	// 없으면 finishReason 을 사람이 읽을 수 있게 해석. 정상(stop)이면 null.
	function parseErrorReason(jsonText: string): string | null {
		try {
			const meta = JSON.parse(jsonText);
			if (meta.streamError) return String(meta.streamError);
			const fr = meta.finishReason;
			if (fr && fr !== 'stop') {
				if (fr === 'length') return '응답이 토큰 상한에 도달해 잘렸습니다.';
				if (fr === 'content-filter') return '안전 필터에 의해 응답이 차단되었습니다.';
				return `비정상 종료 (finishReason=${fr}).`;
			}
			return null;
		} catch {
			return null;
		}
	}

	// 메타의 warnings(AI SDK 경고 배열)를 사람이 읽을 한 줄로. 비었으면 null.
	function formatWarnings(warnings: unknown): string | null {
		if (!Array.isArray(warnings) || warnings.length === 0) return null;
		const parts = warnings
			.map((w) => {
				if (w == null) return '';
				if (typeof w === 'string') return w;
				const o = w as Record<string, unknown>;
				return String(o.message ?? o.details ?? o.setting ?? o.type ?? '');
			})
			.filter(Boolean);
		return parts.length ? parts.join('; ') : null;
	}

	// 하드 에러는 아니지만 응답이 비어 있는 경우(모델이 아무것도 못 냄 — 원래는 조용히
	// 응답이 안 오던 케이스)에 메타에서 사유를 끌어내 같은 경고 포맷으로 노출한다.
	function emptyResponseReason(jsonText: string): string {
		try {
			const meta = JSON.parse(jsonText);
			const w = formatWarnings(meta.warnings);
			if (w) return `응답이 비어 있습니다. (${w})`;
			if (meta.metaError) return `응답이 비어 있습니다. (${String(meta.metaError)})`;
			const fr = meta.finishReason;
			return `응답이 비어 있습니다.${fr ? ` (finishReason=${fr})` : ''}`;
		} catch {
			return '응답이 비어 있습니다.';
		}
	}

	// 비용(USD)을 소수점 2자리로 올림 표시. 예: 0.0270609 → "$0.03", 0.0001 → "$0.01".
	function formatCost(cost: number): string {
		return `$${(Math.ceil(cost * 100) / 100).toFixed(2)}`;
	}

	let { data, debug = false }: { data: ChatPageData; debug?: boolean } = $props();
	const character = $derived(data.character);

	// ── 디버그 모드 ── 전송 시 응답 메타에 동봉된 조립 스냅샷을 받아 패널에 표시.
	let debugSnapshot = $state<ChatDebugSnapshot | null>(null);
	let debugMeta = $state<Record<string, unknown> | null>(null);
	// 마지막 실시간 이미지 생성에 사용한 프롬프트/파라미터(디버그 패널 표시용).
	let imageDebug = $state<ImageDebug | null>(null);

	// imported(charx) 카드의 editdisplay 표시 정규식 — 모델 `<img="감정">` → 감정 스프라이트 HTML.
	const displayCompiled = $derived(compileScripts(character.displayScripts));
	const assetResolver = $derived(makeAssetResolver(character.imageSet, character.id));

	/**
	 * 표시 라인 판별 + 정규식·CBS 평가(세정 전 HTML). 매칭 안 되면 null.
	 * 순수 함수라 SSR·클라 결과가 동일 → 컨테이너 유무가 일치(hydration 안전). 세정(DOMPurify)은
	 * cardHtml 액션이 클라에서 수행. seed=캐릭터+라인 → 변형 랜덤이 라인마다 안정적.
	 */
	function displayEval(line: string): string | null {
		if (!displayCompiled.length) return null;
		return evalDisplayLine(line, displayCompiled, assetResolver, `${character.id}:${line}`, 0);
	}

	/** 평가된 카드 HTML 을 세정해 컨테이너에 주입(클라 전용 — 액션은 브라우저에서만 실행). */
	function cardHtml(node: HTMLElement, html: string) {
		node.innerHTML = renderCardHtml(html);
		return {
			update(next: string) {
				node.innerHTML = renderCardHtml(next);
			}
		};
	}

	// 제작자가 쓴 플레이스홀더({{char}}/{{나}}/{{user}}) → 캐릭터·사용자 이름으로 치환.
	// 채팅용 이름은 대화용 이름(personaName) 우선, 없으면 노출용 이름(name)으로 폴백 — 서버(/api/chat)와 동일.
	function personalize(text: string): string {
		const chatName = data.user?.personaName?.trim() || data.user?.name;
		return fillPlaceholders(text, character.name, chatName);
	}

	function greetingMessages(content: string): ChatMessage[] {
		return content ? [{ id: crypto.randomUUID(), role: 'assistant', content }] : [];
	}

	// 첫 상황(오프닝)은 메인 상세 모달에서 골라 ?o=<index> 로 전달된다. (범위 보정은 서버 load)
	function openingFor(c: typeof data.character, idx: number): string {
		if (c.greetings.length === 0) return '';
		const i = idx >= 0 && idx < c.greetings.length ? idx : 0;
		return personalize(c.greetings[i].content);
	}

	// 이어가는 세션이 있으면 저장된 메시지로, 없으면 오프닝으로 시작.
	function initialMessages(d: ChatPageData): ChatMessage[] {
		if (d.resumed && d.resumed.length > 0) return d.resumed.map((m) => ({ ...m }));
		return greetingMessages(openingFor(d.character, d.openingIndex));
	}

	// 초기 상태는 마운트 시점의 data 만 캡처(이후 load 변경은 아래 loadKey $effect 가 재적용).
	const initData = untrack(() => data);
	let messages = $state<ChatMessage[]>(initialMessages(initData));
	// 현재 세션 id. null 이면 첫 전송 시 서버가 lazy 생성 → 응답 헤더로 회수.
	let sessionId = $state<string | null>(initData.sessionId);
	// ── 과거 메시지 페이징 ── 최초엔 최근 20개만. 위로 올리면 더 불러온다.
	let oldestSeq = $state(initData.oldestSeq ?? 0); // 현재 로드된 가장 오래된 seq
	let hasMore = $state(initData.hasMore ?? false); // 그 앞에 더 오래된 메시지가 있는지
	let loadingMore = $state(false);

	// ── 대화 요약(설정 모달에서 표시·편집) ──
	let summary = $state<string | null>(null); // 서버 최신 요약
	let summaryDraft = $state(''); // 편집 중 텍스트
	let summaryLoading = $state(false);
	let summarySaving = $state(false);
	let summarySaved = $state(false);
	const summaryDirty = $derived(summaryDraft !== (summary ?? ''));
	let summaryExpanded = $state(false); // 대화 요약 펼침 여부(기본 닫힘)

	// ── 상시 기억(유저가 직접 넣는 짧은 메모) ──
	const MAX_MEMORY_CHARS = 100;
	let memory = $state<string | null>(null); // 서버 최신 값
	let memoryDraft = $state(''); // 편집 중 텍스트
	let memorySaving = $state(false);
	let memorySaved = $state(false);
	const memoryDirty = $derived(memoryDraft !== (memory ?? ''));

	// 설정 모달을 열 때 현재 세션의 최신 요약·상시 기억을 함께 불러온다(백그라운드 갱신 반영).
	async function loadSummary() {
		if (!sessionId) {
			summary = null;
			summaryDraft = '';
			memory = null;
			memoryDraft = '';
			return;
		}
		summaryLoading = true;
		try {
			const res = await fetch(`/api/chat/summary?sessionId=${encodeURIComponent(sessionId)}`);
			if (res.ok) {
				const d = (await res.json()) as { summary: string | null; memory: string | null };
				summary = d.summary ?? null;
				summaryDraft = summary ?? '';
				summarySaved = false;
				summaryExpanded = false;
				memory = d.memory ?? null;
				memoryDraft = memory ?? '';
				memorySaved = false;
			}
		} catch (e) {
			console.error(e);
		} finally {
			summaryLoading = false;
		}
	}

	async function saveMemory() {
		if (!sessionId || memorySaving) return;
		memorySaving = true;
		memorySaved = false;
		try {
			const res = await fetch('/api/chat/memory', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, memory: memoryDraft })
			});
			if (res.ok) {
				const d = (await res.json()) as { memory: string | null };
				memory = d.memory ?? null;
				memoryDraft = memory ?? '';
				memorySaved = true;
			}
		} catch (e) {
			console.error(e);
		} finally {
			memorySaving = false;
		}
	}

	async function saveSummary() {
		if (!sessionId || summarySaving) return;
		summarySaving = true;
		summarySaved = false;
		try {
			const res = await fetch('/api/chat/summary', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, summary: summaryDraft })
			});
			if (res.ok) {
				const d = (await res.json()) as { summary: string | null };
				summary = d.summary ?? null;
				summaryDraft = summary ?? '';
				summarySaved = true;
			}
		} catch (e) {
			console.error(e);
		} finally {
			summarySaving = false;
		}
	}

	function toggleSettings() {
		showSettings = !showSettings;
		if (showSettings) loadSummary();
	}
	let input = $state('');
	let sendError = $state<string | null>(null);
	let streaming = $state(false);
	// 서버 MAX_USER_MSG_TOKENS(4000) × estimateTokens 비율(len/2) = 8000자.
	const MAX_USER_MSG_CHARS = 8000;
	let imgFailed = $state(false);
	// 헤더의 캐릭터 정보(썸네일·이름·설명) 클릭 시 상세 모달 표시.
	let showCharModal = $state(false);
	let scroller = $state<HTMLDivElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	// 터치(모바일) 기기 여부 — 이 경우 Enter 는 전송하지 않고 개행(기본 동작) 시킨다.
	let isTouch = $state(false);

	// ── 채팅 설정 ──
	let showSettings = $state(false);
	let modelOpen = $state(false); // 모델 드롭다운 열림
	let model = $state(DEFAULT_MODEL_ID); // 선택된 모델 ID
	let maxSentences = $state(12); // 응답 분량(문장 수)
	let userActs = $state(1); // '나' 행동·대사 생성: 0=금지, 1=적정, 2=풍부
	let iconFailed = $state<Record<string, boolean>>({});

	// ── 실시간 이미지 생성 설정/상태 ──
	let showImageSettings = $state(false); // 이미지 설정 모달
	let imageEnabled = $state(false); // 켜져 있으면 매 assistant 턴마다 이미지 생성
	let imageResolution = $state<ImgResolution>('832x1216');
	// 선택된 그림체 id('' = 기본 그림체). 즐겨찾기·추천 목록에서 prompt 를 해석해 사용.
	let imageStyleId = $state('');
	let favStyles = $state<ArtStyle[]>([]); // 즐겨찾기(내 생성 제외)
	let savedStyles = $state<ArtStyle[]>([]); // 내가 만든(공유/저장)
	let fallbackStyle = $state<ArtStyle | null>(null); // 아무것도 없을 때 기본(가장 먼저 공유된 그림체)
	let favStylesLoaded = $state(false);
	let styleOpen = $state(false); // 그림체 드롭다운 열림
	const recommendedStyle = $derived(data.recommendedStyle ?? null);
	// 현재 선택된 그림체 객체(드롭다운 트리거 표시용). 기본 선택('')이면 null.
	const selectedStyle = $derived.by(() => {
		if (!imageStyleId) return null;
		if (recommendedStyle?.id === imageStyleId) return recommendedStyle;
		return (
			favStyles.find((s) => s.id === imageStyleId) ??
			savedStyles.find((s) => s.id === imageStyleId) ??
			null
		);
	});
	// 선택된 그림체의 프롬프트. 기본('')일 때: Hub 최초 공유 그림체(fallback), 그것도 없으면 빈 문자열.
	const selectedStylePrompt = $derived.by(() => {
		if (imageStyleId) return selectedStyle?.prompt ?? '';
		return fallbackStyle?.prompt ?? '';
	});
	// 드롭다운 트리거 썸네일: 선택된 그림체, 없으면(기본) fallback 썸네일.
	const trigStyle = $derived(selectedStyle ?? fallbackStyle);
	let imagePromptModel = $state(DEFAULT_IMG_PROMPT_MODEL); // 상황 프롬프트 생성 모델
	let imgModelOpen = $state(false); // 이미지 프롬프트 모델 드롭다운 열림
	let imageEarly = $state(false); // 빠른 생성 우선(스트리밍 중 미리 발사)
	let ignoreCharacterAssets = $state(false); // 캐릭터 내장 이미지(장면·감정 스프라이트) 표시 안 함
	let naiKeyRegistered = $state<boolean | null>(null); // null=미확인, false=미등록, true=등록됨
	let naiStatusLoading = $state(false);

	const currentImgModel = $derived(getModel(imagePromptModel) ?? MODELS[0]);

	const currentModel = $derived(getModel(model) ?? MODELS[0]);

	// charx import 로컬(IndexedDB) 장면 이미지 — 바이트가 이 기기에 없으면(다른 기기에서 import)
	// 채팅에서 이미지가 조용히 숨겨진다 → 한 장도 없으면 경고 배너를 띄운다.
	// (한 장이라도 있으면 이 기기에서 import 한 것 → 정상.)
	let localImagesMissing = $state(false);
	async function checkLocalImages() {
		localImagesMissing = false;
		const set = character.imageSet;
		if (!isLocalSet(set)) return;
		const ids = isGrid(set)
			? set.entries.map((e) => e.id)
			: isNamed(set)
				? set.images.map((i) => i.id)
				: [];
		if (ids.length === 0) return;
		const cid = character.id;
		for (const id of ids) {
			if (await getLocalSceneBlob(localSceneKey(cid, id))) return; // 하나라도 있으면 정상
		}
		// 이 캐릭터로 보고 있는 동안에만 반영(체크 중 다른 캐릭터로 이동했으면 무시).
		if (character.id === cid) localImagesMissing = true;
	}

	onMount(() => {
		const savedModel = localStorage.getItem(MODEL_KEY);
		if (savedModel && getModel(savedModel)) model = savedModel;
		const savedLen = Number(localStorage.getItem(SENTENCE_KEY));
		if (savedLen) maxSentences = Math.min(SENTENCE_MAX, Math.max(SENTENCE_MIN, savedLen));
		const savedActs = localStorage.getItem(USER_ACTS_KEY);
		if (savedActs !== null) userActs = Math.min(2, Math.max(0, Number(savedActs)));
		// 실시간 이미지 설정 복원
		imageEnabled = localStorage.getItem(IMG_ENABLED_KEY) === '1';
		const savedRes = localStorage.getItem(IMG_RES_KEY);
		if (savedRes === '832x1216' || savedRes === '1024x1024') imageResolution = savedRes;
		imageStyleId = localStorage.getItem(IMG_STYLE_ID_KEY) ?? '';
		const savedPM = localStorage.getItem(IMG_PROMPT_MODEL_KEY);
		if (savedPM && getModel(savedPM)) imagePromptModel = savedPM;
		imageEarly = localStorage.getItem(IMG_EARLY_KEY) === '1';
		ignoreCharacterAssets = localStorage.getItem(IMG_IGNORE_ASSETS_KEY) === '1';
		// 켜진 상태로 복원됐으면 키 등록 여부를 검증(키 없으면 loadNaiStatus 가 끈다).
		if (imageEnabled && data.user) loadNaiStatus();
		// 터치 기반(소프트 키보드) 기기 감지 → Enter 는 개행으로
		isTouch = window.matchMedia('(pointer: coarse)').matches;
		// 이어가는 세션은 최신 메시지(맨 아래)로, 새 채팅(오프닝만)은 맨 위로.
		if (messages.length > 0)
			tick().then(() => scroller?.scrollTo({ top: data.sessionId ? scroller.scrollHeight : 0 }));
		checkLocalImages();
	});
	$effect(() => {
		localStorage.setItem(MODEL_KEY, model);
	});
	$effect(() => {
		localStorage.setItem(SENTENCE_KEY, String(maxSentences));
	});
	$effect(() => {
		localStorage.setItem(USER_ACTS_KEY, String(userActs));
	});
	$effect(() => {
		localStorage.setItem(IMG_ENABLED_KEY, imageEnabled ? '1' : '0');
	});
	$effect(() => {
		localStorage.setItem(IMG_RES_KEY, imageResolution);
	});
	$effect(() => {
		localStorage.setItem(IMG_STYLE_ID_KEY, imageStyleId);
	});

	// 채팅 그림체 선택지(즐겨찾기 + 내 저장). 모달 열 때 1회 로드.
	async function loadFavStyles() {
		if (favStylesLoaded) return;
		favStylesLoaded = true;
		try {
			const res = await fetch('/api/styles/forchat');
			if (res.ok) {
				const d = (await res.json()) as {
					favorites: ArtStyle[];
					saved: ArtStyle[];
					fallback: ArtStyle | null;
				};
				favStyles = d.favorites ?? [];
				savedStyles = d.saved ?? [];
				fallbackStyle = d.fallback ?? null;
			}
		} catch (e) {
			console.error(e);
		}
	}
	$effect(() => {
		localStorage.setItem(IMG_PROMPT_MODEL_KEY, imagePromptModel);
	});
	$effect(() => {
		localStorage.setItem(IMG_EARLY_KEY, imageEarly ? '1' : '0');
	});
	$effect(() => {
		localStorage.setItem(IMG_IGNORE_ASSETS_KEY, ignoreCharacterAssets ? '1' : '0');
	});

	// NovelAI 키 등록 상태 조회(이미지 설정 모달 열 때 1회). 미등록이면 등록 안내를 띄운다.
	async function loadNaiStatus() {
		if (naiStatusLoading) return;
		naiStatusLoading = true;
		try {
			const res = await fetch('/api/keys/novelai');
			if (res.ok) {
				const d = (await res.json()) as { registered: boolean };
				naiKeyRegistered = !!d.registered;
				// 키가 없으면 활성화 불가 → 이전에 켜져 있었더라도 끈다.
				if (!naiKeyRegistered) imageEnabled = false;
			}
		} catch (e) {
			console.error(e);
		} finally {
			naiStatusLoading = false;
		}
	}

	function toggleImageSettings() {
		showImageSettings = !showImageSettings;
		if (showImageSettings) {
			if (naiKeyRegistered === null) loadNaiStatus();
			loadFavStyles();
		}
	}
	function closeImageSettings() {
		showImageSettings = false;
		imgModelOpen = false;
		styleOpen = false;
	}
	function selectImgModel(id: string) {
		imagePromptModel = id;
		imgModelOpen = false;
	}
	function selectStyle(id: string) {
		imageStyleId = id;
		styleOpen = false;
	}
	function openApiKeys() {
		apiKeyModal.open = true;
	}

	/**
	 * NovelAI 장면 이미지 생성 코어. NDJSON 스트림(중간 프리뷰→done/error)을 받아 대상
	 * image_generation 메시지를 갱신한다. replaceId 가 있으면 서버가 같은 행/R2 키를 덮어쓴다.
	 * 대상 메시지는 id 로 매번 동적 조회($state 프록시로 수정해야 반응성 유지).
	 */
	async function runSceneImage(opts: {
		sid: string;
		text: string;
		msgId: string;
		replaceId?: string;
		assistantMsgId?: string;
	}) {
		const { sid, text, replaceId, assistantMsgId } = opts;
		let currentId = opts.msgId; // 신규 생성은 done 에서 서버 id 로 교체됨
		const at = () => messages.findIndex((x) => x.id === currentId);
		let lastPreview: string | null = null;
		const setPreview = (b64: string) => {
			try {
				const url = URL.createObjectURL(base64ToBlob(b64));
				if (lastPreview) URL.revokeObjectURL(lastPreview);
				lastPreview = url;
				const i = at();
				if (i >= 0) messages[i].previewUrl = url;
			} catch {
				/* 무시 — 프리뷰 디코드 실패는 무해 */
			}
		};
		try {
			const res = await fetch('/api/chat/image', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					sessionId: sid,
					assistantText: text,
					resolution: imageResolution,
					stylePrompt: selectedStylePrompt,
					promptModel: imagePromptModel,
					replaceId: replaceId || undefined,
					assistantMsgId: assistantMsgId || undefined,
					debug: debug || undefined
				})
			});

			// 상황 프롬프트 실패 등은 JSON 에러로 옴(스트림 아님).
			const ctype = res.headers.get('content-type') ?? '';
			if (!res.ok || !res.body || !ctype.includes('ndjson')) {
				const d = (await res.json().catch(() => ({}))) as {
					error?: string;
					message?: string;
					debug?: ImageDebug;
				};
				if (debug && d.debug) imageDebug = d.debug;
				const i = at();
				if (i >= 0) {
					messages[i].pending = false;
					messages[i].errorReason = d.message ?? '이미지 생성에 실패했습니다.';
				}
				if (d.error === 'no_key') naiKeyRegistered = false;
				return;
			}

			// NDJSON 스트림: t:frame(중간 프리뷰) → t:done/t:error.
			const handle = (obj: Record<string, unknown>) => {
				if (obj.t === 'frame' && typeof obj.img === 'string') {
					setPreview(obj.img);
				} else if (obj.t === 'done') {
					const i = at();
					if (i >= 0) {
						messages[i].content = String(obj.key ?? '');
						if (obj.id) {
							messages[i].id = String(obj.id);
							currentId = String(obj.id);
						}
						if (obj.cost != null) messages[i].cost = Number(obj.cost);
						messages[i].previewUrl = undefined;
						messages[i].pending = false;
						messages[i].errorReason = undefined; // 재생성 성공 시 이전 에러 사유 제거
					}
					if (lastPreview) {
						URL.revokeObjectURL(lastPreview);
						lastPreview = null;
					}
					if (debug && obj.debug) imageDebug = obj.debug as ImageDebug;
				} else if (obj.t === 'error') {
					const i = at();
					if (i >= 0) {
						messages[i].pending = false;
						messages[i].errorReason = (obj.message as string) ?? '이미지 생성에 실패했습니다.';
					}
					if (debug && obj.debug) imageDebug = obj.debug as ImageDebug;
					if (obj.error === 'no_key') naiKeyRegistered = false;
				}
			};
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			const drain = (flush = false) => {
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const ln = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (ln) {
						try {
							handle(JSON.parse(ln));
						} catch {
							/* 무시 */
						}
					}
				}
				if (flush && buf.trim()) {
					try {
						handle(JSON.parse(buf.trim()));
					} catch {
						/* 무시 */
					}
					buf = '';
				}
			};
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				drain();
			}
			drain(true);
		} catch (e) {
			const i = at();
			if (i >= 0) {
				messages[i].pending = false;
				messages[i].errorReason = e instanceof Error ? e.message : '이미지 생성에 실패했습니다.';
			}
		} finally {
			// 최종 이미지가 들어왔으면 남은 프리뷰 URL 정리.
			const i = at();
			if (lastPreview && i >= 0 && messages[i]?.content) URL.revokeObjectURL(lastPreview);
			invalidate('app:recentChats');
		}
	}

	/**
	 * 방금 완료된 assistant 응답을 바탕으로 NovelAI 장면 이미지를 생성해 메시지로 추가한다.
	 * 매 assistant 턴 직후(send 의 finally) 호출. 세션이 확정된 상태에서만 동작.
	 */
	async function generateSceneImage(assistantText: string, assistantMsgId?: string) {
		const sid = sessionId;
		const text = assistantText.trim();
		if (!sid || !imageEnabled || !text) return;

		// 생성 중 플레이스홀더(프록시로 감싸지므로 messages[idx] 로 수정).
		const tempId = crypto.randomUUID();
		messages.push({ id: tempId, role: 'image_generation', content: '', pending: true });
		await runSceneImage({ sid, text, msgId: tempId, assistantMsgId });
	}

	/** 재생성 중인 이미지 메시지 id(버튼 비활성·스피너 표시용). */
	let regenerating = $state<string | null>(null);

	/**
	 * 기존 생성 이미지를 같은 자리에서 다시 생성한다(🔄 버튼). 직전 assistant 응답을 소스로
	 * /api/chat/image 에 replaceId 와 함께 보내 같은 행/R2 키를 덮어쓴다(순서·DB 행 유지).
	 */
	async function regenerateSceneImage(m: ChatMessage) {
		if (streaming || regenerating || deleting) return;
		const sid = sessionId;
		if (!sid) return;
		const idx = messages.findIndex((x) => x.id === m.id);
		if (idx < 0) return;
		// 이 이미지를 만든 소스 = 바로 앞의 assistant 메시지 본문.
		let srcText = '';
		for (let i = idx - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant' && messages[i].content.trim()) {
				srcText = messages[i].content.trim();
				break;
			}
		}
		if (!srcText) return;
		regenerating = m.id;
		messages[idx].pending = true;
		messages[idx].errorReason = undefined;
		try {
			await runSceneImage({ sid, text: srcText, msgId: m.id, replaceId: m.id });
		} finally {
			regenerating = null;
		}
	}

	function selectModel(id: string) {
		model = id;
		modelOpen = false;
	}

	function closeSettings() {
		showSettings = false;
		modelOpen = false;
	}

	// 다른 캐릭터/세션으로 이동(컴포넌트 재사용) 시 해당 대화로 다시 초기화.
	// 같은 캐릭터의 다른 세션(사이드바)으로 이동하는 경우도 있으므로 캐릭터 id 만으로는 부족 →
	// 서버 로드가 가리키는 (캐릭터·세션·오프닝) 조합을 키로 비교한다.
	// 로컬 sessionId(첫 전송 시 lazy 생성으로 갱신)는 키에 넣지 않는다 → 전송 중 메시지가 날아가지 않게.
	const loadKey = $derived(`${data.character.id}|${data.sessionId ?? ''}|${data.openingIndex}`);
	let appliedKey = untrack(() => loadKey);
	$effect(() => {
		if (loadKey === appliedKey) return;
		appliedKey = loadKey;
		messages = initialMessages(data);
		sessionId = data.sessionId;
		oldestSeq = data.oldestSeq ?? 0;
		hasMore = data.hasMore ?? false;
		input = '';
		sendError = null;
		// 상시 기억·요약 드래프트도 초기화(다른 대화의 입력값이 새 세션에 새지 않게). 모달 열 때 다시 로드.
		memory = null;
		memoryDraft = '';
		summary = null;
		summaryDraft = '';
		// 이어가는 세션은 맨 아래(최신 메시지)로, 새 채팅(오프닝만)은 맨 위로 즉시 이동
		if (messages.length > 0)
			tick().then(() => scroller?.scrollTo({ top: data.sessionId ? scroller.scrollHeight : 0 }));
		// 다른 캐릭터로 이동했을 수 있으니 로컬 이미지 보유 여부 재확인.
		checkLocalImages();
	});

	// 위로 스크롤 시 과거 메시지 한 페이지를 prepend. 스크롤 위치는 유지한다.
	async function loadOlder() {
		if (loadingMore || !hasMore || !sessionId || !scroller) return;
		// 인디케이터/프리펜드 전 높이를 먼저 기록 → 복원 시 인디케이터 높이가 섞이지 않게.
		const prevHeight = scroller.scrollHeight;
		const prevTop = scroller.scrollTop;
		loadingMore = true;
		try {
			const res = await fetch(
				`/api/chat/messages?sessionId=${encodeURIComponent(sessionId)}&before=${oldestSeq}`
			);
			if (!res.ok) return;
			const d = (await res.json()) as {
				messages: ChatMessage[];
				oldestSeq: number;
				hasMore: boolean;
			};
			if (d.messages.length === 0) {
				hasMore = false;
				return;
			}
			messages = [...d.messages, ...messages];
			oldestSeq = d.oldestSeq;
			hasMore = d.hasMore;
		} catch (e) {
			console.error(e);
		} finally {
			loadingMore = false;
			// 인디케이터 제거 후 측정해야 정확. prepend 로 늘어난 높이만큼 내려 위치 유지.
			await tick();
			if (scroller) scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
		}
	}

	function onReaderScroll() {
		if (scroller && scroller.scrollTop < 120 && hasMore && !loadingMore) loadOlder();
	}

	// ── 소설 파서: {@html} 없이 텍스트 세그먼트로만 렌더 → XSS 안전.
	//   • 대사 줄("이름 | 대사")   → parseInline: 괄호( )/별표(*) 안만 기울임, 대사 본문은 정자체.
	//   • 서술/지시문 줄(그 외 전체) → parseNarration: 줄 전체를 기울임. 단 "..." 대사는 정자체로 유지.
	//   모델이 묘사를 괄호로 감싸든(한 줄·여러 줄) 그냥 산문으로 쓰든 일관되게 기울임으로 보인다.
	type Segment = { text: string; italic: boolean };

	// 대사 줄 안의 인라인 지시문: ( )/*..* 안만 기울임. 구분자(괄호·별표)는 제거.
	function parseInline(content: string): Segment[] {
		const segments: Segment[] = [];
		const re = /\(([^)]*)\)|\*([^*]+)\*/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			if (m.index > last) segments.push({ text: content.slice(last, m.index), italic: false });
			segments.push({ text: m[1] ?? m[2] ?? '', italic: true });
			last = re.lastIndex;
		}
		if (last < content.length) segments.push({ text: content.slice(last), italic: false });
		return segments;
	}

	// 서술 줄: 큰따옴표("..." / “...”) 안=대사(정자체), 그 밖 전체=기울임.
	// 괄호·별표는 기울임 구분자로 보고 제거(내용만 남김).
	const QUOTE_RE = /"([^"]*)"|“([^”]*)”/g;
	function parseNarration(line: string): Segment[] {
		const segments: Segment[] = [];
		const pushNarr = (raw: string) => {
			const clean = raw.replace(/[()*]/g, '');
			if (clean) segments.push({ text: clean, italic: true });
		};
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = QUOTE_RE.exec(line)) !== null) {
			if (m.index > last) pushNarr(line.slice(last, m.index));
			const inner = m[1] ?? m[2] ?? '';
			segments.push({ text: `"${inner}"`, italic: false });
			last = QUOTE_RE.lastIndex;
		}
		if (last < line.length) pushNarr(line.slice(last));
		return segments;
	}

	// "발화자 | 대사" 형식이면 분리. 발화자는 |·(·줄바꿈 없는 짧은 토큰.
	function parseSpeaker(line: string): { speaker: string; rest: string } | null {
		const m = /^([^|\n(]{1,24}?)\s*\|\s*(.+)$/.exec(line);
		return m ? { speaker: m[1].trim(), rest: m[2] } : null;
	}

	// 본문을 렌더 아이템으로 분해.
	//   • 펜스 블록(```{제목} … ```) → kind:'block' (제목 헤더 + 본문, 줄바꿈 보존).
	//   • 그 외 줄                    → kind:'line' (기존 소설 파서로 렌더).
	// 스트리밍 중엔 닫는 펜스(```)가 아직 안 와도 열린 블록으로 누적 표시한다.
	type RenderItem = { kind: 'line'; text: string } | { kind: 'block'; title: string; body: string };
	const FENCE_OPEN = /^\s*```(.*)$/;
	const FENCE_CLOSE = /^\s*```\s*$/;
	function parseBody(content: string): RenderItem[] {
		const items: RenderItem[] = [];
		const raw = content.split('\n');
		let i = 0;
		while (i < raw.length) {
			const open = FENCE_OPEN.exec(raw[i]);
			if (open) {
				// 정보 문자열(```뒤)에서 제목 추출: "{제목}" 형태면 그 안, 아니면 그대로.
				const info = open[1].trim();
				const braced = /^\{(.*)\}$/.exec(info);
				// 스트리밍 중 미완성 "{제…" 는 제목을 비워 깜빡임 방지.
				const title = braced ? braced[1].trim() : info.startsWith('{') ? '' : info;
				const bodyLines: string[] = [];
				i++;
				while (i < raw.length && !FENCE_CLOSE.test(raw[i])) {
					bodyLines.push(raw[i]);
					i++;
				}
				if (i < raw.length) i++; // 닫는 펜스 소비
				items.push({ kind: 'block', title, body: bodyLines.join('\n').replace(/\s+$/, '') });
				continue;
			}
			const trimmed = raw[i].trim();
			if (trimmed.length > 0) items.push({ kind: 'line', text: trimmed });
			i++;
		}
		return items;
	}

	const lastMessage = $derived(messages[messages.length - 1]);

	async function scrollToBottom() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	async function send() {
		const text = input.trim();
		if (!text || streaming) return;

		// 비로그인 상태에서는 전송 대신 로그인 모달을 띄운다 (입력값은 유지)
		if (!data.user) {
			openLogin();
			return;
		}

		// 너무 긴 메시지는 서버가 413 으로 거부하므로 전송 전에 막는다 (입력값 유지)
		if (text.length > MAX_USER_MSG_CHARS) {
			sendError = `메시지가 너무 길어요. ${MAX_USER_MSG_CHARS.toLocaleString()}자 이내로 줄여주세요. (현재 ${text.length.toLocaleString()}자)`;
			return;
		}
		sendError = null;

		input = '';
		resetTextareaHeight();

		// 클라가 메시지 id 를 생성해 서버로 보내고, 서버는 이 id 를 DB PK 로 저장한다 →
		// 새로고침 전(라이브) 메시지도 같은 id 로 DB 삭제가 가능해진다.
		const userMsgId = crypto.randomUUID();
		const assistantMsgId = crypto.randomUUID();
		messages.push({ id: userMsgId, role: 'user', content: text });

		// assistant placeholder. $state 배열은 push 시 프록시로 감싸므로,
		// 반드시 messages[idx] (프록시)를 통해 수정해야 반응성이 동작한다.
		const idx = messages.length;
		messages.push({ id: assistantMsgId, role: 'assistant', content: '' });
		streaming = true;
		// 첫 대화(세션 없음)면 미리 입력해 둔 상시 기억을 세션 생성과 함께 저장한다.
		const newSessionMemory = sessionId ? undefined : memoryDraft.trim() || undefined;
		await scrollToBottom();

		// 응답 완료 후 실시간 이미지를 생성할지(정상 응답일 때만) — finally 에서 트리거.
		let imageAfter = false;
		let imageText = '';
		// '빠른 이미지'(imageEarly) 가 켜져 있으면 스트리밍 도중 일정량 도달 시 미리 발사(아래 루프).
		let imageFired = false;

		try {
			// 서버가 history 의 주인. 새 유저 메시지만 보내고, 세션이 없으면 오프닝 인덱스로 생성.
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					characterId: character.id,
					sessionId: sessionId ?? undefined,
					text,
					openingIndex: data.openingIndex,
					model,
					maxSentences,
					userActs,
					userMsgId,
					assistantMsgId,
					memory: newSessionMemory,
					debug: debug || undefined
				})
			});

			if (res.status === 413) {
				messages[idx].content = `⚠️ 메시지가 너무 길어요. ${MAX_USER_MSG_CHARS.toLocaleString()}자 이내로 줄여주세요.`;
				return;
			}
			if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

			// 서버가 lazy 생성한 세션 id 회수 (이후 전송부터 이어가기)
			const newSession = res.headers.get('x-haven-session');
			if (newSession) {
				sessionId = newSession;
				// URL 을 세션 경로로 교체(새로고침/공유 시 이어가기). load 재실행 없는 shallow routing.
				const sessionPath = `/chat/${character.id}/session/${newSession}${debug ? '/debug' : ''}`;
				replaceState(sessionPath, {});
				// 첫 전송과 함께 저장된 상시 기억을 클라 상태에도 반영(모달 재오픈 시 일관성).
				if (newSessionMemory !== undefined) {
					memory = newSessionMemory;
					memoryDraft = newSessionMemory;
				}
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			// 스트림 끝에 붙는 메타 프레임(META_SEP + JSON)은 화면에 렌더하지 않고 콘솔에만 찍는다.
			let raw = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				raw += decoder.decode(value, { stream: true });
				const sep = raw.indexOf(META_SEP);
				messages[idx].content = sep >= 0 ? raw.slice(0, sep) : raw;
				// '빠른 이미지': 응답이 일정량 도달하면 마지막 부분 반영을 포기하고 이미지를 미리 발사
				// → NovelAI 생성이 채팅 스트리밍과 겹쳐 돌아 체감 대기를 줄인다. 턴당 1회만.
				if (
					imageEnabled &&
					imageEarly &&
					!imageFired &&
					sessionId &&
					messages[idx].content.length >= IMG_EARLY_TRIGGER_CHARS
				) {
					imageFired = true;
					generateSceneImage(messages[idx].content, assistantMsgId);
				}
			}
			raw += decoder.decode(); // 멀티바이트 잔여 flush
			const sep = raw.indexOf(META_SEP);
			const metaJson = sep >= 0 ? raw.slice(sep + META_SEP.length) : '';
			if (sep >= 0) {
				messages[idx].content = raw.slice(0, sep);
				logResponseMeta(metaJson);
				const c = parseCost(metaJson);
				if (c != null) messages[idx].cost = c;
				// 디버그 모드: 메타 프레임에서 조립 스냅샷·전체 메타를 떼어 패널로.
				if (debug) {
					try {
						const meta = JSON.parse(metaJson) as Record<string, unknown>;
						debugMeta = meta;
						if (meta.debug) debugSnapshot = meta.debug as ChatDebugSnapshot;
					} catch {
						/* 무시 — 패널은 직전 값 유지 */
					}
				}
			}
			// 하드 에러(streamError·비정상 finishReason)는 그대로 노출하고, 그게 아니어도
			// 응답이 비어 있으면 메타에서 사유를 끌어내 같은 경고 포맷으로 노출(조용한 무응답 방지).
			const reason =
				parseErrorReason(metaJson) ??
				(messages[idx].content.trim() ? null : emptyResponseReason(metaJson));
			if (reason) messages[idx].errorReason = reason;
			// 정상 응답이고 실시간 이미지가 켜져 있으면 이번 응답으로 이미지 생성 예약.
			// 단, '빠른 생성 우선'으로 스트리밍 중 이미 발사했으면(imageFired) 다시 생성하지 않는다.
			imageText = messages[idx].content;
			imageAfter = imageEnabled && !imageFired && !reason && imageText.trim() !== '';
		} catch (e) {
			messages[idx].content = '⚠️ 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.';
			messages[idx].errorReason = e instanceof Error ? e.message : String(e);
			console.error(e);
		} finally {
			streaming = false;
			// 새 세션·최신 미리보기가 새로고침 없이 사이드바에 반영되도록 목록만 무효화.
			invalidate('app:recentChats');
			// 텍스트 응답 완료 후 이미지 생성(비동기 — 스트리밍 종료를 막지 않음).
			if (imageAfter) generateSceneImage(imageText, assistantMsgId);
		}
	}

	// 메시지(user/assistant 무관) 1건 삭제 — 실제 DB 행을 지우고 화면에서도 제거.
	// 라이브 메시지는 클라 id == DB id 라 바로 지워진다. 세션/DB 에 아직 없는 메시지(예: 새 세션의
	// 오프닝, 영속화 직전)는 404 가 나오는데, 그 경우에도 화면에서는 제거한다(낙관적).
	let deleting = $state<string | null>(null);
	async function deleteMessage(m: ChatMessage) {
		if (streaming || deleting) return;
		if (!confirm('이 메시지를 삭제할까요? 되돌릴 수 없습니다.')) return;
		deleting = m.id;
		try {
			if (sessionId) {
				const res = await fetch('/api/chat/messages', {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ messageId: m.id })
				});
				// 404 = DB 에 아직 없음(라이브/오프닝) → 화면에서만 제거. 그 외 실패는 유지.
				if (!res.ok && res.status !== 404) {
					console.error('[haven] 메시지 삭제 실패', res.status);
					return;
				}
			}
			messages = messages.filter((x) => x.id !== m.id);
			// 사이드바 최근 미리보기(마지막 메시지)가 바뀔 수 있으니 목록 무효화.
			invalidate('app:recentChats');
		} catch (e) {
			console.error(e);
		} finally {
			deleting = null;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		// 모바일(터치)에서는 Enter 를 전송으로 가로채지 않고 기본 개행 동작에 맡긴다.
		if (isTouch) return;
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	}

	function onWindowKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (modelOpen) modelOpen = false;
		else if (imgModelOpen) imgModelOpen = false;
		else if (styleOpen) styleOpen = false;
		else if (showSettings) showSettings = false;
		else if (showImageSettings) closeImageSettings();
	}

	function autoGrow() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
	}
	function resetTextareaHeight() {
		if (textarea) textarea.style.height = 'auto';
	}
</script>

<svelte:head>
	<title>{character.name} — Haven</title>
</svelte:head>

<svelte:window onkeydown={onWindowKey} />

<div class="chat-shell" class:debug>
<div class="chat">
	<header class="chat-header">
		<a class="back" href="/" aria-label="뒤로">←</a>
		<button
			class="char-info"
			onclick={() => (showCharModal = true)}
			aria-label="{character.name} 정보 보기"
		>
			<div class="avatar-sm">
				{#if imgFailed}
					<span>{character.name.charAt(0)}</span>
				{:else}
					<img src={character.avatarUrl} alt={character.name} onerror={() => (imgFailed = true)} />
				{/if}
			</div>
			<div class="who">
				<div class="name-row">
					<strong>{character.name}</strong>
					{#if character.contentRating === 'nsfw'}
						<NsfwBadge size={17} />
					{/if}
				</div>
				<span class="tagline">{character.tagline}</span>
			</div>
		</button>
		<div class="header-right">
			<button
				class="settings-btn"
				class:active={imageEnabled}
				onclick={toggleImageSettings}
				aria-label="실시간 이미지"
				aria-expanded={showImageSettings}
				title="실시간 이미지 생성"
			>
				<svg
					viewBox="0 0 24 24"
					width="18"
					height="18"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<circle cx="8.5" cy="8.5" r="1.5" />
					<path d="m21 15-5-5L5 21" />
				</svg>
			</button>
			<button
				class="settings-btn"
				class:active={showSettings}
				onclick={toggleSettings}
				aria-label="채팅 설정"
				aria-expanded={showSettings}
			>
				<svg
					viewBox="0 0 24 24"
					width="18"
					height="18"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="3" />
					<path
						d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
					/>
				</svg>
			</button>
		</div>
	</header>

	<CharacterDetailModal
		character={showCharModal ? character : null}
		onclose={() => (showCharModal = false)}
	/>

	{#if localImagesMissing}
		<div class="local-warn" role="status">
			이 기기에는 이 캐릭터의 장면 이미지가 없어 대화에 이미지가 표시되지 않습니다. 이미지를 가져온 기기에서
			<strong>기기간 공유</strong>를 누르면 모든 기기에서 볼 수 있어요.
		</div>
	{/if}

	{#if showSettings}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="modal-backdrop" onclick={closeSettings} role="presentation">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="채팅 설정"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
			>
				<div class="modal-head">
					<h2>채팅 설정</h2>
					<button class="modal-close" onclick={closeSettings} aria-label="닫기">✕</button>
				</div>

				<div class="setting">
					<div class="setting-row">
						<span class="field-label" id="model-label">모델</span>
					</div>
					<div class="model-select">
						<button
							class="model-trigger"
							class:open={modelOpen}
							onclick={() => (modelOpen = !modelOpen)}
							aria-haspopup="listbox"
							aria-expanded={modelOpen}
							aria-labelledby="model-label"
						>
							{#if iconFailed[currentModel.id]}
								<span class="model-icon fallback">{currentModel.label.charAt(0)}</span>
							{:else}
								<img
									class="model-icon"
									src={currentModel.icon}
									alt=""
									onerror={() => (iconFailed[currentModel.id] = true)}
								/>
							{/if}
							<span class="model-name">{currentModel.label}</span>
							<span class="chev">▾</span>
						</button>
						{#if modelOpen}
							<ul class="model-list" role="listbox" aria-labelledby="model-label">
								{#each MODELS as m (m.id)}
									<li>
										<button
											class="model-option"
											class:selected={m.id === model}
											role="option"
											aria-selected={m.id === model}
											onclick={() => selectModel(m.id)}
										>
											{#if iconFailed[m.id]}
												<span class="model-icon fallback">{m.label.charAt(0)}</span>
											{:else}
												<img
													class="model-icon"
													src={m.icon}
													alt=""
													onerror={() => (iconFailed[m.id] = true)}
												/>
											{/if}
											<span class="model-name">{m.label}</span>
											{#if m.id === model}<span class="check">✓</span>{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>

				<div class="setting">
					<div class="setting-row">
						<label for="len-slider">답변 길이</label>
						<span class="len-val">약 {maxSentences}문장</span>
					</div>
					<input
						id="len-slider"
						type="range"
						min={SENTENCE_MIN}
						max={SENTENCE_MAX}
						step="1"
						bind:value={maxSentences}
					/>
					<div class="len-scale">
						<span>짧게 ({SENTENCE_MIN})</span>
						<span>길게 ({SENTENCE_MAX})</span>
					</div>
				</div>

				<div class="setting">
					<div class="setting-row">
						<label for="acts-slider">'나'의 행동·대사 생성</label>
						<span class="len-val">{USER_ACTS_LABELS[userActs]}</span>
					</div>
					<input id="acts-slider" type="range" min="0" max="2" step="1" bind:value={userActs} />
					<div class="len-scale">
						{#each USER_ACTS_LABELS as label (label)}
							<span>{label}</span>
						{/each}
					</div>
					<p class="setting-hint">
						{#if userActs === 0}
							AI는 캐릭터와 상황만 묘사하고, 내 행동·대사는 대신 쓰지 않습니다.
						{:else if userActs === 2}
							AI가 내 행동·대사까지 함께 묘사하며 이야기를 적극적으로 이끕니다.
						{:else}
							내 입력을 따르되, 자연스러운 가벼운 반응 정도만 덧붙입니다.
						{/if}
					</p>
				</div>

				<div class="setting">
					<div class="setting-row">
						<span class="field-label">상시 기억</span>
						<span class="memory-count">{memoryDraft.length}/{MAX_MEMORY_CHARS}</span>
					</div>
					<p class="setting-hint">
						대화 내내 <strong>항상 기억</strong>시킬 정보를 직접 적어두세요(예: 호칭, 설정, 금기).
						요약과 달리 사라지지 않고 매 응답에 반영됩니다.
					</p>
					{#if summaryLoading}
						<p class="summary-empty">불러오는 중…</p>
					{:else}
						<textarea
							class="summary-edit"
							bind:value={memoryDraft}
							rows="2"
							maxlength={MAX_MEMORY_CHARS}
							placeholder="예: 나를 '주인님'이라 부른다. 존댓말 사용."
						></textarea>
						{#if sessionId}
							<div class="summary-actions">
								{#if memorySaved && !memoryDirty}
									<span class="summary-note">저장됨</span>
								{/if}
								<button
									class="summary-save"
									onclick={saveMemory}
									disabled={memorySaving || !memoryDirty}
								>
									{memorySaving ? '저장 중…' : '저장'}
								</button>
							</div>
						{/if}
					{/if}
				</div>

				<div class="setting">
					{#if summary !== null}
						<button
							class="summary-toggle"
							onclick={() => (summaryExpanded = !summaryExpanded)}
							aria-expanded={summaryExpanded}
						>
							<span class="field-label">대화 요약</span>
							<span class="chevron" class:open={summaryExpanded}>›</span>
						</button>
					{:else}
						<div class="setting-row">
							<span class="field-label">대화 요약</span>
						</div>
					{/if}
					{#if !sessionId}
						<p class="summary-empty">대화를 시작하면 요약이 만들어집니다.</p>
					{:else if summaryLoading}
						<p class="summary-empty">불러오는 중…</p>
					{:else if summary !== null}
						{#if summaryExpanded}
							<p class="setting-hint">
								대화가 길어지면 오래된 내용은 <strong>요약</strong>으로 압축됩니다. 모델에는
								<strong>이 요약과 최근 메시지</strong>가 함께 전달돼요. 내용을 직접 고치면 이후 대화에 반영됩니다.
							</p>
							<textarea
								class="summary-edit"
								bind:value={summaryDraft}
								rows="6"
								placeholder="요약 내용"
							></textarea>
							<div class="summary-actions">
								{#if summarySaved && !summaryDirty}
									<span class="summary-note">저장됨</span>
								{/if}
								<button
									class="summary-save"
									onclick={saveSummary}
									disabled={summarySaving || !summaryDirty}
								>
									{summarySaving ? '저장 중…' : '저장'}
								</button>
							</div>
						{/if}
					{:else}
						<p class="summary-empty">아직 요약이 없어요. 대화가 길어지면 자동으로 생성됩니다.</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if showImageSettings}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="modal-backdrop" onclick={closeImageSettings} role="presentation">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="실시간 이미지"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
			>
				<div class="modal-head">
					<h2>실시간 이미지</h2>
					<button class="modal-close" onclick={closeImageSettings} aria-label="닫기">✕</button>
				</div>

				<div class="setting">
					<div class="setting-row">
						<span class="field-label" id="img-enable-label">실시간 이미지 생성</span>
						<button
							class="switch"
							class:on={imageEnabled}
							role="switch"
							aria-checked={imageEnabled}
							aria-labelledby="img-enable-label"
							disabled={naiKeyRegistered !== true}
							onclick={() => (imageEnabled = !imageEnabled)}
						>
							<span class="knob"></span>
						</button>
					</div>
					<p class="setting-hint">
						켜면 AI 응답마다 그 장면을 <strong>NovelAI</strong>로 그려 함께 보여줍니다. NovelAI
						<strong>Opus</strong> 키 등록이 필요해요.
					</p>
					<!-- 키 미등록이면 토글을 켤 수 없음을 안내(등록 후 사용 가능). -->
					{#if naiStatusLoading && naiKeyRegistered === null}
						<p class="setting-hint">키 등록 여부 확인 중…</p>
					{:else if naiKeyRegistered === false}
						<div class="img-notice">
							NovelAI 키가 없어 켤 수 없어요.
							<button class="link-btn" onclick={openApiKeys}>API 키 등록</button>
						</div>
					{/if}
				</div>

				{#if imageEnabled}
					<div class="setting">
						<div class="setting-row">
							<span class="field-label" id="img-model-label">상황 프롬프트 모델</span>
						</div>
						<div class="model-select">
							<button
								class="model-trigger"
								class:open={imgModelOpen}
								onclick={() => (imgModelOpen = !imgModelOpen)}
								aria-haspopup="listbox"
								aria-expanded={imgModelOpen}
								aria-labelledby="img-model-label"
							>
								{#if iconFailed[currentImgModel.id]}
									<span class="model-icon fallback">{currentImgModel.label.charAt(0)}</span>
								{:else}
									<img
										class="model-icon"
										src={currentImgModel.icon}
										alt=""
										onerror={() => (iconFailed[currentImgModel.id] = true)}
									/>
								{/if}
								<span class="model-name">{currentImgModel.label}</span>
								<span class="chev">▾</span>
							</button>
							{#if imgModelOpen}
								<ul class="model-list" role="listbox" aria-labelledby="img-model-label">
									{#each MODELS as m (m.id)}
										<li>
											<button
												class="model-option"
												class:selected={m.id === imagePromptModel}
												role="option"
												aria-selected={m.id === imagePromptModel}
												onclick={() => selectImgModel(m.id)}
											>
												{#if iconFailed[m.id]}
													<span class="model-icon fallback">{m.label.charAt(0)}</span>
												{:else}
													<img
														class="model-icon"
														src={m.icon}
														alt=""
														onerror={() => (iconFailed[m.id] = true)}
													/>
												{/if}
												<span class="model-name">{m.label}</span>
												{#if m.id === imagePromptModel}<span class="check">✓</span>{/if}
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
						<p class="setting-hint">
							마지막 응답을 그림 프롬프트로 변환할 모델입니다. 기본은 빠른 Gemini Flash.
						</p>
					</div>

					<div class="setting">
						<div class="setting-row">
							<span class="field-label">해상도</span>
						</div>
						<div class="res-row">
							{#each IMG_RESOLUTIONS as r (r)}
								<button
									class="res-btn"
									class:active={imageResolution === r}
									onclick={() => (imageResolution = r)}
								>
									{r}
								</button>
							{/each}
						</div>
					</div>

					<div class="setting">
						<div class="setting-row">
							<span class="field-label">그림체</span>
							<a class="hub-mini" href="/styles">Hub →</a>
						</div>
						{#snippet styleOption(st: ArtStyle, badge: string | null)}
							<li>
								<button
									class="style-opt"
									class:active={imageStyleId === st.id}
									role="option"
									aria-selected={imageStyleId === st.id}
									onclick={() => selectStyle(st.id)}
								>
									{#if st.thumbnailUrl}
										<img class="style-swatch" src={st.thumbnailUrl} alt="" />
									{:else}
										<span class="style-swatch default">✦</span>
									{/if}
									<span class="style-title">{st.title}</span>
									{#if badge}<span class="style-badge">{badge}</span>{/if}
								</button>
							</li>
						{/snippet}

						<div class="style-select">
							<button
								class="style-trigger"
								class:open={styleOpen}
								onclick={() => (styleOpen = !styleOpen)}
								aria-haspopup="listbox"
								aria-expanded={styleOpen}
							>
								{#if trigStyle?.thumbnailUrl}
									<img class="style-swatch" src={trigStyle.thumbnailUrl} alt="" />
								{:else}
									<span class="style-swatch default">✦</span>
								{/if}
								<span class="style-title">{selectedStyle ? selectedStyle.title : '기본 그림체'}</span>
								<span class="chev">▾</span>
							</button>
							{#if styleOpen}
								<ul class="style-list" role="listbox" aria-label="그림체">
									<li>
										<button
											class="style-opt"
											class:active={imageStyleId === ''}
											role="option"
											aria-selected={imageStyleId === ''}
											onclick={() => selectStyle('')}
										>
											{#if fallbackStyle?.thumbnailUrl}
												<img class="style-swatch" src={fallbackStyle.thumbnailUrl} alt="" />
											{:else}
												<span class="style-swatch default">✦</span>
											{/if}
											<span class="style-title">기본 그림체</span>
										</button>
									</li>
									{#if recommendedStyle}
										<li class="style-group">추천</li>
										{@render styleOption(recommendedStyle, '추천')}
									{/if}
									{#if favStyles.filter((s) => s.id !== recommendedStyle?.id).length}
										<li class="style-group">즐겨찾기</li>
										{#each favStyles as st (st.id)}
											{#if st.id !== recommendedStyle?.id}{@render styleOption(st, null)}{/if}
										{/each}
									{/if}
									{#if savedStyles.filter((s) => s.id !== recommendedStyle?.id).length}
										<li class="style-group">저장</li>
										{#each savedStyles as st (st.id)}
											{#if st.id !== recommendedStyle?.id}
												{@render styleOption(st, st.shared ? null : '비공개')}
											{/if}
										{/each}
									{/if}
								</ul>
							{/if}
						</div>
						<p class="setting-hint">
							<a href="/styles">그림체 Hub</a>에서 깎거나 즐겨찾기해 골라보세요.
						</p>
					</div>

					<div class="setting">
						<div class="setting-row">
							<span class="field-label" id="img-early-label">빠른 생성 우선</span>
							<button
								class="switch"
								class:on={imageEarly}
								role="switch"
								aria-checked={imageEarly}
								aria-labelledby="img-early-label"
								onclick={() => (imageEarly = !imageEarly)}
							>
								<span class="knob"></span>
							</button>
						</div>
						<p class="setting-hint">
							응답이 어느 정도 나오면 끝까지 기다리지 않고 <strong>미리 이미지를 생성</strong>해 대기를
							줄입니다. 대신 응답 <strong>마지막 부분은 그림에 반영되지 않을 수</strong> 있어요.
						</p>
					</div>
				{/if}

				<div class="setting">
					<div class="setting-row">
						<span class="field-label" id="img-ignore-label">캐릭터 에셋 무시</span>
						<button
							class="switch"
							class:on={ignoreCharacterAssets}
							role="switch"
							aria-checked={ignoreCharacterAssets}
							aria-labelledby="img-ignore-label"
							onclick={() => (ignoreCharacterAssets = !ignoreCharacterAssets)}
						>
							<span class="knob"></span>
						</button>
					</div>
					<p class="setting-hint">
						켜면 캐릭터에 원래 들어있는 이미지(장면·감정 스프라이트)를 채팅에 표시하지 않습니다.
						실시간 생성 이미지는 그대로 보여요.
					</p>
				</div>
			</div>
		</div>
	{/if}

	{#snippet novelBody(content: string, isUser: boolean)}
		{#each parseBody(content) as item, i (i)}
			{#if item.kind === 'block'}
				<!-- 펜스 블록(```{제목} … ```) → 제목 헤더 + 본문 카드.
				     스트리밍 중 내용이 아직 없으면(열린 펜스만) 빈 카드 깜빡임 방지. -->
				{#if item.title || item.body}
					<div class="block">
						{#if item.title}<div class="block-title">{item.title}</div>{/if}
						{#if item.body}<div class="block-body">{item.body}</div>{/if}
					</div>
				{/if}
			{:else}
				{@const line = item.text}
				{@const cardLine = displayEval(line)}
				{@const scene =
					cardLine === null
						? resolveSceneLine(line, character.id, character.imageSet, character.updatedAt)
						: null}
				<!-- 이 줄이 '캐릭터 내장 에셋'(장면·감정 스프라이트·토큰)인지. 별도 const 로 빼야
				     컴파일 시 `a && (b||c||d)` 의 괄호가 풀려 우선순위가 깨지는 문제를 피한다. -->
				{@const isCharacterAsset = cardLine !== null || scene !== null || looksLikeSceneToken(line)}
				{#if ignoreCharacterAssets && isCharacterAsset}
					<!-- '캐릭터 에셋 무시' → 캐릭터 내장 이미지(장면·감정 스프라이트)·토큰 숨김 -->
				{:else if cardLine !== null}
					<!-- imported 카드 editdisplay: 감정 스프라이트 HTML(세정 후 주입). -->
					<div class="chattext" use:cardHtml={cardLine}></div>
				{:else if scene}
					<!-- 장면 이미지 토큰({AAB}/{#id}) → 이미지 블록 -->
					{#if scene.localKey}
						{@const lk = scene.localKey}
						<!-- 로컬(IndexedDB) 이미지: blob URL 로 해석(이 기기에 없으면 숨김) -->
						{#await localSceneURL(lk) then url}
							{#if url}
								<img class="scene-img" src={url} alt={scene.alt} title={scene.alt} loading="lazy" />
							{/if}
						{/await}
					{:else}
						<img class="scene-img" src={scene.url} alt={scene.alt} title={scene.alt} loading="lazy" />
					{/if}
				{:else if looksLikeSceneToken(line)}
					<!-- 알 수 없거나 스트리밍 중 미완성 토큰 → 숨김(원문 노출 방지) -->
				{:else}
					<!-- 산문 줄: 문장 안에 박힌 장면 토큰({#id}/{ABC}/<img>)은 제거(원문 노출 방지).
					     유저 입력은 친 그대로 둔다. -->
					{@const clean = isUser ? line : stripSceneTokens(line)}
					{#if clean}
						{@const sp = parseSpeaker(clean)}
						<span class="line" class:dialogue={!!sp} class:narration={!sp}>
							{#if sp}<b class="speaker">{sp.speaker}</b>{' '}{/if}
							<!-- 유저 입력은 친 그대로(정자체) 두고, 명시한 ( )/*..* 만 기울임.
							     캐릭터 서술은 줄 전체를 소설체(기울임)로. -->
							{#each sp || isUser ? parseInline(sp ? sp.rest : clean) : parseNarration(clean) as seg, j (j)}
								{#if seg.italic}<em>{seg.text}</em>{:else}{seg.text}{/if}
							{/each}
						</span>
					{/if}
				{/if}
			{/if}
		{/each}
	{/snippet}

	<div class="reader" bind:this={scroller} onscroll={onReaderScroll}>
		{#if loadingMore}
			<div class="load-more">이전 대화를 불러오는 중…</div>
		{/if}
		<article class="novel">
			{#each messages as m (m.id)}
				{#if m.content || m.errorReason || m.role === 'image_generation' || (streaming && m === lastMessage)}
					<div class="para {m.role}">
						{#if !(streaming && m === lastMessage) && !m.pending}
							{#if (m.role === 'assistant' || m.role === 'image_generation') && m.cost != null && Number.isFinite(m.cost) && m.cost > 0}
								<span class="msg-cost" title="이 응답 생성 비용(USD)">{formatCost(m.cost)}</span>
							{/if}
							{#if m.role === 'image_generation'}
								<button
									class="msg-regen"
									class:spinning={regenerating === m.id}
									onclick={() => regenerateSceneImage(m)}
									disabled={!!regenerating || streaming || deleting === m.id}
									aria-label="이미지 재생성"
									title="재생성"
								>
									<svg
										viewBox="0 0 24 24"
										width="14"
										height="14"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M21 12a9 9 0 1 1-2.64-6.36" />
										<path d="M21 3v5h-5" />
									</svg>
								</button>
							{/if}
							<button
								class="msg-del"
								onclick={() => deleteMessage(m)}
								disabled={deleting === m.id}
								aria-label="메시지 삭제"
								title="삭제"
							>
								×
							</button>
						{/if}
						{#if m.role === 'image_generation'}
							{#if m.pending && m.previewUrl}
								<!-- 스트리밍 중간 프레임 프리뷰(점점 또렷해짐) + 진행 표시 -->
								<div class="scene-streaming">
									<img class="scene-img" src={m.previewUrl} alt="생성 중" />
									<span class="scene-streaming-tag">
										<span class="typing"><i></i><i></i><i></i></span> 생성 중…
									</span>
								</div>
							{:else if m.pending}
								<div class="scene-loading">
									<span class="typing"><i></i><i></i><i></i></span>
									<span>이미지 생성 중…</span>
								</div>
							{:else if m.content}
								<img
									class="scene-img"
									src={`/img/${m.content}`}
									alt="생성된 장면 이미지"
									loading="lazy"
								/>
							{/if}
						{:else}
							{@render novelBody(m.content, m.role === 'user')}
						{/if}
						{#if m.errorReason}
							<p class="msg-error-reason">사유: {m.errorReason}</p>
						{/if}
						{#if streaming && m.role === 'assistant' && m === lastMessage}
							{#if m.content}<span class="cursor"></span>{:else}<span class="typing"
									><i></i><i></i><i></i></span
								>{/if}
						{/if}
					</div>
				{/if}
			{/each}
		</article>
	</div>

	<div class="composer">
		<div class="composer-inner">
			<textarea
				bind:this={textarea}
				bind:value={input}
				oninput={() => {
					autoGrow();
					if (sendError) sendError = null;
				}}
				onkeydown={onKeydown}
				placeholder={`행동이나 대사를 입력하세요…`}
				maxlength={MAX_USER_MSG_CHARS}
				rows="1"
			></textarea>
			<button class="send" onclick={send} disabled={!input.trim() || streaming} aria-label="전송">
				↑
			</button>
		</div>
		{#if sendError}
			<p class="send-error">{sendError}</p>
		{/if}
		<p class="disclaimer">AI가 생성한 이야기/이미지이며 실제 인물과 무관합니다.</p>
	</div>
</div>
	{#if debug}
		<ChatDebugPanel
			character={data.character}
			{sessionId}
			snapshot={debugSnapshot}
			meta={debugMeta}
			{imageDebug}
			{model}
			{maxSentences}
			{userActs}
			draftText={input}
			{streaming}
		/>
	{/if}
</div>

<style>
	/* 디버그 쉘 — 일반 모드에선 투명 래퍼(.chat 의 중앙정렬 유지), 디버그 모드에선 채팅+패널 분할. */
	.chat-shell.debug {
		display: flex;
		align-items: stretch;
		height: calc(100vh - 60px);
		height: calc(100dvh - 60px);
		max-width: none;
	}
	.chat-shell.debug .chat {
		flex: 1 1 auto;
		min-width: 0;
		max-width: none;
		height: 100%;
		margin: 0;
	}
	@media (max-width: 900px) {
		.chat-shell.debug {
			flex-direction: column;
			height: auto;
		}
	}

	.chat {
		display: flex;
		flex-direction: column;
		/* 모바일 브라우저에서 100vh 는 주소창 숨김 기준(실제보다 큼)이라 body 가 넘쳐 스크롤되고,
		   sticky 가 아닌 캐릭터 헤더가 상단바 뒤로 밀려 사라진다 → 실제 보이는 높이(dvh)로 맞춘다. */
		height: calc(100vh - 60px);
		height: calc(100dvh - 60px);
		max-width: 760px;
		margin: 0 auto;
	}

	.chat-header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	.back {
		font-size: 1.4rem;
		color: var(--text-dim);
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: 8px;
	}
	.back:hover {
		background: var(--bg-card);
		color: var(--text);
	}
	/* 헤더 캐릭터 정보(썸네일+이름+설명) — 클릭 시 상세 모달. 버튼 기본 스타일 리셋. */
	.char-info {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		padding: 4px 8px 4px 4px;
		margin: -4px 0;
		border: none;
		background: transparent;
		border-radius: 10px;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.char-info:hover {
		background: var(--bg-card);
	}
	.avatar-sm {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		overflow: hidden;
		flex-shrink: 0;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		display: grid;
		place-items: center;
		color: #fff;
		font-weight: 700;
	}
	.avatar-sm img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.who {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
		min-width: 0;
	}
	.who .name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.who strong {
		font-size: 0.98rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who .tagline {
		font-size: 0.78rem;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.header-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.settings-btn {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-dim);
		font-size: 1rem;
		display: grid;
		place-items: center;
		transition: all 0.15s ease;
	}
	.settings-btn:hover {
		color: var(--text);
		border-color: var(--text-faint);
	}
	.settings-btn.active {
		color: #fff;
		background: var(--accent);
		border-color: var(--accent);
	}

	/* 설정 모달 */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(2px);
		display: grid;
		place-items: center;
		padding: 20px;
	}
	.modal {
		width: 100%;
		max-width: 380px;
		max-height: calc(100dvh - 40px);
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 18px;
	}
	.modal-head h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 700;
	}
	.modal-close {
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.95rem;
	}
	.modal-close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
	.setting-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.setting-row label,
	.setting-row .field-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text);
	}
	.len-val {
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--accent);
	}
	.modal input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
		cursor: pointer;
	}
	.len-scale {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: var(--text-faint);
		margin-top: 4px;
	}
	.setting + .setting {
		margin-top: 22px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
	}
	.setting-hint {
		margin: 8px 0 0;
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--text-dim);
	}
	.setting-hint strong {
		color: var(--text);
		font-weight: 600;
	}

	/* 상시 기억 글자수 */
	.memory-count {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-faint);
	}

	/* 대화 요약 펼침 토글(꺽쇠) */
	.summary-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
	}
	.summary-toggle .chevron {
		font-size: 1.1rem;
		color: var(--text-dim);
		transition: transform 0.15s ease;
		line-height: 1;
	}
	.summary-toggle .chevron.open {
		transform: rotate(90deg);
	}

	/* 대화 요약 편집 */
	.summary-empty {
		margin: 10px 0 0;
		font-size: 0.78rem;
		color: var(--text-faint);
	}
	.summary-edit {
		width: 100%;
		margin-top: 10px;
		padding: 10px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font: inherit;
		font-size: 0.82rem;
		line-height: 1.5;
		resize: vertical;
		min-height: 90px;
		outline: none;
	}
	.summary-edit:focus {
		border-color: var(--accent);
	}
	.summary-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 8px;
	}
	.summary-note {
		font-size: 0.74rem;
		color: var(--accent);
	}
	.summary-save {
		padding: 7px 16px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-size: 0.82rem;
		font-weight: 600;
	}
	.summary-save:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.summary-save:not(:disabled):hover {
		background: var(--accent-hover);
	}

	/* 모델 드롭다운 */
	.model-select {
		position: relative;
	}
	.model-trigger {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.9rem;
		transition: border-color 0.15s ease;
	}
	.model-trigger:hover,
	.model-trigger.open {
		border-color: var(--accent);
	}
	.model-icon {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		object-fit: cover;
		flex-shrink: 0;
		background: #fff;
	}
	.model-icon.fallback {
		display: grid;
		place-items: center;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		color: #fff;
		font-size: 0.75rem;
		font-weight: 700;
	}
	.model-name {
		flex: 1;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chev {
		color: var(--text-faint);
		font-size: 0.8rem;
	}
	.model-list {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		z-index: 5;
		margin: 0;
		padding: 6px;
		list-style: none;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
	}
	.model-option {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		background: transparent;
		border: none;
		border-radius: 8px;
		color: var(--text);
		font-size: 0.9rem;
	}
	.model-option:hover {
		background: var(--bg-elev);
	}
	.model-option.selected {
		background: var(--accent-soft);
	}
	.check {
		color: var(--accent);
		font-weight: 700;
	}

	/* ── 실시간 이미지 설정 ── */
	.switch {
		position: relative;
		width: 42px;
		height: 24px;
		flex-shrink: 0;
		border-radius: 999px;
		border: none;
		background: var(--bg-elev);
		box-shadow: inset 0 0 0 1px var(--border);
		transition: background 0.15s ease;
		cursor: pointer;
	}
	.switch.on {
		background: var(--accent);
		box-shadow: none;
	}
	.switch:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.switch .knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #fff;
		transition: transform 0.15s ease;
	}
	.switch.on .knob {
		transform: translateX(18px);
	}
	.res-row {
		display: flex;
		gap: 8px;
	}
	.res-btn {
		flex: 1;
		padding: 9px 8px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.85rem;
		font-weight: 600;
		transition: all 0.15s ease;
	}
	.res-btn:hover {
		border-color: var(--text-faint);
	}
	.res-btn.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	.opt {
		color: var(--text-faint);
		font-weight: 400;
	}
	/* 그림체 선택 목록 */
	.hub-mini {
		font-size: 0.74rem;
		font-weight: 700;
		color: var(--accent);
	}
	/* 그림체 드롭다운 */
	.style-select {
		position: relative;
	}
	.style-trigger {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px 6px 6px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		transition: border-color 0.15s ease;
	}
	.style-trigger:hover,
	.style-trigger.open {
		border-color: var(--accent);
	}
	.style-trigger .chev {
		color: var(--text-faint);
		font-size: 0.8rem;
	}
	.style-list {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		z-index: 6;
		margin: 0;
		padding: 6px;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 300px;
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
	}
	.style-group {
		font-size: 0.66rem;
		font-weight: 700;
		color: var(--text-faint);
		letter-spacing: 0.04em;
		margin: 6px 2px 0;
	}
	.style-opt {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 8px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text);
		text-align: left;
	}
	.style-opt:hover {
		background: var(--bg-elev);
	}
	.style-opt.active {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.style-swatch {
		width: 34px;
		height: 34px;
		border-radius: 6px;
		object-fit: cover;
		flex-shrink: 0;
		background: var(--bg-card);
	}
	.style-swatch.default {
		display: grid;
		place-items: center;
		color: var(--accent);
		font-size: 1rem;
	}
	.style-title {
		flex: 1;
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.style-badge {
		flex-shrink: 0;
		font-size: 0.66rem;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
	}
	.img-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 14px;
		padding: 10px 12px;
		font-size: 0.78rem;
		color: var(--text-dim);
		background: color-mix(in srgb, var(--nsfw, #f59e0b) 14%, var(--bg));
		border-radius: var(--radius-sm);
	}
	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		font-size: 0.78rem;
		font-weight: 700;
		text-decoration: underline;
		cursor: pointer;
	}
	/* 생성 중 이미지 플레이스홀더 */
	.scene-loading {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 0.8em 0;
		padding: 18px 16px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		font-family: 'Pretendard', system-ui, sans-serif;
		font-size: 0.82rem;
		color: var(--text-dim);
	}
	/* 스트리밍 프리뷰(중간 프레임) + 진행 태그 */
	.scene-streaming {
		position: relative;
		margin: 0.8em 0;
	}
	.scene-streaming .scene-img {
		margin: 0;
	}
	.scene-streaming-tag {
		position: absolute;
		left: 8px;
		bottom: 8px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(2px);
		color: #fff;
		font-family: 'Pretendard', system-ui, sans-serif;
		font-size: 0.74rem;
	}

	/* ── 소설 리더 ── */
	.reader {
		flex: 1;
		overflow-y: auto;
		padding: 28px 24px 40px;
	}
	.load-more {
		text-align: center;
		font-size: 0.78rem;
		color: var(--text-faint);
		padding: 4px 0 16px;
	}
	.novel {
		/* 소설 읽기에 맞춘 한글 명조(세리프). 로딩 전엔 시스템 명조로 폴백. */
		font-family: 'Noto Serif KR', 'Apple SD Gothic Neo', 'Nanum Myeongjo', serif;
		font-size: 1.08rem;
		line-height: 2;
		color: var(--text);
		letter-spacing: 0.01em;
	}
	/* 삭제 버튼(×)은 본문 세리프를 따라가지 않도록 UI 폰트 유지. */
	.msg-del {
		font-family: 'Pretendard', system-ui, sans-serif;
	}
	.para {
		position: relative;
		margin: 0 0 1.5em;
		word-break: break-word;
	}
	/* 메시지 삭제 버튼 — 평소 숨김, 문단 hover/focus 시 노출(우하단). */
	.msg-del {
		position: absolute;
		bottom: -6px;
		right: -6px;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		color: var(--text-dim);
		font-size: 1.05rem;
		line-height: 1;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			color 0.12s ease,
			border-color 0.12s ease;
		z-index: 2;
	}
	.para:hover .msg-del,
	.msg-del:focus-visible {
		opacity: 1;
	}
	/* 응답 비용(USD) — 삭제 버튼 좌측에 작게. 평소 옅게, 문단 hover 시 또렷하게. */
	.msg-cost {
		position: absolute;
		bottom: -6px;
		right: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		padding: 0 2px;
		font-family: 'Pretendard', system-ui, sans-serif;
		font-size: 0.72rem;
		line-height: 1;
		color: var(--text-dim);
		opacity: 0.45;
		transition: opacity 0.12s ease;
		z-index: 2;
		user-select: none;
		pointer-events: none;
	}
	.para:hover .msg-cost {
		opacity: 0.8;
	}
	.msg-error-reason {
		margin: 0.4rem 0 0;
		padding: 0.4rem 0.6rem;
		border-left: 2px solid var(--danger, #ef4444);
		background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent);
		border-radius: 4px;
		font-family: 'Pretendard', system-ui, sans-serif;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--text-dim);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.msg-del:hover {
		color: var(--danger, #ef4444);
		border-color: var(--danger, #ef4444);
	}
	.msg-del:disabled {
		opacity: 0.4;
		cursor: default;
	}
	/* 터치 기기(hover 없음)에선 항상 옅게 노출해 접근 가능하게. */
	@media (hover: none) {
		.msg-del {
			opacity: 0.55;
		}
	}
	/* 이미지 재생성(🔄) 버튼 — 삭제 버튼 좌측. msg-del 과 동일한 노출 규칙. */
	.msg-regen {
		position: absolute;
		bottom: -6px;
		right: 26px;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		color: var(--text-dim);
		line-height: 1;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			color 0.12s ease,
			border-color 0.12s ease;
		z-index: 2;
	}
	.para:hover .msg-regen,
	.msg-regen:focus-visible {
		opacity: 1;
	}
	.msg-regen:hover {
		color: var(--accent, #8b5cf6);
		border-color: var(--accent, #8b5cf6);
	}
	.msg-regen:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.msg-regen.spinning {
		opacity: 1;
	}
	.msg-regen.spinning svg {
		animation: msg-regen-spin 0.8s linear infinite;
	}
	@keyframes msg-regen-spin {
		to {
			transform: rotate(360deg);
		}
	}
	/* 이미지 메시지는 재생성 버튼이 끼므로 비용 표시를 더 왼쪽으로. */
	.para.image_generation .msg-cost {
		right: 60px;
	}
	@media (hover: none) {
		.msg-regen {
			opacity: 0.55;
		}
	}
	/* 장면 이미지 */
	.scene-img {
		display: block;
		width: 100%;
		height: auto;
		margin: 0.8em 0;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: var(--bg-elev);
	}
	/* imported 카드 editdisplay HTML 컨테이너 — 카드 자체 CSS 가 .chattext 하위로 스코프돼 주입된다.
	   내부 요소는 innerHTML 주입이라 Svelte 스코프가 안 닿음(카드 <style> 가 직접 그림). */
	.chattext {
		margin: 0.8em 0;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.chattext :global(img) {
		max-width: 100%;
		height: auto;
	}
	/* 펜스 블록(```{제목} … ```) — 상태창/정보 카드 */
	.block {
		margin: 1em 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		overflow: hidden;
	}
	.block-title {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 14px;
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--accent);
		background: var(--accent-soft);
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
	}
	/* 제목 앞 점 마커 — '제목'임을 한눈에 */
	.block-title::before {
		content: '';
		flex: 0 0 auto;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
	.block-body {
		padding: 12px 14px;
		font-size: 0.92rem;
		line-height: 1.7;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		font-style: normal;
		font-variant-numeric: tabular-nums;
	}
	/* 줄 단위(대사/지시문) */
	.line {
		display: block;
	}
	.line + .line {
		margin-top: 0.45em;
	}
	/* 캐릭터(서술) 턴 */
	.para.assistant {
		color: #e7e7ef;
	}
	/* 사용자(나) 턴 — 블록 없이 색으로만 옅게 구분 */
	.para.user {
		color: #9fb2ff;
	}
	/* 괄호/별표 안 지시문·해설 → 기울임 */
	.para em {
		font-style: italic;
		color: var(--text-dim);
	}
	.para.user em {
		color: #7e8fd6;
	}
	/* 대사 발화자 라벨: "발화자 | 대사" */
	.speaker {
		font-weight: 700;
		color: var(--accent);
	}
	.para.user .speaker {
		color: #9fb2ff;
	}

	.cursor {
		display: inline-block;
		width: 8px;
		height: 1.1em;
		margin-left: 1px;
		background: var(--accent);
		vertical-align: text-bottom;
		animation: blink 1s steps(2) infinite;
	}
	@keyframes blink {
		0%,
		50% {
			opacity: 1;
		}
		50.01%,
		100% {
			opacity: 0;
		}
	}
	.typing {
		display: inline-flex;
		gap: 5px;
		vertical-align: middle;
	}
	.typing i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
		animation: bounce 1.2s infinite ease-in-out;
	}
	.typing i:nth-child(2) {
		animation-delay: 0.15s;
	}
	.typing i:nth-child(3) {
		animation-delay: 0.3s;
	}
	@keyframes bounce {
		0%,
		60%,
		100% {
			transform: translateY(0);
			opacity: 0.5;
		}
		30% {
			transform: translateY(-5px);
			opacity: 1;
		}
	}

	.composer {
		padding: 12px 16px 16px;
		border-top: 1px solid var(--border);
		background: var(--bg);
	}
	.composer-inner {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 24px;
		padding: 6px 6px 6px 16px;
		transition: border-color 0.15s ease;
	}
	.composer-inner:focus-within {
		border-color: var(--accent);
	}
	textarea {
		flex: 1;
		/* flex 자식 기본 min-width:auto 라 iOS 등에서 textarea 고유 폭만큼 안 줄어들어
		   composer 가 화면 밖으로 삐져나간다 → min-width:0 으로 줄어들게 함 */
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		resize: none;
		color: var(--text);
		font-size: 0.95rem;
		line-height: 1.5;
		padding: 8px 0;
		max-height: 160px;
	}
	textarea::placeholder {
		color: var(--text-faint);
	}
	.send {
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border: none;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		font-size: 1.2rem;
		font-weight: 700;
		display: grid;
		place-items: center;
		transition:
			background 0.15s ease,
			opacity 0.15s ease;
	}
	.send:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.send:not(:disabled):hover {
		background: var(--accent-hover);
	}
	.disclaimer {
		text-align: center;
		font-size: 0.72rem;
		color: var(--text-faint);
		margin: 8px 0 0;
	}
	.send-error {
		text-align: center;
		font-size: 0.78rem;
		color: var(--danger, #ef4444);
		margin: 8px 0 0;
	}
	.local-warn {
		flex-shrink: 0;
		padding: 8px 14px;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--text-dim);
		background: color-mix(in srgb, var(--nsfw, #f59e0b) 14%, var(--bg));
		border-bottom: 1px solid var(--border);
	}
	.local-warn strong {
		color: var(--text);
	}
</style>
