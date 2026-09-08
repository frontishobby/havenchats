<script lang="ts">
	import { scrollLock } from '$lib/scrollLock';
	import { untrack, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import PromptGuideModal from '$lib/components/PromptGuideModal.svelte';
	import TextReplaceModal from '$lib/components/TextReplaceModal.svelte';
	import CharacterImagesModal, {
		type SceneAxisDraft,
		type SceneEntryDraft,
		type SceneApply
	} from '$lib/components/CharacterImagesModal.svelte';
	import NamedImagesModal, {
		type NamedDraft,
		type NamedApply
	} from '$lib/components/NamedImagesModal.svelte';
	import CharacterLorebookModal from '$lib/components/CharacterLorebookModal.svelte';
	import CharacterAssistPanel, {
		type AssistCharacter
	} from '$lib/components/CharacterAssistPanel.svelte';
	import CharacterThumbnailPanel from '$lib/components/CharacterThumbnailPanel.svelte';
	import { blobToBase64, blobToWebp } from '$lib/imagePreview';
	import { isGrid, isNamed, namedUrl } from '$lib/imageCodes';
	import { estimatePromptTokens } from '$lib/tokens';
	import type {
		ArtStyle,
		Audience,
		CharacterImageSet,
		CharacterLorebook,
		ContentRating,
		LoreEntry,
		Opening,
		Visibility
	} from '$lib/types';
	import { getNaiModel } from '$lib/naiModels';

	export interface CharacterFormInitial {
		name: string;
		tagline: string;
		intro: string;
		description: string;
		audience: Audience;
		contentRating: ContentRating;
		visibility: Visibility;
		tags: string[];
		greetings: Opening[];
		/** 기존 썸네일 URL (수정 시 미리보기용). */
		avatarUrl: string;
		/** 기존 장면 이미지 세트(수정 시). */
		imageSet?: CharacterImageSet | null;
		/** 기존 로어북(수정 시). */
		lorebook?: CharacterLorebook | null;
		/** 기존 스크립트 기본 변수(관리자 import 편집 시). */
		defaultVariables?: Record<string, string> | null;
		/** 기존 추천 그림체 id(수정 시). */
		recommendedStyleId?: string | null;
	}

	let {
		mode,
		characterId,
		initial,
		returnTo = '/',
		returnLabel = '탐색으로',
		allowScriptVars = false
	}: {
		mode: 'create' | 'edit';
		characterId?: string;
		initial?: CharacterFormInitial;
		/** 뒤로/저장 후 이동 대상. 수정 모드에선 보통 제작자 프로필 페이지. */
		returnTo?: string;
		/** 뒤로 가기 링크 라벨. */
		returnLabel?: string;
		/** 스크립트 기본 변수 편집 노출 여부(관리자 import 편집 전용). */
		allowScriptVars?: boolean;
	} = $props();

	const NAME_MAX = 30;
	const TAGLINE_MAX = 100;
	const INTRO_MAX = 3000;
	// 프롬프트 제한은 글자가 아니라 **추정 토큰** 기준 — 영어처럼 토큰 효율이 높은 언어가
	// 글자 수로 불이익을 안 받게. (한국어 ≈16000자, 영어 ≈32000자). charx import 한
	// 대형 카드(설정+로어북 합쳐 5000~7000토큰)도 편집 가능하도록 넉넉히.
	const DESC_TOKEN_MAX = 8000;
	const DESC_CHAR_CEIL = 32000; // 입력 폭주 방지용 하드 상한(검증은 토큰 기준).
	const TAGS_MAX = 5;
	const GREETING_MAX = 4000;
	const GREETING_NAME_MAX = 30;
	const GREETINGS_MAX = 5;
	const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
	const ACCEPT = ['image/webp', 'image/avif'];

	// 폼 필드는 마운트 시 initial 을 한 번만 캡처한다(이후 prop 변경엔 반응 안 함 — 의도).
	// 매 필드마다 svelte-ignore 를 다는 대신 스냅샷 한 번으로 묶는다.
	const init = untrack(() => initial);

	let name = $state(init?.name ?? '');
	let tagline = $state(init?.tagline ?? '');
	let intro = $state(init?.intro ?? '');
	let description = $state(init?.description ?? '');
	const descTokens = $derived(estimatePromptTokens(description));
	let audience = $state<Audience>(init?.audience ?? 'all');
	let nsfw = $state(init?.contentRating === 'nsfw');

	// 추천 그림체 — 내가 만들거나 즐겨찾기한 그림체 중 택1(선택). 채팅 이미지 모달에 '추천'으로 노출.
	let recommendedStyleId = $state(init?.recommendedStyleId ?? '');
	let myStyles = $state<ArtStyle[]>([]);
	onMount(async () => {
		try {
			const res = await fetch('/api/styles/mine');
			if (res.ok) myStyles = ((await res.json()) as { styles: ArtStyle[] }).styles ?? [];
		} catch {
			/* 무시 */
		}
	});

	// 첫 상황(오프닝) — 첫 항목이 기본(필수). 각 항목은 이름(선택용)과 본문을 가진다.
	let greetings = $state<Opening[]>(
		init?.greetings?.length
			? init.greetings.map((g) => ({ name: g.name, content: g.content }))
			: [{ name: '', content: '' }]
	);

	let tagInput = $state('');
	let tags = $state<string[]>(init?.tags ? [...init.tags] : []);

	let imageFile = $state<File | null>(null);
	/** AI 썸네일 패널이 준 NovelAI 원본(PNG 1024²). 저장 시 2048² 로 업스케일해 상세용 이미지로 보낸다. 수동 업로드면 null. */
	let upscaleSource = $state<Blob | null>(null);
	let upscaling = $state(false);
	let imagePreview = $state<string | null>(null);
	let dragOver = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	let submitting = $state(false);
	let error = $state('');
	let guideOpen = $state(false);
	let replaceOpen = $state(false);

	// ── 장면 이미지 세트 (모달에서 편집, 제출 시 함께 전송) ──
	// 방식: grid(축×조합) 또는 named(이름별 플랫). initial 의 kind 로 시작값 결정.
	let imageMode = $state<'grid' | 'named'>(isNamed(init?.imageSet) ? 'named' : 'grid');
	let imagesOpen = $state(false);
	let namedOpen = $state(false);

	const initialGrid = isGrid(init?.imageSet) ? init.imageSet : null;
	let sceneAxes = $state<SceneAxisDraft[]>(
		initialGrid?.axes.map((a) => ({ label: a.label, values: [...a.values] })) ?? []
	);
	let sceneEntries = $state<SceneEntryDraft[]>(
		initialGrid?.entries.map((e) => ({
			id: e.id,
			combo: [...e.combo],
			file: null,
			ext: e.ext
		})) ?? []
	);
	const sceneCount = $derived(sceneEntries.length);

	// 플랫 네임드 드래프트(initial 이 named 면 기존 이미지로 시작).
	const initialNamed = isNamed(init?.imageSet) ? init.imageSet : null;
	let namedImages = $state<NamedDraft[]>(
		initialNamed?.images.map((img) => ({
			id: img.id,
			name: img.name,
			file: null,
			ext: img.ext,
			url: namedUrl(characterId ?? '', img),
			previewUrl: null
		})) ?? []
	);
	const namedCount = $derived(namedImages.length);

	// ── 로어북 (모달에서 편집, 제출 시 JSON 으로 전송) ──
	let loreEntries = $state<LoreEntry[]>(
		init?.lorebook?.entries.map((e) => ({
			id: e.id,
			keys: [...e.keys],
			content: e.content,
			constant: e.constant,
			order: e.order
		})) ?? []
	);
	const loreCount = $derived(loreEntries.length);
	let loreOpen = $state(false);

	function applyLore(entries: LoreEntry[]) {
		loreEntries = entries;
		loreOpen = false;
	}

	// ── 스크립트 기본 변수 (관리자 import 편집 전용) ──
	// import 캐릭터의 defaultVariables 를 키=값 행으로 노출/편집. 세션 시작 시 변수 시딩에 쓰인다.
	let scriptVars = $state<{ key: string; value: string }[]>(
		init?.defaultVariables
			? Object.entries(init.defaultVariables).map(([key, value]) => ({ key, value }))
			: []
	);
	function addScriptVar() {
		scriptVars = [...scriptVars, { key: '', value: '' }];
	}
	function removeScriptVar(i: number) {
		scriptVars = scriptVars.filter((_, idx) => idx !== i);
	}

	// 방식 전환. 떠나는 쪽에 등록된 이미지가 있으면 경고 — 저장 시엔 활성 방식 하나만
	// 영속화되고 반대쪽 이미지는 R2 에서 정리되기 때문(둘은 공존 불가).
	function switchMode(target: 'grid' | 'named') {
		if (target === imageMode) return;
		const leavingCount = imageMode === 'grid' ? sceneCount : namedCount;
		if (leavingCount > 0) {
			const fromLabel = imageMode === 'grid' ? '그리드' : '플랫';
			const ok = confirm(
				`${fromLabel} 방식에 등록한 이미지 ${leavingCount}개는 다른 방식으로 저장하면 삭제됩니다.\n` +
					`한 캐릭터는 한 가지 방식만 쓸 수 있어요. 전환할까요?`
			);
			if (!ok) return;
		}
		imageMode = target;
	}

	function applyScenes(res: SceneApply) {
		sceneAxes = res.axes;
		sceneEntries = res.entries;
		imagesOpen = false;
	}

	function applyNamed(res: NamedApply) {
		namedImages = res.images;
		namedOpen = false;
	}

	// 새로 고른 이미지가 있으면 그것, 없으면 기존(수정) 썸네일.
	const displayImage = $derived(imagePreview ?? initial?.avatarUrl ?? null);
	const isEdit = untrack(() => mode) === 'edit';

	const AUDIENCES: { value: Audience; label: string; hint: string }[] = [
		{ value: 'all', label: '공통', hint: '모두에게' },
		{ value: 'male', label: '남성향', hint: '여성 캐릭터 위주' },
		{ value: 'female', label: '여성향', hint: '남성 캐릭터 위주' }
	];

	const canSubmit = $derived(
		!submitting &&
			name.trim().length > 0 &&
			name.length <= NAME_MAX &&
			tagline.trim().length > 0 &&
			tagline.length <= TAGLINE_MAX &&
			intro.length <= INTRO_MAX &&
			description.trim().length > 0 &&
			descTokens <= DESC_TOKEN_MAX &&
			greetings.length > 0 &&
			greetings.every(
				(g) =>
					g.name.trim().length > 0 &&
					g.content.trim().length > 0 &&
					g.content.length <= GREETING_MAX
			) &&
			// 생성 시 이미지 필수, 수정 시 기존 유지 가능.
			(isEdit ? !!displayImage : !!imageFile)
	);

	function addGreeting() {
		if (greetings.length < GREETINGS_MAX) greetings = [...greetings, { name: '', content: '' }];
	}
	function removeGreeting(i: number) {
		greetings = greetings.filter((_, idx) => idx !== i);
	}

	function setImage(file: File | undefined | null) {
		error = '';
		if (!file) return;
		if (!ACCEPT.includes(file.type)) {
			error = '썸네일은 webp 또는 avif 이미지만 가능합니다.';
			return;
		}
		if (file.size > IMAGE_MAX_BYTES) {
			error = '이미지 용량이 너무 큽니다 (최대 3MB).';
			return;
		}
		if (imagePreview) URL.revokeObjectURL(imagePreview);
		imageFile = file;
		imagePreview = URL.createObjectURL(file);
		upscaleSource = null;
	}

	function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		setImage(input.files?.[0]);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		setImage(e.dataTransfer?.files?.[0]);
	}

	function removeImage() {
		if (imagePreview) URL.revokeObjectURL(imagePreview);
		imageFile = null;
		imagePreview = null;
		upscaleSource = null;
		if (fileInput) fileInput.value = '';
	}

	/**
	 * 저장 직전: AI 생성 썸네일이면 NovelAI 2x 업스케일(2048²) → webp → 상세용 이미지.
	 * 실패하면 에러를 던져 저장을 막는다(다시 저장하면 재시도).
	 */
	async function buildFullImage(): Promise<File | null> {
		if (!upscaleSource) return null;
		upscaling = true;
		try {
			const bmp = await createImageBitmap(upscaleSource);
			const w = bmp.width;
			const h = bmp.height;
			bmp.close?.();
			const res = await fetch('/api/characters/thumbnail/upscale', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ image: await blobToBase64(upscaleSource), width: w, height: h })
			});
			if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
				const d = (await res.json().catch(() => ({}))) as { message?: string };
				throw new Error(d.message ?? '고해상도 업스케일에 실패했어요. 다시 저장해 주세요.');
			}
			const webp = await blobToWebp(await res.blob());
			return new File([webp], 'full.webp', { type: 'image/webp' });
		} finally {
			upscaling = false;
		}
	}

	function addTag() {
		const raw = tagInput.trim().replace(/^#/, '');
		tagInput = '';
		if (!raw) return;
		if (tags.length >= TAGS_MAX) return;
		if (tags.includes(raw)) return;
		tags = [...tags, raw];
	}

	function onTagKey(e: KeyboardEvent) {
		if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
			e.preventDefault();
			addTag();
		} else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
			tags = tags.slice(0, -1);
		}
	}

	function removeTag(t: string) {
		tags = tags.filter((x) => x !== t);
	}

	// 현재 폼 내용 스냅샷 — AI 보조 패널에 넘겨, 채워진 게 있으면 보존하며 수정하도록 한다.
	const currentDraft = $derived<AssistCharacter>({
		name,
		tagline,
		intro,
		description,
		tags,
		greetings,
		audience,
		nsfw
	});

	// 모바일(<1080px) AI 도우미 바텀시트 — PC 에선 같은 패널이 우측 sticky 열로 항상 보인다(인스턴스 1개).
	const WIDE_QUERY = '(min-width: 1080px)';
	let assistSheetOpen = $state(false);
	let assistTab = $state<'assist' | 'thumb'>('assist');
	function isNarrow(): boolean {
		return typeof window !== 'undefined' && !window.matchMedia(WIDE_QUERY).matches;
	}
	function closeAssistSheet() {
		if (isNarrow()) assistSheetOpen = false;
	}
	// PC 폭으로 넓어지면(=sticky 열로 전환) 시트 상태 해제. 바디 스크롤 잠금은 시트 백드롭의 use:scrollLock.
	$effect(() => {
		if (!assistSheetOpen) return;
		const mq = window.matchMedia(WIDE_QUERY);
		const onChange = () => {
			if (mq.matches) assistSheetOpen = false;
		};
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	// AI 보조 패널 결과로 폼 필드를 채운다(create 모드 전용). 이미지·로어북 등은 건드리지 않는다.
	function applyAssist(c: AssistCharacter) {
		name = c.name.slice(0, NAME_MAX);
		tagline = c.tagline.slice(0, TAGLINE_MAX);
		intro = c.intro.slice(0, INTRO_MAX);
		description = c.description;
		tags = c.tags.slice(0, TAGS_MAX);
		audience = c.audience;
		nsfw = c.nsfw;
		const gs = c.greetings
			.map((g) => ({ name: g.name.trim(), content: g.content.trim() }))
			.filter((g) => g.content)
			.slice(0, GREETINGS_MAX);
		greetings = gs.length ? gs : [{ name: '', content: '' }];
		// 사용자가 채워진 폼을 바로 확인할 수 있게 (모바일이면 시트를 닫고) 맨 위로.
		closeAssistSheet();
		if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	async function submit() {
		if (!canSubmit) return;
		// 수정 모드에선 새 이미지가 없어도(기존 유지) 진행.
		if (!isEdit && !imageFile) return;
		submitting = true;
		error = '';
		try {
			const fd = new FormData();
			fd.set('name', name.trim());
			fd.set('tagline', tagline.trim());
			fd.set('intro', intro.trim());
			fd.set('description', description.trim());
			fd.set('audience', audience);
			fd.set('contentRating', nsfw ? 'nsfw' : 'sfw');
			fd.set('visibility', 'public');
			fd.set('recommendedStyleId', recommendedStyleId);
			fd.set('tags', JSON.stringify(tags));
			fd.set(
				'greetings',
				JSON.stringify(
					greetings
						.map((g) => ({ name: g.name.trim(), content: g.content.trim() }))
						.filter((g) => g.content)
				)
			);
			if (imageFile) fd.set('image', imageFile);
			if (imageFile && upscaleSource) {
				const full = await buildFullImage();
				if (full) fd.set('imageFull', full);
			}

			// 로어북(키워드 동적 설정) 전달.
			fd.set('lorebook', JSON.stringify(loreEntries));

			// 스크립트 기본 변수(관리자 import 편집 전용). 필드 존재 자체가 "변수 갱신" 신호 —
			// 빈 객체여도 전송해 모두 삭제를 반영할 수 있게 한다.
			if (allowScriptVars) {
				const dv: Record<string, string> = {};
				for (const { key, value } of scriptVars) {
					const k = key.trim().toLowerCase();
					if (k) dv[k] = value;
				}
				fd.set('scriptData', JSON.stringify({ defaultVariables: dv }));
			}

			// 장면 이미지 방식(grid|named) 전달.
			fd.set('imageMode', imageMode);

			if (imageMode === 'named') {
				// 플랫: namedImages JSON + 새/교체 이미지는 namedImage:<id> 파일로.
				if (namedImages.length > 0) {
					const namedJson = namedImages.map((n) => ({
						id: n.id,
						name: n.name,
						...(n.file ? {} : n.ext ? { ext: n.ext } : {})
					}));
					fd.set('namedImages', JSON.stringify(namedJson));
					for (const n of namedImages) {
						if (n.file) fd.set(`namedImage:${n.id}`, n.file);
					}
				}
			} else if (sceneAxes.length > 0) {
				// 그리드: 메타는 JSON, 새/교체 이미지는 imageEntry:<id> 파일로.
				const imageSetJson = {
					axes: sceneAxes.map((a) => ({ label: a.label, values: a.values })),
					entries: sceneEntries.map((e) => ({
						id: e.id,
						combo: e.combo,
						// 새 파일이 있으면 ext 는 서버가 파일에서 도출. 유지면 기존 ext 전달.
						...(e.file ? {} : e.ext ? { ext: e.ext } : {})
					}))
				};
				fd.set('imageSet', JSON.stringify(imageSetJson));
				for (const e of sceneEntries) {
					if (e.file) fd.set(`imageEntry:${e.id}`, e.file);
				}
			}

			const url = isEdit ? `/api/characters/${characterId}` : '/api/characters';
			const res = await fetch(url, { method: isEdit ? 'PUT' : 'POST', body: fd });
			const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
			if (!res.ok || !data.id) {
				throw new Error(data.error ?? '저장에 실패했어요.');
			}
			// 생성 → 바로 대화, 수정 → 제작자 프로필로.
			await goto(isEdit ? returnTo : `/chat/${data.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : '저장에 실패했어요.';
			submitting = false;
		}
	}
</script>

<div class="create-layout">
<div class="create">
	<a class="back" href={isEdit ? returnTo : '/'}>← {isEdit ? returnLabel : '탐색으로'}</a>

	<header class="head">
		<span class="logo">✦</span>
		<h1>{isEdit ? '캐릭터 수정' : '캐릭터 만들기'}</h1>
		<p class="sub">
			역할·말투·세계관·출력 형식까지 <strong>프롬프트(설정)에 자유롭게</strong> 적을 수 있어요.
		</p>
	</header>

	<!-- 썸네일 -->
	<div class="field">
		<div class="label-row">
			<span class="field-label">썸네일 <span class="req">*</span></span>
			<span class="hint">webp · avif (최대 3MB)</span>
		</div>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			class="dropzone"
			class:over={dragOver}
			class:has-image={!!displayImage}
			role="button"
			tabindex="0"
			onclick={() => fileInput?.click()}
			onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput?.click()}
			ondragover={(e) => {
				e.preventDefault();
				dragOver = true;
			}}
			ondragleave={() => (dragOver = false)}
			ondrop={onDrop}
		>
			{#if displayImage}
				<img class="preview" src={displayImage} alt="썸네일 미리보기" />
				{#if imagePreview}
					<button
						type="button"
						class="remove-img"
						onclick={(e) => {
							e.stopPropagation();
							removeImage();
						}}
						aria-label="이미지 제거">✕</button
					>
				{/if}
			{:else}
				<div class="dropzone-empty">
					<span class="dz-icon">🖼️</span>
					<span class="dz-text">클릭 또는 드래그하여 이미지 추가</span>
				</div>
			{/if}
		</div>
		{#if isEdit}
			<p class="field-hint">이미지를 바꾸려면 새로 선택하세요. 그대로 두면 기존 썸네일이 유지돼요.</p>
		{/if}
		<input
			bind:this={fileInput}
			type="file"
			accept="image/webp,image/avif"
			class="hidden-input"
			onchange={onFileChange}
		/>
	</div>

	<!-- 장면 이미지 -->
	<div class="field">
		<div class="label-row">
			<span class="field-label">장면 이미지 <span class="opt">(선택)</span></span>
			<div class="mode-toggle" role="tablist">
				<button
					type="button"
					class:active={imageMode === 'grid'}
					onclick={() => switchMode('grid')}>그리드</button
				>
				<button
					type="button"
					class:active={imageMode === 'named'}
					onclick={() => switchMode('named')}>플랫</button
				>
			</div>
		</div>

		{#if imageMode === 'grid'}
			<button type="button" class="manage-images" onclick={() => (imagesOpen = true)}>
				<span class="mi-icon">🎬</span>
				<span class="mi-text">
					<strong>이미지 관리</strong>
					<span
						>{sceneCount > 0
							? `조합 ${sceneCount}개 등록됨`
							: '상황별 이미지를 등록하면 대화 중 자동으로 노출돼요'}</span
					>
				</span>
				<span class="mi-chev">›</span>
			</button>
			<p class="field-hint">
				축(예: 캐릭터·의상·표정)과 조합을 만들어 이미지를 등록하면, AI가 장면에 맞는 코드를 출력해 그
				이미지를 보여줍니다.
			</p>
		{:else}
			<button type="button" class="manage-images" onclick={() => (namedOpen = true)}>
				<span class="mi-icon">🖼️</span>
				<span class="mi-text">
					<strong>이미지 관리</strong>
					<span
						>{namedCount > 0
							? `이미지 ${namedCount}장 등록됨`
							: '이름별 이미지를 등록하면 AI가 <img="이름">로 노출해요'}</span
					>
				</span>
				<span class="mi-chev">›</span>
			</button>
			<p class="field-hint">
				이미지마다 이름(토큰)을 붙이는 방식이에요. 불규칙·대량 이미지에 적합합니다.
			</p>
		{/if}
	</div>

	<!-- 로어북 -->
	<div class="field">
		<div class="label-row">
			<span class="field-label">로어북 <span class="opt">(선택)</span></span>
		</div>
		<button type="button" class="manage-images" onclick={() => (loreOpen = true)}>
			<span class="mi-icon">📖</span>
			<span class="mi-text">
				<strong>로어북 관리</strong>
				<span
					>{loreCount > 0
						? `설정 ${loreCount}개 등록됨`
						: '키워드가 대화에 나오면 관련 설정을 자동으로 반영해요'}</span
				>
			</span>
			<span class="mi-chev">›</span>
		</button>
		<p class="field-hint">
			키워드별 설정을 등록하면, 그 키워드가 최근 대화에 등장할 때만 해당 설정이 프롬프트에 주입돼요.
			항상 반영할 항목은 “항상 켜기”로 둘 수 있어요.
		</p>
	</div>

	<!-- 추천 그림체 -->
	<div class="field">
		<div class="label-row">
			<span class="field-label" id="rec-style-label">추천 그림체 <span class="opt">(선택)</span></span>
			<a class="opt-link" href="/styles" target="_blank" rel="noreferrer">그림체 →</a>
		</div>
		<select class="rec-select" aria-labelledby="rec-style-label" bind:value={recommendedStyleId}>
			<option value="">지정 안 함</option>
			{#each myStyles as st (st.id)}
				<option value={st.id}>[{getNaiModel(st.model).short}] {st.title}{st.creatorName ? ` · ${st.creatorName}` : ''}</option>
			{/each}
		</select>
		<p class="field-hint">
			저장한 그림체를 지정하면, 이 캐릭터로 채팅할 때 이미지 설정에 <strong>제작자
			추천</strong>으로 노출돼요.
		</p>
	</div>

	<!-- 스크립트 기본 변수 (관리자 import 편집 전용) -->
	{#if allowScriptVars}
		<div class="field">
			<div class="label-row">
				<span class="field-label">스크립트 변수 <span class="opt">(가져온 캐릭터)</span></span>
				<span class="count">{scriptVars.length}개</span>
			</div>
			<p class="field-hint top">
				가져온 캐릭터의 기본 변수예요. 새 대화를 시작할 때 변수 초기값으로 시딩돼요. 키는 소문자로 저장돼요.
			</p>
			<div class="scriptvars">
				{#each scriptVars as _, i (i)}
					<div class="scriptvar-row">
						<input
							class="sv-key"
							type="text"
							placeholder="변수명"
							bind:value={scriptVars[i].key}
						/>
						<input
							class="sv-val"
							type="text"
							placeholder="기본값"
							bind:value={scriptVars[i].value}
						/>
						<button
							type="button"
							class="sv-del"
							onclick={() => removeScriptVar(i)}
							aria-label="변수 삭제">✕</button
						>
					</div>
				{/each}
			</div>
			<button type="button" class="add-greeting" onclick={addScriptVar}>+ 변수 추가</button>
		</div>
	{/if}

	<!-- 제목 -->
	<div class="field">
		<div class="label-row">
			<label class="field-label" for="c-name">제목 <span class="req">*</span></label>
			<span class="count" class:over={name.length > NAME_MAX}>{name.length}/{NAME_MAX}</span>
		</div>
		<input id="c-name" type="text" placeholder="캐릭터 이름" maxlength={NAME_MAX} bind:value={name} />
	</div>

	<!-- 소개 -->
	<div class="field">
		<div class="label-row">
			<label class="field-label" for="c-tagline">소개 <span class="req">*</span></label>
			<span class="count" class:over={tagline.length > TAGLINE_MAX}
				>{tagline.length}/{TAGLINE_MAX}</span
			>
		</div>
		<input
			id="c-tagline"
			type="text"
			placeholder="카드에 보일 한 줄 소개"
			maxlength={TAGLINE_MAX}
			bind:value={tagline}
		/>
	</div>

	<!-- 설명 (모달 표시 전용) -->
	<div class="field">
		<div class="label-row">
			<label class="field-label" for="c-intro">설명 <span class="opt">(선택)</span></label>
			<span class="count" class:over={intro.length > INTRO_MAX}>{intro.length}/{INTRO_MAX}</span>
		</div>
		<textarea
			id="c-intro"
			rows="7"
			placeholder="캐릭터를 눌렀을 때 보이는 소개글이에요. 세계관·관계·분위기 등을 자유롭게 적어주세요."
			maxlength={INTRO_MAX}
			bind:value={intro}
		></textarea>
		<p class="field-hint">표시 전용이라 프롬프트(설정)에는 반영되지 않아요.</p>
	</div>

	<!-- 프롬프트 -->
	<div class="field">
		<div class="label-row">
			<span class="label-with-info">
				<label class="field-label" for="c-desc">프롬프트 <span class="req">*</span></label>
				<button
					type="button"
					class="info-btn"
					onclick={() => (guideOpen = true)}
					aria-label="프롬프트 작성 가이드 열기"
					title="작성 가이드">ⓘ</button
				>
				<button
					type="button"
					class="info-btn"
					onclick={() => (replaceOpen = true)}
					aria-label="텍스트 대치 도구 열기"
					title="텍스트 대치"
				>
					<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
						<path
							fill="currentColor"
							d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
						/>
					</svg>
				</button>
			</span>
			<span class="count" class:over={descTokens > DESC_TOKEN_MAX}
				>~{descTokens}/{DESC_TOKEN_MAX} 토큰</span
			>
		</div>
		<textarea
			id="c-desc"
			rows="10"
			placeholder={'캐릭터의 역할·성격·말투·세계관, 그리고 출력 형식을 자유롭게 작성하세요.\n\n예) 너는 "OOO"라는 가상의 캐릭터를 연기한다. ...\n[출력 형식] 소설 형식으로 서술한다. 대사는 \'이름 | "대사"\' 형식으로 쓴다. ...'}
			maxlength={DESC_CHAR_CEIL}
			bind:value={description}
		></textarea>
		<p class="field-hint">
			이 내용이 곧 시스템 프롬프트가 됩니다. 상대(사용자) 정보와 안전 가드레일은 자동으로 덧붙어요.
		</p>
	</div>

	<!-- 첫 상황(오프닝) -->
	<div class="field">
		<div class="label-row">
			<span class="field-label">첫 상황 <span class="req">*</span></span>
			<span class="hint">채팅 시작 시 첫 메시지</span>
		</div>
		<p class="field-hint top">
			기본 상황 1개는 필수예요. 여러 개 추가하면 채팅 시작 전 <strong>이름으로 골라</strong> 시작할 수
			있어요.
		</p>
		<div class="greetings">
			{#each greetings as _, i (i)}
				<div class="greeting-item">
					<div class="greeting-head">
						<input
							class="greeting-name"
							type="text"
							placeholder={i === 0 ? '상황 이름 (예: 기본 상황)' : `상황 이름 (예: 상황 ${i + 1})`}
							maxlength={GREETING_NAME_MAX}
							bind:value={greetings[i].name}
						/>
						<span class="greeting-right">
							<span class="count" class:over={greetings[i].content.length > GREETING_MAX}
								>{greetings[i].content.length}/{GREETING_MAX}</span
							>
							{#if greetings.length > 1}
								<button
									type="button"
									class="greeting-del"
									onclick={() => removeGreeting(i)}
									aria-label="상황 삭제">✕</button
								>
							{/if}
						</span>
					</div>
					<textarea
						rows="4"
						placeholder={i === 0
							? '캐릭터가 건네는 첫 장면·대사를 작성하세요. (프롬프트의 출력 형식과 동일하게)'
							: '다른 시작 상황'}
						maxlength={GREETING_MAX}
						bind:value={greetings[i].content}
					></textarea>
				</div>
			{/each}
		</div>
		{#if greetings.length < GREETINGS_MAX}
			<button type="button" class="add-greeting" onclick={addGreeting}>+ 상황 추가</button>
		{/if}
	</div>

	<!-- 타깃 -->
	<div class="field">
		<span class="field-label">타깃</span>
		<div class="seg">
			{#each AUDIENCES as a (a.value)}
				<button
					type="button"
					class="seg-btn"
					class:active={audience === a.value}
					onclick={() => (audience = a.value)}
				>
					<strong>{a.label}</strong>
					<span>{a.hint}</span>
				</button>
			{/each}
		</div>
	</div>


	<!-- 연령제한 -->
	<div class="field">
		<button
			type="button"
			class="toggle-row"
			class:active={nsfw}
			onclick={() => (nsfw = !nsfw)}
			aria-pressed={nsfw}
		>
			<span class="toggle-left">
				<NsfwBadge size={18} />
				<span class="toggle-text">
					<strong>연령제한 (NSFW)</strong>
					<span>성인용 콘텐츠 — 비로그인 사용자에게 숨겨집니다.</span>
				</span>
			</span>
			<span class="switch" class:on={nsfw}><span class="knob"></span></span>
		</button>
	</div>

	<!-- 해시태그 -->
	<div class="field">
		<div class="label-row">
			<span class="field-label">해시태그</span>
			<span class="count">{tags.length}/{TAGS_MAX}</span>
		</div>
		<div class="tag-edit" class:full={tags.length >= TAGS_MAX}>
			{#each tags as t (t)}
				<span class="chip">
					#{t}
					<button type="button" class="chip-x" onclick={() => removeTag(t)} aria-label="태그 제거"
						>✕</button
					>
				</span>
			{/each}
			{#if tags.length < TAGS_MAX}
				<input
					class="tag-input"
					type="text"
					placeholder={tags.length === 0 ? '태그 입력 후 Enter' : ''}
					bind:value={tagInput}
					onkeydown={onTagKey}
					onblur={addTag}
				/>
			{/if}
		</div>
	</div>

	{#if error}<p class="error">{error}</p>{/if}

	<button class="submit" onclick={submit} disabled={!canSubmit}>
		{#if submitting}
			{upscaling ? '고해상도 업스케일 중…' : '저장 중…'}
		{:else}
			{isEdit ? '변경 사항 저장' : '캐릭터 등록'}
		{/if}
	</button>
</div>

	<!--
		AI 도우미 — 생성·수정 양쪽에서 노출(수정 모드에선 기존 내용 보존·수정).
		PC(≥1080px)는 우측 sticky 열, 모바일은 우하단 ✦ 버튼으로 여는 바텀시트(탭: 캐릭터 생성 / 썸네일).
		같은 DOM 인스턴스를 CSS 로만 다르게 배치해 입력·미리보기 상태가 폭 전환에도 유지된다.
	-->
	<div class="assist-col" class:open={assistSheetOpen} aria-label="AI 도우미">
		<div class="sheet-head">
			<div class="sheet-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={assistTab === 'assist'}
					class:active={assistTab === 'assist'}
					onclick={() => (assistTab = 'assist')}>✦ 캐릭터 생성</button
				>
				<button
					type="button"
					role="tab"
					aria-selected={assistTab === 'thumb'}
					class:active={assistTab === 'thumb'}
					onclick={() => (assistTab = 'thumb')}>🖼 썸네일</button
				>
			</div>
			<button
				type="button"
				class="sheet-close"
				onclick={() => (assistSheetOpen = false)}
				aria-label="AI 도우미 닫기">✕</button
			>
		</div>
		<div class="pane" class:m-hidden={assistTab !== 'assist'}>
			<CharacterAssistPanel {nsfw} current={currentDraft} onapply={applyAssist} />
		</div>
		<div class="pane" class:m-hidden={assistTab !== 'thumb'}>
			<CharacterThumbnailPanel
				{description}
				{nsfw}
				onuse={(file, styleId, original) => {
					setImage(file);
					upscaleSource = original;
					// 이 썸네일을 만든 그림체를 추천 그림체로 자동 반영(목록에 있을 때만).
					if (styleId && myStyles.some((s) => s.id === styleId)) recommendedStyleId = styleId;
					closeAssistSheet();
				}}
			/>
		</div>
	</div>
	{#if assistSheetOpen}
		<button
			type="button"
			class="sheet-backdrop"
			use:scrollLock
			onclick={() => (assistSheetOpen = false)}
			aria-label="AI 도우미 닫기"
		></button>
	{/if}
	<button
		type="button"
		class="assist-fab"
		onclick={() => (assistSheetOpen = true)}
		aria-label="AI 도우미 열기"
	>
		<span class="fab-logo">✦</span> AI 도우미
	</button>
</div>

<CharacterImagesModal
	open={imagesOpen}
	{characterId}
	initialAxes={sceneAxes}
	initialEntries={sceneEntries}
	onclose={() => (imagesOpen = false)}
	onapply={applyScenes}
/>

<NamedImagesModal
	open={namedOpen}
	initial={namedImages}
	onclose={() => (namedOpen = false)}
	onapply={applyNamed}
/>

<CharacterLorebookModal
	open={loreOpen}
	initialEntries={loreEntries}
	onclose={() => (loreOpen = false)}
	onapply={applyLore}
/>

<PromptGuideModal open={guideOpen} onclose={() => (guideOpen = false)} />

<TextReplaceModal
	open={replaceOpen}
	text={description}
	onclose={() => (replaceOpen = false)}
	onapply={(next) => {
		description = next;
		replaceOpen = false;
	}}
/>

<style>
	/* 폼 + (PC 전용) AI 보조 패널 2열 레이아웃. 패널 없는 폭에선 폼이 그대로 중앙 정렬. */
	.create-layout {
		display: flex;
		justify-content: center;
		align-items: flex-start;
		gap: 28px;
	}
	.create {
		flex: 0 1 640px;
		max-width: 640px;
		padding: 28px 20px 80px;
	}
	/* ── AI 도우미: 모바일 = 바텀시트(기본), PC = 우측 sticky 열 ─────────────── */
	.assist-col {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		max-height: min(88vh, 88dvh);
		overflow-y: auto;
		background: var(--bg);
		border-top: 1px solid var(--border);
		border-radius: 20px 20px 0 0;
		box-shadow: 0 -16px 50px rgba(0, 0, 0, 0.55);
		transform: translateY(100%);
		visibility: hidden;
		transition:
			transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
			visibility 0.28s;
	}
	.assist-col.open {
		transform: none;
		visibility: visible;
	}
	.sheet-head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 10px 8px 14px;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.sheet-tabs {
		flex: 1;
		display: flex;
		gap: 6px;
	}
	.sheet-tabs button {
		padding: 8px 13px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text-dim);
		font-size: 0.85rem;
		font-weight: 600;
		white-space: nowrap;
	}
	.sheet-tabs button.active {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}
	.sheet-close {
		width: 34px;
		height: 34px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.95rem;
	}
	.pane {
		padding: 8px 6px calc(16px + env(safe-area-inset-bottom));
	}
	.pane.m-hidden {
		display: none;
	}
	.sheet-backdrop {
		position: fixed;
		inset: 0;
		z-index: 55;
		border: none;
		padding: 0;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(3px);
	}
	.assist-fab {
		position: fixed;
		right: 16px;
		bottom: calc(18px + env(safe-area-inset-bottom));
		z-index: 45;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 12px 18px 12px 14px;
		border: none;
		border-radius: 999px;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		color: #fff;
		font-size: 0.9rem;
		font-weight: 800;
		letter-spacing: -0.01em;
		box-shadow: 0 10px 28px rgba(124, 92, 255, 0.45);
	}
	.assist-fab:active {
		transform: scale(0.97);
	}
	.fab-logo {
		font-size: 1.05rem;
	}
	@media (min-width: 1080px) {
		/* PC: 폼 옆 sticky 열. 시트 전용 요소(탭 헤더·FAB·백드롭)는 숨기고 두 패널을 모두 펼친다. */
		.assist-col {
			position: sticky;
			top: 20px;
			left: auto;
			right: auto;
			bottom: auto;
			z-index: auto;
			gap: 18px;
			flex: 0 0 340px;
			width: 340px;
			margin-top: 76px;
			/* 두 패널을 합치면 길어질 수 있으니 sticky 영역 안에서 자체 스크롤. */
			max-height: calc(100vh - 40px);
			background: transparent;
			border: none;
			border-radius: 0;
			box-shadow: none;
			transform: none;
			visibility: visible;
			transition: none;
		}
		.sheet-head,
		.sheet-backdrop,
		.assist-fab {
			display: none;
		}
		.pane,
		.pane.m-hidden {
			display: block;
			padding: 0;
		}
	}
	.back {
		display: inline-block;
		color: var(--text-dim);
		font-size: 0.88rem;
		margin-bottom: 24px;
	}
	.back:hover {
		color: var(--text);
	}
	.head {
		text-align: center;
		margin-bottom: 28px;
	}
	.logo {
		color: var(--accent);
		font-size: 2rem;
	}
	.head h1 {
		margin: 8px 0 8px;
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.sub {
		margin: 0 auto;
		max-width: 460px;
		color: var(--text-dim);
		font-size: 0.9rem;
		line-height: 1.6;
	}
	.sub strong {
		color: var(--text);
	}

	.field {
		margin-bottom: 22px;
	}
	.label-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 7px;
	}
	.field-label {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 7px;
	}
	.label-row .field-label {
		margin-bottom: 0;
	}
	.mode-toggle {
		display: inline-flex;
		gap: 2px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 2px;
	}
	.mode-toggle button {
		border: none;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.76rem;
		font-weight: 700;
		padding: 4px 12px;
		border-radius: 999px;
		cursor: pointer;
	}
	.mode-toggle button.active {
		background: var(--accent);
		color: #fff;
	}
	.label-with-info {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.info-btn {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 0.92rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 50%;
		transition:
			color 0.15s ease,
			background 0.15s ease;
	}
	.info-btn:hover {
		color: var(--accent);
		background: var(--accent-soft);
	}
	.req {
		color: var(--accent);
	}
	.opt {
		color: var(--text-faint);
		font-weight: 400;
	}
	.opt-link {
		font-size: 0.74rem;
		font-weight: 700;
		color: var(--accent);
	}
	.rec-select {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px 12px;
		color: var(--text);
		font: inherit;
		font-size: 0.9rem;
		outline: none;
	}
	.rec-select:focus {
		border-color: var(--accent);
	}
	.hint {
		font-size: 0.74rem;
		color: var(--text-faint);
	}
	.count {
		font-size: 0.74rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.count.over {
		color: var(--nsfw);
	}

	input[type='text'],
	textarea {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 11px 13px;
		color: var(--text);
		font-size: 0.92rem;
		outline: none;
		line-height: 1.6;
		resize: vertical;
	}
	input[type='text']:focus,
	textarea:focus {
		border-color: var(--accent);
	}
	input::placeholder,
	textarea::placeholder {
		color: var(--text-faint);
	}
	.field-hint {
		margin: 7px 0 0;
		font-size: 0.76rem;
		line-height: 1.5;
		color: var(--text-faint);
	}
	.field-hint.top {
		margin: 0 0 10px;
	}

	/* 첫 상황(오프닝) */
	.greetings {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.greeting-item {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px 11px;
	}
	.greeting-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 8px;
	}
	.greeting-name {
		flex: 1;
		min-width: 0;
		background: var(--bg-elev) !important;
		border: 1px solid var(--border) !important;
		border-radius: 8px !important;
		padding: 6px 10px !important;
		font-size: 0.82rem !important;
		font-weight: 600;
		color: var(--text);
	}
	.greeting-name:focus {
		border-color: var(--accent) !important;
	}
	.greeting-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.greeting-del {
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 0.72rem;
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		border-radius: 50%;
	}
	.greeting-del:hover {
		background: var(--bg-elev);
		color: var(--nsfw);
	}
	.greeting-item textarea {
		background: var(--bg-elev);
	}
	.add-greeting {
		margin-top: 10px;
		width: 100%;
		padding: 10px;
		background: transparent;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 0.85rem;
		font-weight: 600;
		transition: all 0.15s ease;
	}
	.add-greeting:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	/* 스크립트 변수 */
	.scriptvars {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.scriptvar-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.sv-key {
		flex: 0 0 36%;
		min-width: 0;
	}
	.sv-val {
		flex: 1;
		min-width: 0;
	}
	.sv-del {
		flex-shrink: 0;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 0.72rem;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border-radius: 50%;
	}
	.sv-del:hover {
		background: var(--bg-elev);
		color: var(--nsfw);
	}

	/* 드롭존 */
	.dropzone {
		position: relative;
		aspect-ratio: 1 / 1;
		max-width: 200px;
		border: 1.5px dashed var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		display: grid;
		place-items: center;
		cursor: pointer;
		overflow: hidden;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.dropzone:hover,
	.dropzone.over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.dropzone.has-image {
		border-style: solid;
	}
	.dropzone-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 16px;
		text-align: center;
	}
	.dz-icon {
		font-size: 1.8rem;
	}
	.dz-text {
		font-size: 0.78rem;
		color: var(--text-dim);
		line-height: 1.4;
	}
	.preview {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.remove-img {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 26px;
		height: 26px;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.6);
		color: #fff;
		font-size: 0.8rem;
		display: grid;
		place-items: center;
	}
	.remove-img:hover {
		background: rgba(0, 0, 0, 0.85);
	}
	.hidden-input {
		display: none;
	}

	/* 장면 이미지 관리 버튼 */
	.manage-images {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 13px 14px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		text-align: left;
		transition: border-color 0.15s ease;
	}
	.manage-images:hover {
		border-color: var(--accent);
	}
	.mi-icon {
		font-size: 1.3rem;
		flex-shrink: 0;
	}
	.mi-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.mi-text strong {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text);
	}
	.mi-text span {
		font-size: 0.74rem;
		color: var(--text-faint);
	}
	.mi-chev {
		color: var(--text-faint);
		font-size: 1.2rem;
		flex-shrink: 0;
	}

	/* 세그먼트(타깃) */
	.seg {
		display: flex;
		gap: 10px;
	}
	.seg-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 11px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		text-align: center;
		transition: all 0.15s ease;
	}
	.seg-btn span {
		font-size: 0.7rem;
		color: var(--text-faint);
	}
	.seg-btn.active {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.seg-btn.active span {
		color: var(--text-dim);
	}

	/* 연령제한 토글 */
	.toggle-row {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 13px 14px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		text-align: left;
		transition: border-color 0.15s ease;
	}
	.toggle-row.active {
		border-color: var(--nsfw);
	}
	.toggle-left {
		display: flex;
		align-items: center;
		gap: 11px;
		min-width: 0;
	}
	.toggle-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.toggle-text strong {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text);
	}
	.toggle-text span {
		font-size: 0.74rem;
		color: var(--text-faint);
	}
	.switch {
		flex-shrink: 0;
		width: 42px;
		height: 24px;
		border-radius: 999px;
		background: var(--border);
		position: relative;
		transition: background 0.15s ease;
	}
	.switch.on {
		background: var(--nsfw);
	}
	.knob {
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

	/* 해시태그 */
	.tag-edit {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 7px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 9px 11px;
		min-height: 44px;
	}
	.tag-edit:focus-within {
		border-color: var(--accent);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 0.78rem;
		color: var(--text);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		padding: 3px 6px 3px 10px;
		border-radius: 999px;
	}
	.chip-x {
		border: none;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.7rem;
		padding: 0;
		line-height: 1;
		width: 16px;
		height: 16px;
		display: grid;
		place-items: center;
		border-radius: 50%;
	}
	.chip-x:hover {
		background: rgba(255, 255, 255, 0.1);
		color: var(--text);
	}
	.tag-input {
		flex: 1;
		min-width: 120px;
		background: transparent !important;
		border: none !important;
		padding: 2px 0 !important;
		font-size: 0.85rem;
	}
	.tag-input:focus {
		border: none !important;
	}

	.error {
		margin: 0 0 14px;
		font-size: 0.82rem;
		color: var(--nsfw);
	}
	.submit {
		width: 100%;
		padding: 13px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.95rem;
		transition: background 0.15s ease;
	}
	.submit:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.submit:not(:disabled):hover {
		background: var(--accent-hover);
	}
</style>
