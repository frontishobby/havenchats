<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { openLogin } from '$lib/state/loginModal.svelte';
	import StyleWorkshopModal from '$lib/components/StyleWorkshopModal.svelte';
	import { resized } from '$lib/imageUrl';
	import type { ArtStyle } from '$lib/types';
	import { getNaiModel } from '$lib/naiModels';
	import type { MeData } from '$lib/api/pages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 유저 정보는 layout 이 promise(data.me)로 흘려보내므로 여기서 풀어서 쓴다(로그인 게이팅용).
	let me = $state<MeData | null>(null);
	$effect(() => {
		const p = data.me;
		let cancelled = false;
		p.then((m) => {
			if (!cancelled) me = m;
		}).catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	type Tab = 'shared' | 'favorites' | 'saved';
	let tab = $state<Tab>('shared');

	const list = $derived(
		tab === 'favorites' ? data.favorites : tab === 'saved' ? data.saved : data.shared
	);

	let workshopOpen = $state(false);
	let selected = $state<ArtStyle | null>(null);
	let busy = $state<string | null>(null);
	let promptOpen = $state(false);

	function openDetail(s: ArtStyle) {
		selected = s;
		promptOpen = false;
	}

	async function shareStyle(s: ArtStyle) {
		if (busy === s.id) return;
		busy = s.id;
		if (selected?.id === s.id) selected = { ...selected, shared: true };
		try {
			const res = await fetch(`/api/styles/${s.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ shared: true })
			});
			if (res.ok) await invalidate('app:styles');
			else if (selected?.id === s.id) selected = { ...selected, shared: false };
		} catch {
			if (selected?.id === s.id) selected = { ...selected, shared: false };
		} finally {
			busy = null;
		}
	}

	function openWorkshop() {
		if (!me?.user) {
			openLogin();
			return;
		}
		workshopOpen = true;
	}

	async function toggleFav(s: ArtStyle, e?: Event) {
		e?.stopPropagation();
		if (!me?.user) {
			openLogin();
			return;
		}
		if (busy === s.id) return;
		busy = s.id;
		const next = !s.favorited;
		if (selected?.id === s.id) selected = { ...selected, favorited: next };
		try {
			const res = await fetch(`/api/styles/${s.id}/favorite`, { method: next ? 'POST' : 'DELETE' });
			if (res.ok) await invalidate('app:styles');
			else if (selected?.id === s.id) selected = { ...selected, favorited: !next };
		} catch {
			if (selected?.id === s.id) selected = { ...selected, favorited: !next };
		} finally {
			busy = null;
		}
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
	const isOwner = (s: ArtStyle) => !!me?.user && me?.user.id === s.creatorId;
	const emptyText = $derived(
		tab === 'favorites'
			? '즐겨찾기한 그림체가 없어요. 카드의 ★ 를 눌러 추가하세요.'
			: tab === 'saved'
				? '저장한 그림체가 없어요. 그림체를 깎아 저장해보세요!'
				: '아직 공유된 그림체가 없어요. 첫 그림체를 깎아보세요!'
	);
</script>

<svelte:head><title>그림체 Hub — Haven</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="hub">
	<header class="hub-head">
		<div>
			<h1>그림체 Hub</h1>
			<p>공유된 그림체를 즐겨찾기·저장해 채팅 이미지 생성에 사용하세요.</p>
		</div>
		<button class="craft-btn" onclick={openWorkshop}>✦ 그림체 깎기</button>
	</header>

	<div class="tabs" role="tablist">
		<button class="tab" class:active={tab === 'shared'} role="tab" onclick={() => (tab = 'shared')}>
			공유됨
		</button>
		{#if me?.user}
			<button
				class="tab"
				class:active={tab === 'favorites'}
				role="tab"
				onclick={() => (tab = 'favorites')}
			>
				즐겨찾기 {data.favorites.length > 0 ? `(${data.favorites.length})` : ''}
			</button>
			<button class="tab" class:active={tab === 'saved'} role="tab" onclick={() => (tab = 'saved')}>
				저장 {data.saved.length > 0 ? `(${data.saved.length})` : ''}
			</button>
		{/if}
	</div>

	{#if list.length === 0}
		<p class="empty">{emptyText}</p>
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
						<button
							class="fav"
							class:on={s.favorited}
							onclick={(e) => toggleFav(s, e)}
							aria-label="즐겨찾기"
							title="즐겨찾기"
						>
							{s.favorited ? '★' : '☆'}
						</button>
						{#if !s.shared}<span class="priv-badge">비공개</span>{/if}
						<span class="ver-badge" class:legacy={getNaiModel(s.model).version !== 'v5'}>{getNaiModel(s.model).short}</span>
					</div>
					<div class="meta">
						<strong>{s.title}</strong>
						<span class="by">{s.creatorName ?? '익명'}</span>
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
					{#if !s.shared}<span class="priv-tag">비공개</span>{/if}
				</div>
				<a class="by-link" href="/user/{s.creatorId}">{s.creatorName ?? '익명'}</a>
				{#if s.memo}<p class="memo">{s.memo}</p>{/if}
				<button
					class="prompt-toggle"
					onclick={() => (promptOpen = !promptOpen)}
					aria-expanded={promptOpen}
				>
					<span>그림체 프롬프트</span>
					<span class="chev" class:open={promptOpen}>›</span>
				</button>
				{#if promptOpen}<pre class="prompt">{s.prompt}</pre>{/if}
				<div class="detail-actions">
					{#if isOwner(s)}
						{#if !s.shared}
							<button class="share-btn" onclick={() => shareStyle(s)} disabled={busy === s.id}>
								Hub에 공유
							</button>
						{/if}
						<button class="del-btn" onclick={() => remove(s)} disabled={busy === s.id}>삭제</button>
					{:else}
						<button
							class="fav-btn"
							class:on={s.favorited}
							onclick={() => toggleFav(s)}
							disabled={busy === s.id}
						>
							{s.favorited ? '★ 즐겨찾기됨' : '☆ 즐겨찾기'}
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<StyleWorkshopModal bind:open={workshopOpen} {onPublished} />

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
	.tabs {
		display: flex;
		gap: 6px;
		margin-bottom: 18px;
		border-bottom: 1px solid var(--border);
	}
	.tab {
		padding: 8px 14px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-dim);
		font-size: 0.88rem;
		font-weight: 600;
		margin-bottom: -1px;
	}
	.tab:hover {
		color: var(--text);
	}
	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 60px 0;
	}
	.priv-badge {
		position: absolute;
		left: 6px;
		top: 6px;
		font-size: 0.64rem;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		backdrop-filter: blur(2px);
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
	.fav {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.45);
		color: #ffd34d;
		font-size: 1rem;
		line-height: 1;
		backdrop-filter: blur(2px);
	}
	.fav.on {
		color: #ffd34d;
	}
	.fav:hover {
		background: rgba(0, 0, 0, 0.65);
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
	.meta .by {
		font-size: 0.74rem;
		color: var(--text-faint);
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
	.by-link {
		font-size: 0.82rem;
		color: var(--accent);
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
	.priv-tag {
		font-size: 0.66rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		color: var(--text-dim);
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
	.fav-btn {
		flex: 1;
		padding: 10px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		font-weight: 700;
		font-size: 0.85rem;
	}
	.fav-btn.on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
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
	.share-btn {
		flex: 1;
		padding: 10px;
		border-radius: var(--radius-sm);
		border: none;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.85rem;
	}
	.share-btn:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.share-btn:disabled {
		opacity: 0.5;
	}
</style>
