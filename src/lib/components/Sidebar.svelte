<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import type { RecentChat } from '$lib/types';

	let {
		open = false,
		chats = [],
		onClose
	}: { open: boolean; chats: RecentChat[]; onClose: () => void } = $props();

	/** 상대 시각: 방금 / N분 전 / N시간 전 / N일 전 / 날짜. */
	function relTime(ts: number | null): string {
		if (!ts) return '';
		const diff = Date.now() - ts;
		const m = Math.floor(diff / 60000);
		if (m < 1) return '방금';
		if (m < 60) return `${m}분 전`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}시간 전`;
		const d = Math.floor(h / 24);
		if (d < 7) return `${d}일 전`;
		const date = new Date(ts);
		return `${date.getMonth() + 1}/${date.getDate()}`;
	}
</script>

{#if open}
	<!-- 오버레이 -->
	<div
		class="overlay"
		transition:fade={{ duration: 150 }}
		onclick={onClose}
		role="presentation"
	></div>

	<aside class="sidebar" transition:fly={{ x: -320, duration: 200 }}>
		<header class="head">
			<span class="title">최근 채팅</span>
			<button class="close" onclick={onClose} aria-label="닫기">✕</button>
		</header>

		{#if chats.length === 0}
			<div class="empty">아직 시작한 대화가 없어요.</div>
		{:else}
			<nav class="list">
				{#each chats as c (c.sessionId)}
					<a
						class="item"
						href={`/chat/${c.characterId}?s=${c.sessionId}`}
						onclick={onClose}
					>
						<img class="thumb" src={c.avatarUrl} alt={c.characterName} loading="lazy" />
						<div class="meta">
							<div class="top">
								<span class="name">{c.characterName}</span>
								<span class="time">{relTime(c.lastMessageAt)}</span>
							</div>
							<div class="preview">{c.preview || '…'}</div>
						</div>
					</a>
				{/each}
			</nav>
		{/if}
	</aside>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: rgba(0, 0, 0, 0.5);
	}
	.sidebar {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 50;
		width: 320px;
		max-width: 85vw;
		height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--bg-card);
		border-right: 1px solid var(--border);
		box-shadow: 4px 0 32px rgba(0, 0, 0, 0.4);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 16px;
		height: 60px;
		flex-shrink: 0;
		border-bottom: 1px solid var(--border);
	}
	.title {
		font-weight: 700;
		font-size: 1rem;
	}
	.close {
		background: transparent;
		border: none;
		color: var(--text-faint);
		font-size: 1rem;
		padding: 6px;
		border-radius: 8px;
		transition: background 0.12s ease;
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
	.empty {
		padding: 32px 20px;
		color: var(--text-faint);
		font-size: 0.88rem;
		text-align: center;
	}
	.list {
		flex: 1;
		overflow-y: auto;
		padding: 6px;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px;
		border-radius: var(--radius-sm);
		transition: background 0.12s ease;
	}
	.item:hover {
		background: var(--bg-elev);
	}
	.thumb {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
		background: var(--bg-elev);
	}
	.meta {
		min-width: 0;
		flex: 1;
	}
	.top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.name {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.time {
		flex-shrink: 0;
		font-size: 0.72rem;
		color: var(--text-faint);
	}
	.preview {
		margin-top: 2px;
		font-size: 0.82rem;
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
