<script lang="ts">
	import CharacterCard from '$lib/components/CharacterCard.svelte';
	import CharacterDetailModal from '$lib/components/CharacterDetailModal.svelte';
	import type { Character } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state('');
	let activeTag = $state<string | null>(null);
	let detail = $state<Character | null>(null);

	const filtered = $derived(
		data.characters.filter((c) => {
			const q = query.trim().toLowerCase();
			const matchesQuery =
				!q ||
				c.name.toLowerCase().includes(q) ||
				c.tagline.toLowerCase().includes(q) ||
				c.description.toLowerCase().includes(q);
			const matchesTag = !activeTag || c.tags.includes(activeTag);
			return matchesQuery && matchesTag;
		})
	);

	function toggleTag(tag: string) {
		activeTag = activeTag === tag ? null : tag;
	}
</script>

<svelte:head>
	<title>Haven — AI 캐릭터와 대화하세요</title>
	<meta name="description" content="나만의 AI 캐릭터와 끝없는 이야기를 나눠보세요." />
</svelte:head>

{#if data.authError === 'notallowed'}
	<div class="notice">현재는 테스트 기간으로, 허용된 계정만 로그인할 수 있어요.</div>
{:else if data.authError === 'error'}
	<div class="notice">로그인 중 문제가 발생했어요. 다시 시도해 주세요.</div>
{/if}

<section class="hero">
	<h1>마음이 머무는 곳, <span class="accent">Haven</span></h1>
	<p>좋아하는 캐릭터를 골라 지금 바로 대화를 시작하세요.</p>

	<div class="search">
		<span class="search-icon">🔍</span>
		<input type="text" placeholder="캐릭터 이름, 설명으로 검색…" bind:value={query} />
	</div>

	<div class="tags" role="group" aria-label="태그 필터">
		{#each data.tags as tag (tag)}
			<button class="tag" class:active={activeTag === tag} onclick={() => toggleTag(tag)}>
				{tag}
			</button>
		{/each}
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
	.notice {
		max-width: var(--maxw);
		margin: 16px auto 0;
		padding: 12px 16px;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.88rem;
		text-align: center;
	}
	.hero {
		max-width: var(--maxw);
		margin: 0 auto;
		padding: 48px 20px 24px;
		text-align: center;
	}
	.hero h1 {
		font-size: clamp(1.8rem, 4vw, 2.8rem);
		font-weight: 800;
		margin: 0 0 10px;
		letter-spacing: -0.02em;
	}
	.accent {
		color: var(--accent);
	}
	.hero p {
		color: var(--text-dim);
		margin: 0 0 28px;
		font-size: 1.05rem;
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
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
	}
	.tag {
		background: var(--bg-card);
		border: 1px solid var(--border);
		color: var(--text-dim);
		font-size: 0.82rem;
		padding: 6px 14px;
		border-radius: 999px;
		transition: all 0.15s ease;
	}
	.tag:hover {
		color: var(--text);
		border-color: var(--text-faint);
	}
	.tag.active {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
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
