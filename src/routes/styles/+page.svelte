<script lang="ts">
	import { invalidate } from '$app/navigation';
	import StyleWorkshopModal from '$lib/components/StyleWorkshopModal.svelte';
	import { resized } from '$lib/imageUrl';
	import type { ArtStyle } from '$lib/types';
	import { getNaiModel } from '$lib/naiModels';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 1인 모드: 그림체는 전부 '내 것'. Hub 공유·즐겨찾기 개념 없이 한 목록.
	const list = $derived(data.saved);

	let workshopOpen = $state(false);
	let editing = $state<ArtStyle | null>(null); // 워크숍 수정 대상
	$effect(() => {
		if (!workshopOpen) editing = null;
	});
	let selected = $state<ArtStyle | null>(null);
	let busy = $state<string | null>(null);
	let promptOpen = $state(false);

	function openDetail(s: ArtStyle) {
		selected = s;
		promptOpen = false;
	}

	function openWorkshop() {
		workshopOpen = true;
	}

	function editStyle(s: ArtStyle) {
		editing = s;
		selected = null;
		workshopOpen = true;
	}

	async function remove(s: ArtStyle) {
		if (!confirm(`'${s.title}' 그림체를 삭제할까요? 되돌릴 수 없습니다.`)) return;
		busy = s.id;
		try {
			const res = await fetch(`/api/styles/${s.id}`, { method: 'DELETE' });
			if (res.ok) {
				if (selected?.id === s.id) selected = null;
				await invalidate('app:styles');
			}
		} finally {
			busy = null;
		}
	}

	async function onPublished() {
		await invalidate('app:styles');
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && selected) selected = null;
	}
</script>

