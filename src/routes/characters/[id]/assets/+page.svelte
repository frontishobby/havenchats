<script lang="ts">
	import { goto } from '$app/navigation';
	import { comboToCode, entryUrl, entryAlt, hasScenes } from '$lib/imageCodes';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const character = $derived(data.character);
	const set = $derived(character.imageSet);
	const hasAssets = $derived(hasScenes(set));

	function letter(i: number): string {
		return String.fromCharCode(65 + i);
	}

	function back() {
		history.length > 1 ? history.back() : goto('/');
	}
</script>

<svelte:head>
	<title>{character.name} · 에셋</title>
</svelte:head>

<div class="page">
	<button class="back" onclick={back}>← 돌아가기</button>

	<header class="head">
		<h1>{character.name}</h1>
		{#if character.contentRating === 'nsfw'}<NsfwBadge size={18} />{/if}
		<span class="sub">장면 이미지 에셋</span>
	</header>

	{#if !hasAssets || !set}
		<p class="empty">이 캐릭터엔 등록된 장면 이미지가 없어요.</p>
	{:else}
		<!-- 축(카탈로그) 설명 -->
		<section class="axes">
			{#each set.axes as axis, a (a)}
				<div class="axis">
					<span class="axis-pos">{a + 1}번째 글자</span>
					<span class="axis-label">{axis.label}</span>
					<div class="vals">
						{#each axis.values as v, vi (vi)}
							<span class="val"><span class="badge">{letter(vi)}</span>{v}</span>
						{/each}
					</div>
				</div>
			{/each}
		</section>

		<!-- 조합 이미지 그리드 -->
		<section class="grid">
			{#each set.entries as entry (entry.id)}
				<figure class="card">
					<div class="img">
						<img src={entryUrl(character.id, entry)} alt={entryAlt(set, entry)} loading="lazy" />
						<span class="code">{comboToCode(entry.combo)}</span>
					</div>
					<figcaption>{entryAlt(set, entry)}</figcaption>
				</figure>
			{/each}
		</section>

		<p class="count">{set.entries.length}개 조합</p>
	{/if}
</div>

<style>
	.page {
		max-width: 960px;
		margin: 0 auto;
		padding: 24px 20px 64px;
	}
	.back {
		background: transparent;
		border: none;
		color: var(--text-dim);
		font-size: 0.88rem;
		padding: 6px 0;
		margin-bottom: 14px;
	}
	.back:hover {
		color: var(--text);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 22px;
	}
	.head h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 800;
	}
	.sub {
		font-size: 0.85rem;
		color: var(--text-faint);
	}
	.empty {
		color: var(--text-dim);
		font-size: 0.92rem;
		padding: 40px 0;
		text-align: center;
	}

	.axes {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 26px;
		padding: 16px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.axis {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.axis-pos {
		font-size: 0.68rem;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.axis-label {
		font-weight: 700;
		font-size: 0.9rem;
	}
	.vals {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.val {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 0.8rem;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 10px 3px 4px;
	}
	.badge {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.68rem;
		font-weight: 700;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 14px;
	}
	.card {
		margin: 0;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.img {
		position: relative;
		aspect-ratio: 1;
		background: var(--bg-elev);
	}
	.img img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.code {
		position: absolute;
		top: 6px;
		left: 6px;
		font-family: ui-monospace, monospace;
		font-weight: 800;
		font-size: 0.72rem;
		color: #fff;
		background: rgba(0, 0, 0, 0.55);
		padding: 2px 7px;
		border-radius: 6px;
	}
	figcaption {
		padding: 8px 10px;
		font-size: 0.78rem;
		color: var(--text-dim);
		line-height: 1.4;
	}
	.count {
		margin-top: 18px;
		font-size: 0.78rem;
		color: var(--text-faint);
		text-align: right;
	}
</style>
