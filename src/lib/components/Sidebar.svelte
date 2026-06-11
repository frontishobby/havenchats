<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import type { RecentChat } from '$lib/types';
	import { resized } from '$lib/imageUrl';

	let {
		open = false,
		chats = [],
		onClose,
		onDelete
	}: {
		open: boolean;
		chats: RecentChat[];
		onClose: () => void;
		onDelete: (sessionId: string) => Promise<void>;
	} = $props();

	// 삭제는 2단계: 휴지통 클릭 → 같은 항목 확인 버튼 노출 → 다시 클릭 시 삭제.
	let confirmId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);

	function askDelete(e: MouseEvent, sessionId: string) {
		e.preventDefault();
		e.stopPropagation();
		confirmId = sessionId;
	}

	async function confirmDelete(e: MouseEvent, sessionId: string) {
		e.preventDefault();
		e.stopPropagation();
		deletingId = sessionId;
		try {
			await onDelete(sessionId);
		} finally {
			deletingId = null;
			confirmId = null;
		}
	}

	function cancelDelete(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		confirmId = null;
	}

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
					<div class="row" class:confirming={confirmId === c.sessionId}>
						<a
							class="item"
							href={`/chat/${c.characterId}/session/${c.sessionId}`}
							onclick={onClose}
						>
							<img class="thumb" src={resized(c.avatarUrl, 96)} alt={c.characterName} loading="lazy" />
							<div class="meta">
								<div class="top">
									<span class="name">{c.characterName}</span>
									<span class="time">{relTime(c.lastMessageAt)}</span>
								</div>
								<div class="preview">{c.preview || '…'}</div>
							</div>
						</a>
						{#if confirmId === c.sessionId}
							<div class="confirm">
								<button
									class="confirm-btn yes"
									onclick={(e) => confirmDelete(e, c.sessionId)}
									disabled={deletingId === c.sessionId}
								>
									{deletingId === c.sessionId ? '삭제 중…' : '삭제'}
								</button>
								<button class="confirm-btn no" onclick={cancelDelete}>취소</button>
							</div>
						{:else}
							<button
								class="del"
								onclick={(e) => askDelete(e, c.sessionId)}
								aria-label="대화 삭제"
								title="대화 삭제"
							>
								×
							</button>
						{/if}
					</div>
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
	.row {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius-sm);
		transition: background 0.12s ease;
	}
	.row:hover {
		background: var(--bg-elev);
	}
	.item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px;
		flex: 1;
		min-width: 0;
	}
	/* 휴지통 버튼 — 평소 숨김, 행 hover 시 노출(터치기기는 항상 노출) */
	.del {
		flex-shrink: 0;
		width: 34px;
		height: 34px;
		margin-right: 6px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-faint);
		font-size: 1.25rem;
		line-height: 1;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			background 0.12s ease;
	}
	.row:hover .del {
		opacity: 1;
	}
	.del:hover {
		background: var(--bg-card);
		color: var(--text);
	}
	@media (pointer: coarse) {
		.del {
			opacity: 1;
		}
	}
	/* 삭제 확인 */
	.row.confirming {
		background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
	}
	.confirm {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		margin-right: 8px;
	}
	.confirm-btn {
		border: none;
		border-radius: 8px;
		padding: 6px 10px;
		font-size: 0.78rem;
		font-weight: 600;
	}
	.confirm-btn.yes {
		background: var(--danger, #ef4444);
		color: #fff;
	}
	.confirm-btn.yes:disabled {
		opacity: 0.6;
	}
	.confirm-btn.no {
		background: var(--bg-elev);
		color: var(--text-dim);
	}
	.confirm-btn.no:hover {
		color: var(--text);
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
