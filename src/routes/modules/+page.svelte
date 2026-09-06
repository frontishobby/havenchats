<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { openLogin } from '$lib/state/loginModal.svelte';
	import ModuleEditorModal from '$lib/components/ModuleEditorModal.svelte';
	import type { PromptModule } from '$lib/types';
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

	let editorOpen = $state(false);
	let editing = $state<PromptModule | null>(null);
	$effect(() => {
		if (!editorOpen) editing = null;
	});
	let selected = $state<PromptModule | null>(null);
	let busy = $state<string | null>(null);

	function openDetail(m: PromptModule) {
		selected = m;
	}
	function openEditor(m: PromptModule | null = null) {
		if (!me?.user) {
			openLogin();
			return;
		}
		editing = m;
		selected = null;
		editorOpen = true;
	}

	async function setShared(m: PromptModule, shared: boolean) {
		if (busy === m.id) return;
		busy = m.id;
		if (selected?.id === m.id) selected = { ...selected, shared };
		try {
			const res = await fetch(`/api/modules/${m.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ shared })
			});
			if (res.ok) await invalidate('app:modules');
			else if (selected?.id === m.id) selected = { ...selected, shared: !shared };
		} catch {
			if (selected?.id === m.id) selected = { ...selected, shared: !shared };
		} finally {
			busy = null;
		}
	}

	async function toggleFav(m: PromptModule, e?: Event) {
		e?.stopPropagation();
		if (!me?.user) {
			openLogin();
			return;
		}
		if (busy === m.id) return;
		busy = m.id;
		const next = !m.favorited;
		if (selected?.id === m.id) selected = { ...selected, favorited: next };
		try {
			const res = await fetch(`/api/modules/${m.id}/favorite`, { method: next ? 'POST' : 'DELETE' });
			if (res.ok) await invalidate('app:modules');
			else if (selected?.id === m.id) selected = { ...selected, favorited: !next };
		} catch {
			if (selected?.id === m.id) selected = { ...selected, favorited: !next };
		} finally {
			busy = null;
		}
	}

	async function remove(m: PromptModule) {
		if (!confirm(`'${m.title}' 모듈을 삭제할까요? 되돌릴 수 없습니다.`)) return;
		busy = m.id;
		try {
			const res = await fetch(`/api/modules/${m.id}`, { method: 'DELETE' });
			if (res.ok) {
				if (selected?.id === m.id) selected = null;
				await invalidate('app:modules');
			}
		} finally {
			busy = null;
		}
	}

	async function onSaved() {
		await invalidate('app:modules');
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && selected) selected = null;
	}
	const isOwner = (m: PromptModule) => !!me?.user && me?.user.id === m.creatorId;
	const emptyText = $derived(
		tab === 'favorites'
			? '즐겨찾기한 모듈이 없어요. 카드의 ★ 를 눌러 추가하세요.'
			: tab === 'saved'
				? '만든 모듈이 없어요. 첫 모듈을 만들어보세요!'
				: '아직 공유된 모듈이 없어요. 첫 모듈을 만들어보세요!'
	);
	/** 카드 미리보기용 본문 앞부분. */
	const preview = (m: PromptModule) => m.prompt.replace(/\s+/g, ' ').trim();
</script>

<svelte:head><title>모듈 Hub — Haven</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="hub">
	<header class="hub-head">
		<div>
			<h1>모듈 Hub</h1>
			<p>출력 규칙 같은 재사용 지침을 공유·즐겨찾기해 채팅에서 여러 개 골라 적용하세요.</p>
		</div>
		<button class="craft-btn" onclick={() => openEditor()}>✦ 모듈 만들기</button>
	</header>

	<div class="tabs" role="tablist">
		<button class="tab" class:active={tab === 'shared'} role="tab" onclick={() => (tab = 'shared')}>
			공유됨
		</button>
		{#if me?.user}
			<button class="tab" class:active={tab === 'favorites'} role="tab" onclick={() => (tab = 'favorites')}>
				즐겨찾기 {data.favorites.length > 0 ? `(${data.favorites.length})` : ''}
			</button>
			<button class="tab" class:active={tab === 'saved'} role="tab" onclick={() => (tab = 'saved')}>
				내 모듈 {data.saved.length > 0 ? `(${data.saved.length})` : ''}
			</button>
		{/if}
	</div>

	{#if list.length === 0}
		<p class="empty">{emptyText}</p>
	{:else}
		<div class="grid">
			{#each list as m (m.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="card" onclick={() => openDetail(m)} role="button" tabindex="0">
					<div class="card-top">
						<strong class="title">{m.title}</strong>
						<button
							class="fav"
							class:on={m.favorited}
							onclick={(e) => toggleFav(m, e)}
							aria-label="즐겨찾기"
							title="즐겨찾기"
						>
							{m.favorited ? '★' : '☆'}
						</button>
					</div>
					{#if m.memo}<p class="memo">{m.memo}</p>{/if}
					<p class="preview">{preview(m)}</p>
					<div class="card-foot">
						<span class="by">{m.creatorName ?? '익명'}</span>
						{#if !m.shared}<span class="priv-badge">비공개</span>{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if selected}
	{@const m = selected}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={() => (selected = null)} role="presentation">
		<div class="detail" role="dialog" aria-modal="true" aria-label={m.title} tabindex="-1" onclick={(e) => e.stopPropagation()}>
			<button class="close" onclick={() => (selected = null)} aria-label="닫기">✕</button>
			<div class="detail-title">
				<h2>{m.title}</h2>
				{#if !m.shared}<span class="priv-tag">비공개</span>{/if}
			</div>
			<a class="by-link" href="/user/{m.creatorId}">{m.creatorName ?? '익명'}</a>
			{#if m.memo}<p class="detail-memo">{m.memo}</p>{/if}
			<div class="prompt-sub">모듈 본문</div>
			<pre class="prompt">{m.prompt}</pre>
			<div class="detail-actions">
				{#if isOwner(m)}
					{#if !m.shared}
						<button class="share-btn" onclick={() => setShared(m, true)} disabled={busy === m.id}>Hub에 공개</button>
					{:else}
						<button class="edit-btn" onclick={() => setShared(m, false)} disabled={busy === m.id}>비공개로</button>
					{/if}
					<button class="edit-btn" onclick={() => openEditor(m)} disabled={busy === m.id}>수정</button>
					<button class="del-btn" onclick={() => remove(m)} disabled={busy === m.id}>삭제</button>
				{:else}
					<button class="fav-btn" class:on={m.favorited} onclick={() => toggleFav(m)} disabled={busy === m.id}>
						{m.favorited ? '★ 즐겨찾기됨' : '☆ 즐겨찾기'}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<ModuleEditorModal bind:open={editorOpen} edit={editing} {onSaved} />

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
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 14px;
	}
	.card {
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 14px;
		border-radius: var(--radius);
		background: var(--bg-card);
		border: 1px solid var(--border);
		transition: border-color 0.15s ease, transform 0.1s ease;
		min-width: 0;
	}
	.card:hover {
		border-color: var(--accent);
		transform: translateY(-2px);
	}
	.card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.title {
		font-size: 0.95rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fav {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: 50%;
		background: var(--bg-elev);
		color: #ffd34d;
		font-size: 0.95rem;
		line-height: 1;
	}
	.fav:hover {
		background: var(--border);
	}
	.memo {
		margin: 0;
		font-size: 0.78rem;
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.preview {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.45;
		color: var(--text-faint);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.card-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 4px;
	}
	.by {
		font-size: 0.74rem;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.priv-badge,
	.priv-tag {
		font-size: 0.64rem;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		color: var(--text-dim);
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
		width: 100%;
		max-width: 560px;
		max-height: calc(100dvh - 40px);
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
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
	.detail-title {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-right: 32px;
	}
	.detail-title h2 {
		margin: 0 0 4px;
		font-size: 1.2rem;
		font-weight: 800;
	}
	.by-link {
		font-size: 0.82rem;
		color: var(--accent);
	}
	.detail-memo {
		margin: 12px 0 0;
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--text-dim);
	}
	.prompt-sub {
		margin-top: 16px;
		font-size: 0.72rem;
		color: var(--text-dim);
	}
	.prompt {
		margin: 4px 0 0;
		padding: 10px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 320px;
		overflow-y: auto;
	}
	.detail-actions {
		display: flex;
		gap: 10px;
		margin-top: 16px;
		flex-wrap: wrap;
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
	.edit-btn,
	.del-btn {
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
