<script lang="ts">
	import { invalidate } from '$app/navigation';
	import ModuleEditorModal from '$lib/components/ModuleEditorModal.svelte';
	import type { PromptModule } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 1인 모드: 모듈은 전부 '내 것'. Hub 공유·즐겨찾기 개념 없이 한 목록.
	const list = $derived(data.saved);

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
		editing = m;
		selected = null;
		editorOpen = true;
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
	/** 카드 미리보기용 본문 앞부분. */
	const preview = (m: PromptModule) => m.prompt.replace(/\s+/g, ' ').trim();
</script>

<svelte:head><title>모듈 — Haven</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="hub">
	<header class="hub-head">
		<div>
			<h1>모듈</h1>
			<p>출력 규칙 같은 재사용 지침을 만들어 두고 채팅에서 여러 개 골라 적용하세요.</p>
		</div>
		<button class="craft-btn" onclick={() => openEditor()}>✦ 모듈 만들기</button>
	</header>

	{#if list.length === 0}
		<p class="empty">만든 모듈이 없어요. 첫 모듈을 만들어보세요!</p>
	{:else}
		<div class="grid">
			{#each list as m (m.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="card" onclick={() => openDetail(m)} role="button" tabindex="0">
					<div class="card-top">
						<strong class="title">{m.title}</strong>
					</div>
					{#if m.memo}<p class="memo">{m.memo}</p>{/if}
					<p class="preview">{preview(m)}</p>
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
			</div>
			{#if m.memo}<p class="detail-memo">{m.memo}</p>{/if}
			<div class="prompt-sub">모듈 본문</div>
			<pre class="prompt">{m.prompt}</pre>
			<div class="detail-actions">
				<button class="edit-btn" onclick={() => openEditor(m)} disabled={busy === m.id}>수정</button>
				<button class="del-btn" onclick={() => remove(m)} disabled={busy === m.id}>삭제</button>
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
