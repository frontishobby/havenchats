<script lang="ts">
	import '../app.css';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import ProfileModal from '$lib/components/ProfileModal.svelte';
	import { loginModal } from '$lib/state/loginModal.svelte';
	import { profileModal } from '$lib/state/profileModal.svelte';
	import type { LayoutData } from './$types';
	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// 최초 로그인(프로필 미완성) 시 프로필 설정 모달 자동 노출
	$effect(() => {
		if (data.user && !data.user.profileComplete) profileModal.open = true;
	});

	// 우상단 유저 메뉴(드롭다운)
	let menuOpen = $state(false);
	let menuRef = $state<HTMLDivElement | null>(null);

	function openProfileSettings() {
		profileModal.open = true;
		menuOpen = false;
	}
	function onWindowClick(e: MouseEvent) {
		if (menuOpen && menuRef && !menuRef.contains(e.target as Node)) menuOpen = false;
	}
	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape') menuOpen = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div class="app">
	<header class="topbar">
		<a class="brand" href="/">
			<span class="logo">✦</span>
			<span class="wordmark">Haven<span class="dim">chats</span></span>
		</a>
		<nav>
			<a href="/" class="nav-link">탐색</a>
			{#if data.user}
				<div class="user-menu" bind:this={menuRef}>
					<button
						class="user-name-btn"
						class:active={menuOpen}
						onclick={() => (menuOpen = !menuOpen)}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						title="메뉴"
					>
						<span class="user-fallback">
							{(data.user.name ?? data.user.email).charAt(0).toUpperCase()}
						</span>
						<span class="user-name">{data.user.name ?? '프로필 설정'}</span>
						<span class="chev">▾</span>
					</button>
					{#if menuOpen}
						<div class="menu" role="menu">
							<button class="menu-item" role="menuitem" onclick={openProfileSettings}>
								프로필 설정
							</button>
							<a
								class="menu-item"
								role="menuitem"
								href="/create"
								onclick={() => (menuOpen = false)}
							>
								캐릭터 만들기
							</a>
							<div class="menu-sep"></div>
							<a
								class="menu-item danger"
								role="menuitem"
								href="/auth/logout"
								data-sveltekit-preload-data="off"
							>
								로그아웃
							</a>
						</div>
					{/if}
				</div>
			{:else}
				<button class="login-btn" onclick={() => (loginModal.open = true)}>로그인</button>
			{/if}
		</nav>
	</header>

	<main>
		{@render children()}
	</main>
</div>

<LoginModal />
<ProfileModal user={data.user} />

<style>
	.app {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 20px;
		height: 60px;
		background: color-mix(in srgb, var(--bg) 80%, transparent);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--border);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 800;
		font-size: 1.15rem;
		letter-spacing: -0.01em;
	}
	.logo {
		color: var(--accent);
		font-size: 1.3rem;
	}
	.wordmark .dim {
		color: var(--text-faint);
		font-weight: 600;
	}
	nav {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.nav-link {
		color: var(--text-dim);
		font-size: 0.9rem;
		font-weight: 500;
	}
	.nav-link:hover {
		color: var(--text);
	}
	.login-btn {
		display: inline-block;
		background: var(--accent);
		color: #fff;
		border: none;
		font-weight: 600;
		font-size: 0.88rem;
		padding: 8px 16px;
		border-radius: 999px;
		transition: background 0.15s ease;
	}
	.login-btn:hover {
		background: var(--accent-hover);
	}
	.user-menu {
		position: relative;
	}
	.user-name-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		background: transparent;
		border: none;
		padding: 4px 10px 4px 4px;
		border-radius: 999px;
		transition: background 0.15s ease;
	}
	.user-name-btn:hover,
	.user-name-btn.active {
		background: var(--bg-card);
	}
	.chev {
		color: var(--text-faint);
		font-size: 0.7rem;
	}

	/* 드롭다운 메뉴 */
	.menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 30;
		min-width: 180px;
		padding: 6px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
	}
	.menu-item {
		display: block;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		padding: 9px 12px;
		border-radius: 8px;
		color: var(--text);
		font-size: 0.88rem;
		font-weight: 500;
		transition: background 0.12s ease;
	}
	.menu-item:hover {
		background: var(--bg-elev);
	}
	.menu-item.danger {
		color: var(--text-faint);
	}
	.menu-item.danger:hover {
		color: var(--text);
	}
	.menu-sep {
		height: 1px;
		margin: 6px 4px;
		background: var(--border);
	}
	.user-fallback {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		color: #fff;
		font-weight: 700;
		font-size: 0.8rem;
	}
	.user-name {
		font-size: 0.88rem;
		color: var(--text);
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	main {
		flex: 1;
	}
</style>
