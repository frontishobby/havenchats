<script lang="ts">
	import CharacterCard from '$lib/components/CharacterCard.svelte';
	import CharacterDetailModal from '$lib/components/CharacterDetailModal.svelte';
	import type { Character } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state('');
	let detail = $state<Character | null>(null);

	const filtered = $derived(
		data.characters.filter((c) => {
			const q = query.trim().toLowerCase();
			const matchesQuery =
				!q ||
				c.name.toLowerCase().includes(q) ||
				c.tagline.toLowerCase().includes(q) ||
				c.description.toLowerCase().includes(q);
			return matchesQuery;
		})
	);

</script>

<svelte:head>
	<title>Haven</title>
	<meta name="description" content="나만의 AI 캐릭터와 끝없는 이야기를 나눠보세요." />
</svelte:head>

<section class="hero">
	<div class="search">
		<span class="search-icon">🔍</span>
		<input
			type="search"
			name="character-search"
			autocomplete="off"
			placeholder="캐릭터 이름, 설명으로 검색…"
			bind:value={query}
		/>
	</div>

</section>

<section class="grid-wrap">
	{#if filtered.length === 0}
		<p class="empty">조건에 맞는 캐릭터가 없어요.</p>
	{:else}
		<div class="grid">
			{#each filtered as character (character.id)}
				<CharacterCard {character} onselect={(c) => (detail = c)} />
			{/each}
		</div>
	{/if}
</section>

<CharacterDetailModal character={detail} onclose={() => (detail = null)} />

<style>
	.hero {
		max-width: var(--maxw);
		margin: 0 auto;
		padding: 32px 20px 24px;
		text-align: center;
	}
	.search {
		position: relative;
		max-width: 520px;
		margin: 0 auto 20px;
	}
	.search-icon {
		position: absolute;
		left: 16px;
		top: 50%;
		transform: translateY(-50%);
		font-size: 0.95rem;
		opacity: 0.6;
	}
	.search input {
		width: 100%;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 13px 18px 13px 44px;
		color: var(--text);
		font-size: 0.95rem;
		outline: none;
		transition: border-color 0.15s ease;
	}
	.search input:focus {
		border-color: var(--accent);
	}
	.search input::placeholder {
		color: var(--text-faint);
	}

	.grid-wrap {
		max-width: var(--maxw);
		margin: 0 auto;
		padding: 16px 20px 64px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 18px;
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 12px;
		}
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 60px 0;
	}
</style>
