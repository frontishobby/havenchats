<script lang="ts">
	import '../app.css';
	import ProfileModal from '$lib/components/ProfileModal.svelte';
	import ApiKeyModal from '$lib/components/ApiKeyModal.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StorageLanding from '$lib/components/StorageLanding.svelte';
	import StorageModal from '$lib/components/StorageModal.svelte';
	import { storageModal } from '$lib/state/storageModal.svelte';
	import { sync, refreshTokenInGesture } from '$lib/local/sync.svelte';
	import { profileModal } from '$lib/state/profileModal.svelte';
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';
	import { privacyMode } from '$lib/state/privacyMode.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { resized } from '$lib/imageUrl';
	import type { LayoutData } from './$types';
	import type { MeData } from '$lib/api/pages';
	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// /chat/* 에선 모바일에서 상단 네비바를 숨긴다(채팅 헤더가 이미 뒤로가기·설정을 제공, 세로 공간 확보).
	// 자식(ChatView)은 --topbar-h 로 실제 상단바 높이를 읽어 자기 높이를 계산한다.
	const isChatRoute = $derived(page.url.pathname.startsWith('/chat/'));

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

	// 크레딧 뱃지 분기: 잔액(정상) / 키 무효(401 → 재등록 경고) / 없음.
	const creditsOk = $derived(me?.credits && !('invalid' in me.credits) ? me.credits : null);
	const creditsInvalid = $derived(!!me?.credits && 'invalid' in me.credits);

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
		if (me?.user && !me.user.profileComplete) profileModal.open = true;
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


	// 우상단 유저 메뉴(드롭다운)
	let menuOpen = $state(false);
	let menuRef = $state<HTMLDivElement | null>(null);

	function openProfileSettings() {
		profileModal.open = true;
		menuOpen = false;
	}
	function openStorage() {
		menuOpen = false;
		storageModal.open = true;
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
<!-- Drive 토큰(1시간)이 만료 임박이면 유저 제스처 안에서 미리 갱신(팝업이 바로 닫힘). -->
<svelte:document onclickcapture={refreshTokenInGesture} />

<div class="app" class:chat-route={isChatRoute}>
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
		<!-- 중앙: Drive 동기화 칩 + 그 오른쪽에 Vercel 크레딧 잔량(키 등록 시). -->
		<div class="center">
			{#if sync.mode === 'drive'}
				<button
					class="sync-chip"
					class:warn={sync.status === 'needs-auth' || sync.status === 'error' || sync.status === 'conflict'}
					class:busy={sync.status === 'syncing'}
					onclick={() => (storageModal.open = true)}
					title={sync.error ?? 'Google Drive 동기화 상태'}
				>
					{sync.status === 'syncing'
						? '⟳ 동기화 중'
						: sync.status === 'needs-auth'
							? '⚠ Drive 재연결'
							: sync.status === 'conflict'
								? '⚠ 충돌 · 선택 필요'
							: sync.status === 'error'
								? '⚠ 동기화 오류'
								: sync.pending > 0
									? `☁ 대기 ${sync.pending}`
									: sync.otherActive
										? `☁ ${sync.writer?.deviceName ?? '다른 기기'} 사용 중`
										: '☁ 동기화됨'}
				</button>
			{/if}
			{#if creditsInvalid}
				<button
					class="credits-badge warn"
					onclick={openApiKeys}
					title="저장된 Vercel AI Gateway 키가 거부됐습니다(401). API 키 관리에서 다시 등록하세요."
				>
					⚠ Gateway 키 재등록
				</button>
			{:else if creditsOk}
				<button
					class="credits-badge"
					class:low={creditsOk.balance < 5}
					onclick={openApiKeys}
					title={`Vercel AI Gateway 크레딧 잔여 · 총 사용 $${creditsOk.totalUsed.toFixed(2)}`}
				>
					<span class="credits-k">▲ 크레딧</span>
					<span class="credits-v">${creditsOk.balance.toFixed(2)}</span>
				</button>
			{/if}
		</div>
		<nav>
			<a class="hub-link" href="/styles">그림체</a>
			<a class="hub-link" href="/modules">모듈</a>
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
								{(me.user.personaName || me.user.name || '나').charAt(0).toUpperCase()}
							</span>
						{/if}
						<span class="user-name">{me.user.personaName || me.user.name || '나'}</span>
						<span class="chev">▾</span>
					</button>
					{#if menuOpen}
						<div class="menu" role="menu">
							<button class="menu-item" role="menuitem" onclick={openProfileSettings}>
								프로필 설정
							</button>
							<button class="menu-item" role="menuitem" onclick={openApiKeys}>
								API 키 관리
							</button>
							<button class="menu-item" role="menuitem" onclick={openStorage}>
								저장소 · 백업
							</button>
							<a class="menu-item" role="menuitem" href="/import" onclick={() => (menuOpen = false)}>
								charx 가져오기
							</a>
							<!-- 모바일: 상단바에서 숨긴 허브 링크를 메뉴 안으로 -->
							<div class="menu-sep mobile-only"></div>
							<a class="menu-item mobile-only" role="menuitem" href="/styles" onclick={() => (menuOpen = false)}>
								그림체
							</a>
							<a class="menu-item mobile-only" role="menuitem" href="/modules" onclick={() => (menuOpen = false)}>
								모듈
							</a>
						</div>
					{/if}
				</div>
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
<ProfileModal user={me?.user ?? null} />
<StorageModal />
{#if !sync.ready}
	<StorageLanding />
{/if}
{#if me?.user}
	<ApiKeyModal />
{/if}


<style>
	.app {
		--topbar-h: 60px;
		min-height: 100vh;
		min-height: 100dvh; /* 모바일: 실제 보이는 높이 기준 → body 넘침/헤더 가려짐 방지 */
		display: flex;
		flex-direction: column;
	}
	/* 모바일 채팅 화면: 상단 네비바 숨김(채팅 헤더의 ← 로 돌아감). */
	@media (max-width: 640px) {
		.app.chat-route {
			--topbar-h: 0px;
		}
		.app.chat-route .topbar {
			display: none;
		}
	}
	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 12px;
		padding: 0 20px;
		height: var(--topbar-h);
		background: color-mix(in srgb, var(--bg) 80%, transparent);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--border);
	}
	.left {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	/* 중앙 그룹: 동기화 칩 → 크레딧 뱃지 순서로 나란히. */
	.center {
		display: flex;
		align-items: center;
		gap: 8px;
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
		justify-self: end;
		gap: 16px;
	}
	.sync-chip {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-card);
		color: var(--text-dim);
		font-size: 0.72rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}
	.sync-chip.busy {
		color: var(--accent);
	}
	.sync-chip.warn {
		color: #ffb04d;
		border-color: #ffb04d66;
	}
	/* Vercel 크레딧 잔여 — 동기화 칩과 같은 알약 스타일, 클릭 시 API 키 관리. */
	.credits-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.72rem;
		white-space: nowrap;
		cursor: pointer;
	}
	.credits-k {
		color: var(--text-dim);
		font-weight: 600;
	}
	.credits-v {
		font-weight: 800;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.credits-badge.low {
		border-color: color-mix(in srgb, var(--nsfw) 40%, transparent);
	}
	.credits-badge.warn {
		color: #ffb04d;
		border-color: #ffb04d66;
		font-weight: 600;
	}
	.credits-badge.low .credits-v {
		color: var(--nsfw);
	}
	/* 좁은 화면: 라벨은 숨기고 금액만. */
	@media (max-width: 640px) {
		.credits-k {
			display: none;
		}
	}
	.mobile-only {
		display: none;
	}
	.menu-sep {
		height: 1px;
		margin: 6px 4px;
		background: var(--border);
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

	/* ── 모바일 상단바 ──
	   데스크톱 그대로 두면 [햄버거+로고] [동기화·크레딧] [그림체·모듈·이름▾] 세 묶음이 390px 를 훌쩍 넘어
	   오른쪽 메뉴가 화면 밖으로 잘린다(html overflow-x: clip). 좁은 폭에선
	   허브 링크는 유저 메뉴 안으로, 이름은 아바타만, 로고는 'Haven' 만 남긴다. */
	@media (max-width: 640px) {
		.app {
			--topbar-h: 52px;
		}
		.topbar {
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 8px;
			padding: 0 10px 0 6px;
		}
		.left {
			gap: 4px;
		}
		.brand {
			font-size: 1.05rem;
			gap: 5px;
		}
		.logo {
			font-size: 1.15rem;
		}
		.wordmark .dim {
			display: none;
		}
		.center {
			justify-content: center;
			min-width: 0;
			gap: 6px;
		}
		.sync-chip,
		.credits-badge {
			font-size: 0.68rem;
			padding: 4px 8px;
		}
		nav {
			gap: 6px;
		}
		.hub-link {
			display: none;
		}
		.mobile-only {
			display: block;
		}
		.user-name-btn {
			padding: 3px;
			gap: 4px;
		}
		.user-name {
			display: none;
		}
		.user-avatar,
		.user-fallback {
			width: 30px;
			height: 30px;
		}
		.menu {
			min-width: 170px;
		}
		.menu-item {
			padding: 11px 12px;
			font-size: 0.9rem;
		}
	}
</style>
