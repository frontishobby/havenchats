<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		comboToCode,
		entryUrl,
		entryAlt,
		hasScenes,
		isGrid,
		isNamed,
		isLocalSet,
		localSceneKey,
		namedUrl
	} from '$lib/imageCodes';
	import { localSceneURL } from '$lib/import/localImages';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const character = $derived(data.character);
	const set = $derived(character.imageSet);
	const hasAssets = $derived(hasScenes(set));
	// 로컬(IndexedDB) 세트면 R2 URL 대신 blob URL 로 렌더.
	const local = $derived(isLocalSet(set));

	function letter(i: number): string {
		return String.fromCharCode(65 + i);
	}

	function back() {
		history.length > 1 ? history.back() : goto('/');
	}

	// 확대 보기(라이트박스) — 클릭한 이미지의 src·alt 를 담는다.
	let zoom = $state<{ src: string; alt: string } | null>(null);

	function openZoom(src: string, alt: string) {
		zoom = { src, alt };
	}

	// 로컬(IndexedDB) 이미지는 blob URL 을 먼저 풀어서 연다.
	async function openLocalZoom(key: string, alt: string) {
		const url = await localSceneURL(key);
		if (url) zoom = { src: url, alt };
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') zoom = null;
	}
</script>

<svelte:head>
	<title>{character.name} · 에셋</title>
</svelte:head>

<svelte:window onkeydown={onKey} />

<div class="page">
	<button class="back" onclick={back}>← 돌아가기</button>

	<header class="head">
		<h1>{character.name}</h1>
		{#if character.contentRating === 'nsfw'}<NsfwBadge size={18} />{/if}
		<span class="sub">장면 이미지 에셋</span>
	</header>

	{#if !hasAssets || !set}
		<p class="empty">이 캐릭터엔 등록된 장면 이미지가 없어요.</p>
	{:else if isGrid(set)}
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
					<button
						class="img"
						type="button"
						onclick={() => openZoom(entryUrl(character.id, entry, character.updatedAt), entryAlt(set, entry))}
						aria-label={`${entryAlt(set, entry)} 확대 보기`}
					>
						<img src={entryUrl(character.id, entry, character.updatedAt)} alt={entryAlt(set, entry)} loading="lazy" />
						<span class="code">{comboToCode(entry.combo)}</span>
					</button>
					<figcaption>{entryAlt(set, entry)}</figcaption>
				</figure>
			{/each}
		</section>

		<p class="count">{set.entries.length}개 조합</p>
	{:else if isNamed(set)}
		<!-- 플랫 네임드 갤러리 -->
		<section class="grid">
			{#each set.images as img (img.id)}
				<figure class="card">
					{#if local}
						<button
							class="img"
							type="button"
							onclick={() => openLocalZoom(localSceneKey(character.id, img.id), img.name)}
							aria-label={`${img.name} 확대 보기`}
						>
							{#await localSceneURL(localSceneKey(character.id, img.id)) then url}
								{#if url}<img src={url} alt={img.name} loading="lazy" />{/if}
							{/await}
						</button>
					{:else}
						<button
							class="img"
							type="button"
							onclick={() => openZoom(namedUrl(character.id, img, character.updatedAt), img.name)}
							aria-label={`${img.name} 확대 보기`}
						>
							<img src={namedUrl(character.id, img, character.updatedAt)} alt={img.name} loading="lazy" />
						</button>
					{/if}
					<figcaption>{img.name}</figcaption>
				</figure>
			{/each}
		</section>

		<p class="count">{set.images.length}장</p>
	{/if}
</div>

{#if zoom}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="lightbox" onclick={() => (zoom = null)} role="presentation">
		<button class="lb-close" onclick={() => (zoom = null)} aria-label="닫기">✕</button>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<img class="lb-img" src={zoom.src} alt={zoom.alt} onclick={(e) => e.stopPropagation()} />
		{#if zoom.alt}<span class="lb-caption">{zoom.alt}</span>{/if}
	</div>
{/if}

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
		display: block;
		width: 100%;
		aspect-ratio: 1;
		padding: 0;
		border: none;
		background: var(--bg-elev);
		cursor: zoom-in;
	}
	.img img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: opacity 0.15s ease;
	}
	.img:hover img {
		opacity: 0.85;
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

	/* 확대 보기(라이트박스) */
	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: grid;
		place-items: center;
		padding: 32px;
		background: rgba(0, 0, 0, 0.82);
		cursor: zoom-out;
	}
	/* 블러를 가상요소로 분리 — 확대 이미지가 합성 레이어에 묶여 저품질 축소되는 것 방지 */
	.lightbox::before {
		content: '';
		position: fixed;
		inset: 0;
		backdrop-filter: blur(4px);
		pointer-events: none;
	}
	.lb-img {
		max-width: 100%;
		max-height: calc(100vh - 64px);
		object-fit: contain;
		border-radius: var(--radius-sm);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
		cursor: default;
	}
	.lb-close {
		position: fixed;
		top: 16px;
		right: 16px;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: none;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.12);
		color: #fff;
		font-size: 1.1rem;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.lb-close:hover {
		background: rgba(255, 255, 255, 0.24);
	}
	.lb-caption {
		position: fixed;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		max-width: 90vw;
		padding: 6px 14px;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		font-size: 0.82rem;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
