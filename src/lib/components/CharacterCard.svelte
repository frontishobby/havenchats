<script lang="ts">
	import type { Character } from '$lib/types';
	import { resized } from '$lib/imageUrl';
	import NsfwBadge from './NsfwBadge.svelte';

	let { character, onselect }: { character: Character; onselect: (c: Character) => void } =
		$props();

	let imgFailed = $state(false);

	const initial = $derived(character.name.trim().charAt(0));

	function formatChats(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
		if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
		return String(n);
	}
</script>

<button type="button" class="card" onclick={() => onselect(character)}>
	<div class="avatar">
		{#if imgFailed}
			<span class="avatar-fallback">{initial}</span>
		{:else}
			<img
				src={resized(character.avatarUrl, 480)}
				alt={character.name}
				loading="lazy"
				onerror={() => (imgFailed = true)}
			/>
		{/if}
	</div>

	<div class="body">
		<h3 class="name">
			<span class="name-text">{character.name}</span>
			{#if character.contentRating === 'nsfw'}
				<NsfwBadge size={17} />
			{/if}
		</h3>
		<span class="chats">💬 {formatChats(character.chats)}</span>
		<p class="tagline">{character.tagline}</p>
		<div class="tags">
			{#each character.tags.slice(0, 3) as tag (tag)}
				<span class="tag">{tag}</span>
			{/each}
		</div>
	</div>
</button>

<style>
	.card {
		display: flex;
		flex-direction: column;
		width: 100%;
		padding: 0;
		text-align: left;
		font: inherit;
		color: inherit;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		cursor: pointer;
		transition:
			transform 0.15s ease,
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.card:hover {
		transform: translateY(-3px);
		border-color: var(--accent);
		background: var(--bg-card-hover);
	}

	.avatar {
		position: relative;
		aspect-ratio: 1 / 1;
		background: linear-gradient(135deg, #7c5cff33, #ff5c8a33);
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.avatar-fallback {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-size: 3.5rem;
		font-weight: 700;
		color: #fff;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
	}
	.body {
		padding: 12px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	h3.name {
		margin: 0;
		font-size: 1rem;
		font-weight: 700;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.name-text {
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	.chats {
		font-size: 0.75rem;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.tagline {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text-dim);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		min-height: 2.3em;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 2px;
	}
	.tag {
		font-size: 0.7rem;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		padding: 2px 8px;
		border-radius: 999px;
	}
</style>
