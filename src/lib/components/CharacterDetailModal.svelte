<script lang="ts">
	import { goto } from '$app/navigation';
	import NsfwBadge from './NsfwBadge.svelte';
	import type { Character } from '$lib/types';

	let { character, onclose }: { character: Character | null; onclose: () => void } = $props();

	let selected = $state(0);
	let pickOpen = $state(false);
	let imgFailed = $state(false);
	let starting = $state(false);

	// 캐릭터가 바뀌면 선택/상태 초기화
	let lastId = $state<string | null>(null);
	$effect(() => {
		if (character && character.id !== lastId) {
			lastId = character.id;
			selected = 0;
			pickOpen = false;
			imgFailed = false;
			starting = false;
		}
	});

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
				</div>
				<div class="hero-info">
					<div class="name-row">
						<h2>{character.name}</h2>
						{#if character.contentRating === 'nsfw'}
							<NsfwBadge size={18} />
						{/if}
					</div>
					<p class="tagline">{character.tagline}</p>
					<div class="meta">
						<span class="meta-chip">{AUDIENCE_LABEL[character.audience]}</span>
						{#each character.tags.slice(0, 4) as tag (tag)}
							<span class="meta-chip tag">#{tag}</span>
						{/each}
					</div>
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
				</div>
			{/if}

			<button class="start" onclick={start} disabled={starting}>
				{starting ? '시작하는 중…' : '채팅 시작하기'}
			</button>
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
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.95rem;
		z-index: 1;
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}

	.hero {
		display: flex;
		gap: 16px;
		margin-bottom: 20px;
	}
	.thumb {
		width: 96px;
		height: 96px;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.thumb-fallback {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		font-size: 2.4rem;
		font-weight: 700;
		color: #fff;
	}
	.hero-info {
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
	}
	.name-row {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.name-row h2 {
		margin: 0;
		font-size: 1.3rem;
		font-weight: 800;
	}
	.tagline {
		margin: 6px 0 0;
		font-size: 0.9rem;
		color: var(--text-dim);
		line-height: 1.5;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 10px;
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

	.start {
		flex-shrink: 0;
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
	.start:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.start:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
