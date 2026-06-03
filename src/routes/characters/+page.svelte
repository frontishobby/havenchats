<script lang="ts">
	import { goto } from '$app/navigation';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import type { Character } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 로컬에서 즉시 제거할 수 있도록 복사본 유지.
	let items = $state<Character[]>(data.characters);
	let deleting = $state<string | null>(null);

	function edit(c: Character) {
		goto(`/characters/${c.id}/edit`);
	}

	async function remove(c: Character) {
		if (deleting) return;
		if (!confirm(`'${c.name}' 캐릭터를 삭제할까요? 되돌릴 수 없어요.`)) return;
		deleting = c.id;
		try {
			const res = await fetch(`/api/characters/${c.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			items = items.filter((x) => x.id !== c.id);
		} catch {
			alert('삭제에 실패했어요. 잠시 후 다시 시도해 주세요.');
		} finally {
			deleting = null;
		}
	}
</script>

<svelte:head>
	<title>캐릭터 관리 — Haven</title>
</svelte:head>

<div class="manage">
	<a class="back" href="/">← 탐색으로</a>

	<header class="head">
		<h1>캐릭터 관리</h1>
		<p class="sub">내가 만든 캐릭터예요. 눌러서 수정하거나 새 캐릭터를 만들 수 있어요.</p>
	</header>

	<a class="create-btn" href="/create">+ 캐릭터 만들기</a>

	{#if items.length === 0}
		<div class="empty">
			<span class="empty-icon">✦</span>
			<p>아직 만든 캐릭터가 없어요.</p>
			<span class="empty-sub">위 버튼으로 첫 캐릭터를 만들어보세요.</span>
		</div>
	{:else}
		<ul class="list">
			{#each items as c (c.id)}
				<li class="row">
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
					<button class="row-main" type="button" onclick={() => edit(c)}>
						<img class="thumb" src={c.avatarUrl} alt={c.name} />
						<span class="info">
							<span class="name-line">
								<span class="name">{c.name}</span>
								{#if c.contentRating === 'nsfw'}<NsfwBadge size={15} />{/if}
							</span>
							<span class="tagline">{c.tagline}</span>
							<span class="meta">💬 {c.chats}</span>
						</span>
						<span class="edit-hint">수정 ›</span>
					</button>
					<button
						class="del"
						type="button"
						onclick={() => remove(c)}
						disabled={deleting === c.id}
						aria-label="캐릭터 삭제"
					>
						{deleting === c.id ? '…' : '🗑'}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.manage {
		max-width: 640px;
		margin: 0 auto;
		padding: 28px 20px 80px;
	}
	.back {
		display: inline-block;
		color: var(--text-dim);
		font-size: 0.88rem;
		margin-bottom: 24px;
	}
	.back:hover {
		color: var(--text);
	}
	.head {
		margin-bottom: 20px;
	}
	.head h1 {
		margin: 0 0 6px;
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.sub {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.9rem;
		line-height: 1.6;
	}

	.create-btn {
		display: block;
		width: 100%;
		margin-bottom: 22px;
		padding: 13px;
		text-align: center;
		border: 1px dashed var(--accent);
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 700;
		font-size: 0.92rem;
		transition: background 0.15s ease;
	}
	.create-btn:hover {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}

	.empty {
		text-align: center;
		padding: 56px 0;
		color: var(--text-faint);
	}
	.empty-icon {
		display: block;
		font-size: 2rem;
		color: var(--accent);
		margin-bottom: 10px;
	}
	.empty p {
		margin: 0 0 4px;
		color: var(--text-dim);
		font-size: 0.95rem;
	}
	.empty-sub {
		font-size: 0.82rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.row {
		display: flex;
		align-items: stretch;
		gap: 8px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
		transition: border-color 0.15s ease;
	}
	.row:hover {
		border-color: var(--text-faint);
	}
	.row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		background: transparent;
		border: none;
		text-align: left;
		cursor: pointer;
	}
	.thumb {
		width: 52px;
		height: 52px;
		border-radius: 10px;
		object-fit: cover;
		flex-shrink: 0;
	}
	.info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.name-line {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.name {
		font-weight: 700;
		font-size: 0.95rem;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tagline {
		font-size: 0.8rem;
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 0.72rem;
		color: var(--text-faint);
	}
	.edit-hint {
		flex-shrink: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--accent);
	}
	.del {
		flex-shrink: 0;
		width: 46px;
		border: none;
		border-left: 1px solid var(--border);
		background: transparent;
		color: var(--text-faint);
		font-size: 0.95rem;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.del:hover:not(:disabled) {
		background: var(--bg-elev);
		color: var(--nsfw);
	}
	.del:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
