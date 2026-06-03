<script lang="ts">
	import { goto } from '$app/navigation';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import type { Audience, ContentRating, Opening } from '$lib/types';

	export interface CharacterFormInitial {
		name: string;
		tagline: string;
		intro: string;
		description: string;
		audience: Audience;
		contentRating: ContentRating;
		tags: string[];
		greetings: Opening[];
		/** 기존 썸네일 URL (수정 시 미리보기용). */
		avatarUrl: string;
	}

	let {
		mode,
		characterId,
		initial
	}: {
		mode: 'create' | 'edit';
		characterId?: string;
		initial?: CharacterFormInitial;
	} = $props();

	const NAME_MAX = 15;
	const TAGLINE_MAX = 100;
	const INTRO_MAX = 3000;
	const DESC_MAX = 6000;
	const TAGS_MAX = 5;
	const GREETING_MAX = 2000;
	const GREETING_NAME_MAX = 30;
	const GREETINGS_MAX = 5;
	const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
	const ACCEPT = ['image/webp', 'image/avif'];

	let name = $state(initial?.name ?? '');
	let tagline = $state(initial?.tagline ?? '');
	let intro = $state(initial?.intro ?? '');
	let description = $state(initial?.description ?? '');
	let audience = $state<Audience>(initial?.audience ?? 'all');
	let nsfw = $state(initial?.contentRating === 'nsfw');

	// 첫 상황(오프닝) — 첫 항목이 기본(필수). 각 항목은 이름(선택용)과 본문을 가진다.
	let greetings = $state<Opening[]>(
		initial?.greetings?.length
			? initial.greetings.map((g) => ({ name: g.name, content: g.content }))
			: [{ name: '', content: '' }]
	);

	let tagInput = $state('');
	let tags = $state<string[]>(initial?.tags ? [...initial.tags] : []);

	let imageFile = $state<File | null>(null);
	let imagePreview = $state<string | null>(null);
	let dragOver = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	let submitting = $state(false);
	let error = $state('');

	// 새로 고른 이미지가 있으면 그것, 없으면 기존(수정) 썸네일.
	const displayImage = $derived(imagePreview ?? initial?.avatarUrl ?? null);
	const isEdit = mode === 'edit';

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
			description.length <= DESC_MAX &&
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
		if (fileInput) fileInput.value = '';
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

			const url = isEdit ? `/api/characters/${characterId}` : '/api/characters';
			const res = await fetch(url, { method: isEdit ? 'PUT' : 'POST', body: fd });
			const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
			if (!res.ok || !data.id) {
				throw new Error(data.error ?? '저장에 실패했어요.');
			}
			// 생성 → 바로 대화, 수정 → 관리 목록으로.
			await goto(isEdit ? '/characters' : `/chat/${data.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : '저장에 실패했어요.';
			submitting = false;
		}
	}
</script>

<div class="create">
	<a class="back" href={isEdit ? '/characters' : '/'}>← {isEdit ? '캐릭터 관리' : '탐색으로'}</a>

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
			<label class="field-label" for="c-desc">프롬프트 <span class="req">*</span></label>
			<span class="count" class:over={description.length > DESC_MAX}
				>{description.length}/{DESC_MAX}</span
			>
		</div>
		<textarea
			id="c-desc"
			rows="10"
			placeholder={'캐릭터의 역할·성격·말투·세계관, 그리고 출력 형식을 자유롭게 작성하세요.\n\n예) 너는 "OOO"라는 가상의 캐릭터를 연기한다. ...\n[출력 형식] 소설 형식으로 서술한다. 대사는 \'이름 | "대사"\' 형식으로 쓴다. ...'}
			maxlength={DESC_MAX}
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
			저장 중…
		{:else}
			{isEdit ? '변경 사항 저장' : '캐릭터 등록'}
		{/if}
	</button>
</div>

<style>
	.create {
		max-width: 640px;
		margin: 0 auto;
		padding: 28px 20px 80px;
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
	.req {
		color: var(--accent);
	}
	.opt {
		color: var(--text-faint);
		font-weight: 400;
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
