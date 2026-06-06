<script lang="ts">
	import { page } from '$app/stores';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	const credits = $derived(data.credits);

	const tabs = [
		{ href: '/admin', label: '유저' },
		{ href: '/admin/stats', label: '사용 통계' },
		{ href: '/admin/infra', label: '인프라' }
	];

	// 정확 일치(유저=/admin)와 접두 일치(통계=/admin/stats) 구분.
	function isActive(href: string): boolean {
		return href === '/admin' ? $page.url.pathname === '/admin' : $page.url.pathname.startsWith(href);
	}
</script>

<svelte:head>
	<title>관리자 — Haven</title>
</svelte:head>

<div class="admin">
	<header class="admin-head">
		<div class="title-row">
			<h1>관리자</h1>
			{#if credits}
				<span class="credits" title={`총 사용 $${credits.totalUsed.toFixed(2)}`}>
					<span class="credits-k">Vercel 크레딧</span>
					<span class="credits-v" class:low={credits.balance < 5}>
						${credits.balance.toFixed(2)}
					</span>
				</span>
			{/if}
		</div>
		<nav class="tabs">
			{#each tabs as t (t.href)}
				<a class="tab" class:active={isActive(t.href)} href={t.href}>{t.label}</a>
			{/each}
		</nav>
	</header>

	{@render children()}
</div>

<style>
	.admin {
		max-width: 1100px;
		margin: 0 auto;
		padding: 28px 20px 80px;
	}
	.admin-head {
		margin-bottom: 24px;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 16px;
	}
	.admin-head h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.credits {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 5px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.84rem;
	}
	.credits-k {
		color: var(--text-dim);
		font-weight: 600;
		font-size: 0.76rem;
	}
	.credits-v {
		font-weight: 800;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.credits-v.low {
		color: var(--nsfw);
	}
	.tabs {
		display: flex;
		gap: 4px;
		border-bottom: 1px solid var(--border);
	}
	.tab {
		padding: 10px 16px;
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--text-dim);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition: color 0.15s ease;
	}
	.tab:hover {
		color: var(--text);
	}
	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
</style>
