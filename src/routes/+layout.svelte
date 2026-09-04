<script lang="ts">
	import '../app.css';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import ProfileModal from '$lib/components/ProfileModal.svelte';
	import ApiKeyModal from '$lib/components/ApiKeyModal.svelte';
	import BlockedModal from '$lib/components/BlockedModal.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { loginModal } from '$lib/state/loginModal.svelte';
	import { profileModal } from '$lib/state/profileModal.svelte';
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';
	import { privacyMode } from '$lib/state/privacyMode.svelte';
	import { onMount } from 'svelte';
	import { isAdmin } from '$lib/admin';
	import { resized } from '$lib/imageUrl';
	import type { LayoutData } from './$types';
	import type { MeData } from '$lib/api/pages';
	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// /api/me 는 layout load 에서 await 하지 않고 promise(data.me) 로 흘러온다 → 셸은 즉시 렌더되고
	// 여기서 도착하면 me 에 채운다. 재검증(invalidate) 시 새 promise 가 와도 이전 값을 유지(깜빡임 방지).
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

	// app.html 의 부트 스켈레톤(#boot): 앱 셸이 마운트되면 페이드아웃 후 제거.
	// (SPA 라 JS 번들 + 페이지 load 가 끝나기 전까진 아무것도 렌더되지 않으므로 그동안 대신 보여준다)
	onMount(() => {
		const boot = document.getElementById('boot');
		if (!boot) return;
		boot.classList.add('out');
		setTimeout(() => boot.remove(), 180);
	});

	// 사이드바에서 세션 삭제(서버). 성공 시 Sidebar 가 로컬 목록에서 제거(무한스크롤 위치 보존 —
	// invalidate 로 첫 페이지를 다시 받으면 스크롤이 맨 위로 튀므로 여기선 새로고침하지 않는다).
	async function deleteChat(sessionId: string): Promise<boolean> {
		const res = await fetch('/api/chat/session', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sessionId })
		});
		return res.ok;
	}

	// 최초 로그인(프로필 미완성) 시 프로필 설정 모달 자동 노출
	$effect(() => {
		if (me?.user && !me.user.profileComplete && !me.user.blockedReason) profileModal.open = true;
	});

	// 브라우저 기록 숨김(로컬 옵션): 켜져 있으면 어떤 페이지든 탭 제목을 "Haven" 으로 강제.
	// 각 페이지가 <svelte:head><title>...</title> 로 제목을 바꾸므로, <head> 변화를 감시해 즉시 되돌린다.
	$effect(() => {
		if (!privacyMode.hideHistory) return;
		document.title = 'Haven';
		const enforce = () => {
			if (document.title !== 'Haven') document.title = 'Haven';
		};
		const obs = new MutationObserver(enforce);
		obs.observe(document.head, { childList: true, subtree: true, characterData: true });
		return () => obs.disconnect();
	});

	// 좌측 사이드바(최근 채팅)
	let sidebarOpen = $state(false);

	// 관리자 여부(메뉴에 /admin 노출용). 공용 isAdmin(클라/서버 공유)로 판별 — 하드코딩 제거.
	const isAdminUser = $derived(isAdmin(me?.user?.email));

	// 우상단 유저 메뉴(드롭다운)
	let menuOpen = $state(false);
	let menuRef = $state<HTMLDivElement | null>(null);

	function openProfileSettings() {
		profileModal.open = true;
		menuOpen = false;
	}
	function openApiKeys() {
		apiKeyModal.open = true;
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
			{#if me?.user}
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
		{#if me?.credits}
			<span class="credits-badge" title={`총 사용 $${me.credits.totalUsed.toFixed(2)}`}>
				<span class="credits-k">Vercel 크레딧</span>
				<span class="credits-v" class:low={me.credits.balance < 5}>
					${me.credits.balance.toFixed(2)}
				</span>
			</span>
		{/if}
		<nav>
			<a class="hub-link" href="/styles">그림체 Hub</a>
			{#if me?.user}
				<div class="user-menu" bind:this={menuRef}>
					<button
						class="user-name-btn"
						class:active={menuOpen}
						onclick={() => (menuOpen = !menuOpen)}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						title="메뉴"
					>
						{#if me.user.avatarUrl}
							<img class="user-avatar" src={resized(me.user.avatarUrl, 64)} alt="" />
						{:else}
							<span class="user-fallback">
								{(me.user.name ?? me.user.email).charAt(0).toUpperCase()}
							</span>
						{/if}
						<span class="user-name">{me.user.name ?? '프로필 설정'}</span>
						<span class="chev">▾</span>
					</button>
					{#if menuOpen}
						<div class="menu" role="menu">
							<a
								class="menu-item"
								role="menuitem"
								href="/user/{me.user.id}"
								onclick={() => (menuOpen = false)}
							>
								내 캐릭터
							</a>
							<button class="menu-item" role="menuitem" onclick={openProfileSettings}>
								프로필 설정
							</button>
							<button class="menu-item" role="menuitem" onclick={openApiKeys}>
								API 키 관리
							</button>
							{#if isAdminUser}
								<a
									class="menu-item"
									role="menuitem"
									href="/admin"
									onclick={() => (menuOpen = false)}
								>
									관리자
								</a>
							{/if}
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

<Sidebar
	open={sidebarOpen}
	chats={me?.recentChats ?? []}
	initialCursor={me?.recentChatsCursor ?? null}
	initialHasMore={me?.recentChatsHasMore ?? false}
	onClose={() => (sidebarOpen = false)}
	onDelete={deleteChat}
/>
<LoginModal />
<ProfileModal user={me?.user ?? null} />
{#if me?.user}
	<ApiKeyModal />
{/if}

<!-- 차단된 유저: 종료 불가 모달로 모든 동작 차단. 다른 모든 모달/UI 위에 렌더. -->
{#if me?.user?.blockedReason}
	<BlockedModal reason={me.user.blockedReason} />
{/if}

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
	/* Vercel 크레딧 뱃지 — 네비바 정중앙(좌/우 영역과 독립되게 절대 배치). */
	.credits-badge {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 5px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.84rem;
		white-space: nowrap;
		z-index: 1;
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
	/* 좁은 화면에선 브랜드·유저메뉴와 겹치므로 숨김. */
	@media (max-width: 640px) {
		.credits-badge {
			display: none;
		}
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
	.hub-link {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-dim);
		padding: 6px 10px;
		border-radius: 8px;
		white-space: nowrap;
		transition: color 0.12s ease, background 0.12s ease;
	}
	.hub-link:hover {
		color: var(--text);
		background: var(--bg-card);
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
