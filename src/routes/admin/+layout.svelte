<script lang="ts">
	import { page } from '$app/stores';

	let { children } = $props();

	const tabs = [
		{ href: '/admin', label: '유저' },
		{ href: '/admin/stats', label: '사용 통계' }
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
		<h1>관리자</h1>
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
	.admin-head h1 {
		margin: 0 0 16px;
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: -0.01em;
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
