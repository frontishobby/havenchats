<script lang="ts">
	import type { Character } from '$lib/types';
	import NsfwBadge from './NsfwBadge.svelte';

	let { character }: { character: Character } = $props();

	let imgFailed = $state(false);

	const initial = $derived(character.name.trim().charAt(0));

	function formatChats(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
		if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
		return String(n);
	}
</script>

<a class="card" href={`/chat/${character.id}`}>
	<div class="avatar">
		{#if imgFailed}
			<span class="avatar-fallback">{initial}</span>
		{:else}
			<img
				src={character.avatarUrl}
				alt={character.name}
				loading="lazy"
				onerror={() => (imgFailed = true)}
			/>
		{/if}
	</div>

	<div class="body">
		<div class="name-row">
			<h3 class="name">
				<span class="name-text">{character.name}</span>
				{#if character.contentRating === 'nsfw'}
					<NsfwBadge size={17} />
				{/if}
			</h3>
			<span class="chats">💬 {formatChats(character.chats)}</span>
		</div>
		<p class="tagline">{character.tagline}</p>
		<div class="tags">
			{#each character.tags.slice(0, 3) as tag (tag)}
				<span class="tag">{tag}</span>
			{/each}
		</div>
	</div>
</a>

<style>
	.card {
		display: flex;
		flex-direction: column;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
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
	.name-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
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
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
