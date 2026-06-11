<script lang="ts">
	import { goto } from '$app/navigation';
	import NsfwBadge from './NsfwBadge.svelte';
	import { hasScenes, looksLikeSceneToken } from '$lib/imageCodes';
	import { resized } from '$lib/imageUrl';
	import type { Character } from '$lib/types';

	let { character, onclose }: { character: Character | null; onclose: () => void } = $props();

	let selected = $state(0);
	let pickOpen = $state(false);
	let imgFailed = $state(false);
	let creatorImgFailed = $state(false);
	let starting = $state(false);

	// 캐릭터가 바뀌면 선택/상태 초기화
	let lastId = $state<string | null>(null);
	$effect(() => {
		if (character && character.id !== lastId) {
			lastId = character.id;
			selected = 0;
			pickOpen = false;
			imgFailed = false;
			creatorImgFailed = false;
			starting = false;
		}
	});

	// 제작자 표시명(미설정 시 '익명'). 이름이 있어야 유저 페이지 링크가 유효(미완성 프로필은 404).
	const creatorName = $derived(character?.creator.name ?? '익명');
	const creatorLinkable = $derived(!!character?.creator.name);

	function openCreator() {
		if (!character || !creatorLinkable) return;
		goto(`/user/${character.creator.id}`);
	}

	const AUDIENCE_LABEL: Record<Character['audience'], string> = {
		all: '공통',
		male: '남성향',
		female: '여성향'
	};

	function chooseOpening(i: number) {
		selected = i;
		pickOpen = false;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function start() {
		if (!character || starting) return;
		starting = true;
		const multi = character.greetings.length > 1;
		goto(`/chat/${character.id}${multi ? `?o=${selected}` : ''}`);
	}

	/**
	 * 오프닝 본문 → 미리보기용 짧은 문구. 장면 이미지 토큰 줄을 걸러내고,
	 * `발화자 | "대사"` 표기의 `|`·강조 마크(* _)·{{나}} 를 정리해 첫 부분만 보여준다.
	 */
	const PREVIEW_MAX = 160;
	function previewOf(content: string): string {
		const cleaned = content
			.split('\n')
			.filter((l) => !looksLikeSceneToken(l.trim()))
			.join(' ')
			.replace(/\{\{\s*나\s*\}\}/g, '나')
			.replace(/\s*\|\s*/g, ' ') // 발화자 구분자 제거
			.replace(/[*_~`]/g, '') // 강조/기울임 마크 제거
			.replace(/\s+/g, ' ')
			.trim();
		return cleaned.length > PREVIEW_MAX ? cleaned.slice(0, PREVIEW_MAX).trimEnd() + '…' : cleaned;
	}

	// 등록된 장면 이미지(에셋)가 있을 때만 미리보기 버튼 노출.
	const hasAssets = $derived(hasScenes(character?.imageSet));

	function viewAssets() {
		if (!character) return;
		goto(`/characters/${character.id}/assets`);
	}
</script>

<svelte:window onkeydown={onKey} />

{#if character}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onclose} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label={`${character.name} 정보`}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<button class="close" onclick={onclose} aria-label="닫기">✕</button>

			<div class="hero">
				<div class="thumb">
					{#if imgFailed}
						<span class="thumb-fallback">{character.name.charAt(0)}</span>
					{:else}
						<img
							src={character.avatarUrl}
							alt={character.name}
							onerror={() => (imgFailed = true)}
						/>
					{/if}
					<div class="hero-overlay">
						<div class="name-row">
							<h2>{character.name}</h2>
							{#if character.contentRating === 'nsfw'}
								<NsfwBadge size={18} />
							{/if}
						</div>
						<p class="tagline">{character.tagline}</p>
					</div>
				</div>
				<div class="meta">
					<span class="meta-chip">{AUDIENCE_LABEL[character.audience]}</span>
					{#each character.tags.slice(0, 4) as tag (tag)}
						<span class="meta-chip tag">#{tag}</span>
					{/each}
				</div>
			</div>

			{#if character.intro.trim()}
				<div class="body">
					<p class="intro">{character.intro}</p>
				</div>
			{/if}

			{#if character.greetings.length > 1}
				{@const sel = character.greetings[Math.min(selected, character.greetings.length - 1)]}
				<div class="openings">
					<span class="section-label">첫 상황</span>
					<div class="pick">
						<button
							type="button"
							class="pick-trigger"
							class:open={pickOpen}
							onclick={() => (pickOpen = !pickOpen)}
							aria-haspopup="listbox"
							aria-expanded={pickOpen}
						>
							<span class="pick-current">{sel.name}</span>
							<span class="chev">▾</span>
						</button>
						{#if pickOpen}
							<ul class="pick-list" role="listbox">
								{#each character.greetings as g, i (i)}
									<li>
										<button
											type="button"
											class="pick-option"
											class:selected={selected === i}
											role="option"
											aria-selected={selected === i}
											onclick={() => chooseOpening(i)}
										>
											<span class="pick-option-name">{g.name}</span>
											{#if selected === i}<span class="check">✓</span>{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					{#if previewOf(sel.content)}
						<p class="opening-preview">{previewOf(sel.content)}</p>
					{/if}
				</div>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<svelte:element
				this={creatorLinkable ? 'button' : 'div'}
				class="creator"
				class:linkable={creatorLinkable}
				type={creatorLinkable ? 'button' : undefined}
				onclick={creatorLinkable ? openCreator : undefined}
			>
				<span class="creator-avatar">
					{#if character.creator.avatarUrl && !creatorImgFailed}
						<img
							src={resized(character.creator.avatarUrl, 96)}
							alt={creatorName}
							onerror={() => (creatorImgFailed = true)}
						/>
					{:else}
						<span class="creator-fallback">{creatorName.charAt(0).toUpperCase()}</span>
					{/if}
				</span>
				<span class="creator-text">
					<span class="creator-label">제작자</span>
					<span class="creator-name">{creatorName}</span>
				</span>
				{#if creatorLinkable}<span class="creator-chev">›</span>{/if}
			</svelte:element>

			<div class="actions">
				{#if hasAssets}
					<button class="assets" onclick={viewAssets}>🖼 에셋 미리보기</button>
				{/if}
				<button class="start" onclick={start} disabled={starting}>
					{starting ? '시작하는 중…' : '채팅 시작하기'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 120;
		background: rgba(0, 0, 0, 0.65);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 520px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 24px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
		max-height: calc(100vh - 40px);
		display: flex;
		flex-direction: column;
	}
	.close {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 32px;
		height: 32px;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		font-size: 0.95rem;
		z-index: 2;
		backdrop-filter: blur(2px);
	}
	.close:hover {
		background: rgba(0, 0, 0, 0.7);
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-bottom: 20px;
	}
	/* 세로 포트레이트 히어로 — 모달 좌우 패딩까지 채우고 하단에 이름/태그라인 오버레이 */
	.thumb {
		position: relative;
		width: calc(100% + 48px);
		margin: -24px -24px 0;
		aspect-ratio: 3 / 4;
		max-height: 56vh;
		overflow: hidden;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		border-radius: var(--radius) var(--radius) 0 0;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: center top;
		display: block;
	}
	.thumb-fallback {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		font-size: 5rem;
		font-weight: 700;
		color: #fff;
	}
	/* 이미지 하단 그라데이션 위 텍스트 */
	.hero-overlay {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 36px 24px 16px;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.82) 0%, rgba(0, 0, 0, 0.4) 55%, transparent 100%);
		pointer-events: none;
	}
	.name-row {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.name-row h2 {
		margin: 0;
		font-size: 1.45rem;
		font-weight: 800;
		color: #fff;
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}
	.tagline {
		margin: 6px 0 0;
		font-size: 0.9rem;
		color: rgba(255, 255, 255, 0.88);
		line-height: 1.5;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.meta-chip {
		font-size: 0.72rem;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		padding: 2px 9px;
		border-radius: 999px;
	}
	.meta-chip.tag {
		color: var(--text-faint);
	}

	.intro {
		margin: 0 0 20px;
		padding: 14px 16px;
		background: var(--bg-elev);
		border-radius: var(--radius-sm);
		font-size: 0.88rem;
		line-height: 1.65;
		color: var(--text-dim);
		white-space: pre-wrap;
	}

	.body {
		flex: 0 1 auto;
		min-height: 0;
		overflow-y: auto;
		margin-bottom: 18px;
	}
	.openings {
		flex-shrink: 0;
		margin-bottom: 18px;
	}
	.section-label {
		display: block;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text);
		margin-bottom: 10px;
	}
	/* 선택한 첫 상황의 도입부 미리보기(2줄까지). */
	.opening-preview {
		margin: 10px 2px 0;
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--text-faint);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	/* 상황 이름 드롭다운 — 스크롤 영역(.body) 밖이라 펼쳐도 내부 스크롤 안 생김 */
	.pick {
		position: relative;
	}
	.pick-trigger {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 11px 14px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.9rem;
		font-weight: 600;
		transition: border-color 0.15s ease;
	}
	.pick-trigger:hover,
	.pick-trigger.open {
		border-color: var(--accent);
	}
	.pick-current {
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chev {
		color: var(--text-faint);
		font-size: 0.8rem;
		flex-shrink: 0;
	}
	.pick-list {
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
		max-height: 240px;
		overflow-y: auto;
	}
	.pick-option {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 9px 11px;
		background: transparent;
		border: none;
		border-radius: 8px;
		color: var(--text);
		font-size: 0.88rem;
		text-align: left;
	}
	.pick-option:hover {
		background: var(--bg-elev);
	}
	.pick-option.selected {
		background: var(--accent-soft);
	}
	.pick-option-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.check {
		color: var(--accent);
		font-weight: 700;
		flex-shrink: 0;
	}

	.creator {
		flex-shrink: 0;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 11px;
		margin-bottom: 12px;
		padding: 9px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		text-align: left;
		color: var(--text);
		transition: border-color 0.15s ease;
	}
	.creator.linkable:hover {
		border-color: var(--accent);
		cursor: pointer;
	}
	.creator-avatar {
		width: 34px;
		height: 34px;
		flex-shrink: 0;
		border-radius: 50%;
		overflow: hidden;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
	}
	.creator-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.creator-fallback {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		font-size: 1rem;
		font-weight: 700;
		color: #fff;
	}
	.creator-text {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.creator-label {
		font-size: 0.7rem;
		color: var(--text-faint);
	}
	.creator-name {
		font-size: 0.9rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.creator-chev {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: 1.1rem;
	}

	.actions {
		flex-shrink: 0;
		display: flex;
		gap: 10px;
	}
	.assets {
		flex-shrink: 0;
		padding: 13px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		color: var(--text);
		font-weight: 600;
		font-size: 0.9rem;
		white-space: nowrap;
		transition: border-color 0.15s ease;
	}
	.assets:hover {
		border-color: var(--accent);
	}
	.start {
		flex: 1;
		padding: 13px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.95rem;
		transition: background 0.15s ease;
	}
	.start:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.start:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