<svelte:head><title>그림체 — Haven</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="hub">
	<header class="hub-head">
		<div>
			<h1>그림체</h1>
			<p>화풍 프롬프트를 깎아 저장하면 채팅 이미지 생성·캐릭터 썸네일에서 고를 수 있어요.</p>
		</div>
		<button class="craft-btn" onclick={openWorkshop}>✦ 그림체 깎기</button>
	</header>

	{#if list.length === 0}
		<p class="empty">저장한 그림체가 없어요. 그림체를 깎아 저장해보세요!</p>
	{:else}
		<div class="grid">
			{#each list as s (s.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="card" onclick={() => openDetail(s)} role="button" tabindex="0">
					<div class="thumb">
						{#if s.thumbnailUrl}
							<img src={resized(s.thumbnailUrl, 480)} alt={s.title} loading="lazy" />
						{:else}
							<span class="no-thumb">✦</span>
						{/if}
						<span class="ver-badge" class:legacy={getNaiModel(s.model).version !== 'v5'}>{getNaiModel(s.model).short}</span>
					</div>
					<div class="meta">
						<strong>{s.title}</strong>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if selected}
	{@const s = selected}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={() => (selected = null)} role="presentation">
		<div class="detail" role="dialog" aria-modal="true" aria-label={s.title} tabindex="-1" onclick={(e) => e.stopPropagation()}>
			<button class="close" onclick={() => (selected = null)} aria-label="닫기">✕</button>
			<div class="detail-thumb">
				{#if s.thumbnailUrl}<img src={s.thumbnailUrl} alt={s.title} />{:else}<span class="no-thumb">✦</span>{/if}
			</div>
			<div class="detail-body">
				<div class="detail-title">
					<h2>{s.title}</h2>
					<span class="ver-tag" class:legacy={getNaiModel(s.model).version !== 'v5'}>{getNaiModel(s.model).label}</span>
				</div>
				{#if s.memo}<p class="memo">{s.memo}</p>{/if}
				<button
					class="prompt-toggle"
					onclick={() => (promptOpen = !promptOpen)}
					aria-expanded={promptOpen}
				>
					<span>그림체 프롬프트</span>
					<span class="chev" class:open={promptOpen}>›</span>
				</button>
				{#if promptOpen}
					<pre class="prompt">{s.prompt}</pre>
					{#if s.quality}
						<div class="prompt-sub">퀄리티</div>
						<pre class="prompt">{s.quality}</pre>
					{/if}
					{#if s.negative}
						<div class="prompt-sub">네거티브</div>
						<pre class="prompt">{s.negative}</pre>
					{/if}
				{/if}
				<div class="detail-actions">
					<button class="edit-btn" onclick={() => editStyle(s)} disabled={busy === s.id}>수정</button>
					<button class="del-btn" onclick={() => remove(s)} disabled={busy === s.id}>삭제</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<StyleWorkshopModal bind:open={workshopOpen} edit={editing} {onPublished} />

<style>
	.hub {
		max-width: 1100px;
		margin: 0 auto;
		padding: 24px 20px 60px;
	}
	.hub-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 22px;
	}
	.hub-head h1 {
		margin: 0 0 4px;
		font-size: 1.5rem;
		font-weight: 800;
	}
	.hub-head p {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.craft-btn {
		flex-shrink: 0;
		padding: 10px 18px;
		border: none;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.88rem;
	}
	.craft-btn:hover {
		background: var(--accent-hover);
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 60px 0;
	}
	/* 그림체가 깎인 NovelAI 모델 세대 배지(카드 우하단). 구세대(V4.5)는 흐리게. */
	.ver-badge {
		position: absolute;
		right: 6px;
		bottom: 6px;
		font-size: 0.62rem;
		font-weight: 800;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		letter-spacing: 0.02em;
	}
	.ver-badge.legacy {
		background: rgba(0, 0, 0, 0.55);
		color: rgba(255, 255, 255, 0.8);
		backdrop-filter: blur(2px);
	}
	.ver-tag {
		flex-shrink: 0;
		font-size: 0.68rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 6px;
		border: 1px solid var(--accent);
		color: var(--accent);
	}
	.ver-tag.legacy {
		border-color: var(--border);
		color: var(--text-faint);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 16px;
	}
	.card {
		cursor: pointer;
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--bg-card);
		border: 1px solid var(--border);
		transition: border-color 0.15s ease, transform 0.1s ease;
	}
	.card:hover {
		border-color: var(--accent);
		transform: translateY(-2px);
	}
	.thumb {
		position: relative;
		aspect-ratio: 832 / 1216;
		background: var(--bg-elev);
		display: grid;
		place-items: center;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.no-thumb {
		font-size: 2rem;
		color: var(--text-faint);
	}
	.meta {
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.meta strong {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* 상세 모달 */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 110;
		background: rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.detail {
		position: relative;
		display: flex;
		gap: 18px;
		width: 100%;
		max-width: 640px;
		max-height: calc(100dvh - 40px);
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
	}
	@media (max-width: 560px) {
		.detail {
			flex-direction: column;
		}
	}
	.close {
		position: absolute;
		top: 10px;
		right: 10px;
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		z-index: 1;
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
	.detail-thumb {
		flex: 0 0 240px;
		align-self: flex-start;
		aspect-ratio: 832 / 1216;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--bg-elev);
		display: grid;
		place-items: center;
	}
	@media (max-width: 560px) {
		.detail-thumb {
			flex: none;
			max-width: 240px;
		}
	}
	.detail-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.detail-body {
		flex: 1;
		min-width: 0;
	}
	.detail-body h2 {
		margin: 0 0 4px;
		font-size: 1.2rem;
		font-weight: 800;
	}
	.memo {
		margin: 12px 0 0;
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--text-dim);
	}
	.detail-title {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.prompt-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		margin-top: 16px;
		padding: 8px 0;
		background: none;
		border: none;
		border-top: 1px solid var(--border);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
	}
	.prompt-toggle .chev {
		font-size: 1.1rem;
		color: var(--text-dim);
		transition: transform 0.15s ease;
		line-height: 1;
	}
	.prompt-toggle .chev.open {
		transform: rotate(90deg);
	}
	.prompt-sub {
		margin-top: 8px;
		font-size: 0.72rem;
		color: var(--text-dim, #999);
	}
	.prompt {
		margin: 4px 0 0;
		padding: 10px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 220px;
		overflow-y: auto;
	}
	.detail-actions {
		display: flex;
		gap: 10px;
		margin-top: 16px;
	}
	.edit-btn {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-dim);
		font-weight: 700;
		font-size: 0.85rem;
	}
	.edit-btn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--text-dim);
	}
	.del-btn {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-dim);
		font-weight: 700;
		font-size: 0.85rem;
	}
	.del-btn:hover {
		color: var(--nsfw, #f59e0b);
		border-color: var(--nsfw, #f59e0b);
	}

	/* 모바일: 여백을 줄여 폭·높이를 더 쓴다 */
	@media (max-width: 640px) {
		.backdrop {
			padding: 10px;
		}
		.detail {
			padding: 16px 14px;
			max-height: calc(100dvh - 20px);
			border-radius: 14px;
		}
	}
</style>
