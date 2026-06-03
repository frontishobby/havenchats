<script lang="ts">
	import '../app.css';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import ProfileModal from '$lib/components/ProfileModal.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { loginModal } from '$lib/state/loginModal.svelte';
	import { profileModal } from '$lib/state/profileModal.svelte';
	import type { LayoutData } from './$types';
	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// 최초 로그인(프로필 미완성) 시 프로필 설정 모달 자동 노출
	$effect(() => {
		if (data.user && !data.user.profileComplete) profileModal.open = true;
	});

	// 좌측 사이드바(최근 채팅)
	let sidebarOpen = $state(false);

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
		<div class="left">
			{#if data.user}
				<button
					class="hamburger"
					onclick={() => (sidebarOpen = true)}
					aria-label="최근 채팅"
					title="최근 채팅"
				>
					<span></span><span></span><span></span>
				</button>
			{/if}
			<a class="brand" href="/">
				<span class="logo">✦</span>
				<span class="wordmark">Haven<span class="dim">chats</span></span>
			</a>
		</div>
		<nav>
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
						{#if data.user.avatarUrl}
							<img class="user-avatar" src={data.user.avatarUrl} alt="" />
						{:else}
							<span class="user-fallback">
								{(data.user.name ?? data.user.email).charAt(0).toUpperCase()}
							</span>
						{/if}
						<span class="user-name">{data.user.name ?? '프로필 설정'}</span>
						<span class="chev">▾</span>
					</button>
					{#if menuOpen}
						<div class="menu" role="menu">
							<a
								class="menu-item"
								role="menuitem"
								href="/user/{data.user.id}"
								onclick={() => (menuOpen = false)}
							>
								내 캐릭터
							</a>
							<button class="menu-item" role="menuitem" onclick={openProfileSettings}>
								프로필 설정
							</button>
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

<Sidebar open={sidebarOpen} chats={data.recentChats} onClose={() => (sidebarOpen = false)} />
<LoginModal />
<ProfileModal user={data.user} />

<style>
	.app {
		min-height: 100vh;
		min-height: 100dvh; /* 모바일: 실제 보이는 높이 기준 → body 넘침/헤더 가려짐 방지 */
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
	.left {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.hamburger {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
		width: 36px;
		height: 36px;
		padding: 0 8px;
		background: transparent;
		border: none;
		border-radius: 8px;
		transition: background 0.12s ease;
	}
	.hamburger:hover {
		background: var(--bg-card);
	}
	.hamburger span {
		display: block;
		height: 2px;
		border-radius: 2px;
		background: var(--text-dim);
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
	.user-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
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
