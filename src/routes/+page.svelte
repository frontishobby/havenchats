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
		<a class="create-btn" href="/create" aria-label="캐릭터 만들기" title="캐릭터 만들기">
			<span class="plus">＋</span><span class="create-label">만들기</span>
		</a>
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
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: 600px;
		margin: 0 auto 20px;
	}
	/* 캐릭터 만들기 진입점 — 검색창 오른쪽 알약 버튼(유저 메뉴에도 같은 항목). */
	.create-btn {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 44px;
		padding: 0 16px 0 12px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-size: 0.9rem;
		font-weight: 700;
		white-space: nowrap;
		transition: background 0.15s ease;
	}
	.create-btn:hover {
		background: var(--accent-hover);
	}
	.plus {
		font-size: 1.05rem;
		line-height: 1;
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
		flex: 1;
		min-width: 0;
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
		.hero {
			padding: 14px 12px 6px;
		}
		.search {
			margin-bottom: 6px;
		}
		.search-icon {
			left: 13px;
			font-size: 0.85rem;
		}
		.search input {
			padding: 10px 14px 10px 38px;
		}
		.search {
			gap: 8px;
		}
		.create-btn {
			min-height: 42px;
			width: 42px;
			padding: 0;
			justify-content: center;
		}
		.create-label {
			display: none;
		}
		.plus {
			font-size: 1.25rem;
		}
		.grid-wrap {
			padding: 8px 12px 48px;
		}
		.grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 10px;
		}
		.empty {
			padding: 40px 0;
			font-size: 0.9rem;
		}
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 60px 0;
	}
</style>
