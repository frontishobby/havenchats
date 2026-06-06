<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import CharacterCard from '$lib/components/CharacterCard.svelte';
	import CharacterDetailModal from '$lib/components/CharacterDetailModal.svelte';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import { isLocalSet, isNamed, localSceneKey } from '$lib/imageCodes';
	import { promoteLocalCharacter, type PromoteProgress } from '$lib/import/promote';
	import { deleteLocalScenes, getLocalSceneBlob } from '$lib/import/localImages';
	import { addAssetsFromZip, type AddAssetsProgress } from '$lib/import/addAssets';
	import type { Character } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 로컬에서 즉시 제거할 수 있도록 복사본 유지(소유자 삭제 시).
	let items = $state<Character[]>(data.characters);
	let deleting = $state<string | null>(null);
	let avatarFailed = $state(false);

	// 기기간 공유(promote) 진행 상태.
	let promoting = $state<string | null>(null);
	let promoteProg = $state<PromoteProgress | null>(null);

	// 에셋 추가(.zip) 진행 상태. assetTarget = 클릭한 캐릭터(공용 input 으로 처리).
	let addingAssets = $state<string | null>(null);
	let assetProg = $state<AddAssetsProgress | null>(null);
	let assetInput = $state<HTMLInputElement | null>(null);
	let assetTarget = $state<Character | null>(null);

	// charx(로컬·기기 한정) 캐릭터 — 수정 불가, '기기간 공유'로만 클라우드 전환.
	function isLocal(c: Character): boolean {
		return isLocalSet(c.imageSet);
	}

	// '기기간 공유'는 이 기기(IndexedDB)에 실제로 장면 이미지가 있는 기기에서만 가능하다.
	// storage:'local' 은 DB(전 기기 공통) 값이라, 가져온 적 없는 다른 기기에서도 버튼이 떠
	// 눌러도 promote 가 실패하던 문제 → 로컬 blob 존재를 확인해 그 기기에서만 노출.
	let localPresent = $state<Set<string>>(new Set());
	async function checkLocalPresence() {
		const next = new Set<string>();
		for (const c of items) {
			const set = c.imageSet;
			if (!isLocalSet(set) || !isNamed(set)) continue;
			for (const img of set.images) {
				if (await getLocalSceneBlob(localSceneKey(c.id, img.id))) {
					next.add(c.id);
					break; // 하나라도 있으면 이 기기가 가져온 기기 → 노출
				}
			}
		}
		localPresent = next;
	}
	$effect(() => {
		void items; // items 변동(promote/에셋 추가/유저 전환) 시 재확인
		checkLocalPresence();
	});

	// 방문자 모드: 상세 모달.
	let detail = $state<Character | null>(null);

	// 페이지(유저)가 바뀌면 로컬 상태 초기화.
	let lastId = $state(data.profile.id);
	$effect(() => {
		if (data.profile.id !== lastId) {
			lastId = data.profile.id;
			items = data.characters;
			avatarFailed = false;
			detail = null;
		}
	});

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
			// 로컬(IndexedDB) 장면 이미지도 함께 정리(charx 로컬 캐릭터).
			await deleteLocalScenes(c.id);
			items = items.filter((x) => x.id !== c.id);
		} catch {
			alert('삭제에 실패했어요. 잠시 후 다시 시도해 주세요.');
		} finally {
			deleting = null;
		}
	}

	// 로컬 charx 캐릭터를 클라우드로 올려 기기간 공유 가능하게 전환.
	async function promote(c: Character) {
		if (promoting || !c.imageSet) return;
		if (!confirm(`'${c.name}'을(를) 클라우드에 올려 다른 기기에서도 보이게 할까요?`)) return;
		promoting = c.id;
		promoteProg = null;
		try {
			await promoteLocalCharacter(c.id, c.imageSet, (p) => (promoteProg = p));
			// 전환 성공 → storage 플래그 제거(이제 일반 캐릭터처럼 수정·공개 가능).
			items = items.map((x) =>
				x.id === c.id && x.imageSet
					? { ...x, imageSet: { ...x.imageSet, storage: undefined } }
					: x
			);
			// 에셋 페이지 load 는 세션 캐시됨 → 무효화해 새로고침 없이 에셋 미리보기 시
			// 옛 local 세트(삭제된 IndexedDB)를 안 쓰게 한다.
			await invalidate(`character:${c.id}`);
		} catch (e) {
			alert(e instanceof Error ? e.message : '올리기에 실패했어요.');
		} finally {
			promoting = null;
			promoteProg = null;
		}
	}

	// 가져온 캐릭터에 장면 이미지(.zip)를 추가. 공용 파일 input 을 캐릭터별로 트리거.
	function pickAssets(c: Character) {
		if (addingAssets) return;
		assetTarget = c;
		if (assetInput) {
			assetInput.value = ''; // 같은 파일 재선택 허용
			assetInput.click();
		}
	}

	async function onAssetPick(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		const c = assetTarget;
		if (!file || !c) return;
		addingAssets = c.id;
		assetProg = null;
		try {
			const res = await addAssetsFromZip(c.id, c.imageSet, file, (p) => (assetProg = p));
			// 갱신된 세트를 로컬 상태에 반영.
			items = items.map((x) => (x.id === c.id ? { ...x, imageSet: res.newSet } : x));
			// 캐시된 에셋 페이지 load 무효화(새로고침 없이 추가분이 보이도록).
			await invalidate(`character:${c.id}`);
			alert(
				`'${c.name}'에 이미지 ${res.added}장을 추가했어요.` +
					(res.skipped > 0 ? ` (${res.skipped}개 건너뜀)` : '')
			);
		} catch (err) {
			alert(err instanceof Error ? err.message : '에셋 추가에 실패했어요.');
		} finally {
			addingAssets = null;
			assetProg = null;
			assetTarget = null;
		}
	}

	const initial = $derived((data.profile.name ?? '?').charAt(0).toUpperCase());

	// 소유자 관리 화면: 직접 만든 캐릭터와 가져온(charx) 캐릭터를 섹션으로 분리.
	const createdItems = $derived(items.filter((c) => !c.imported));
	const importedItems = $derived(items.filter((c) => c.imported));
</script>

<svelte:head>
	<title>{data.profile.name} — Haven</title>
</svelte:head>

<div class="user">
	<a class="back" href="/">← 탐색으로</a>

	<header class="profile-head">
		<div class="avatar">
			{#if data.profile.avatarUrl && !avatarFailed}
				<img src={data.profile.avatarUrl} alt={data.profile.name} onerror={() => (avatarFailed = true)} />
			{:else}
				<span class="avatar-fallback">{initial}</span>
			{/if}
		</div>
		<div class="profile-info">
			<h1>{data.profile.name}</h1>
			<p class="count">캐릭터 {items.length}개</p>
		</div>
	</header>

	{#if data.isOwner}
		<a class="create-btn" href="/create">+ 캐릭터 만들기</a>
		<a class="create-btn" href="/import">+ charx 가져오기</a>

		{#snippet ownerRow(c: Character)}
			<li class="row">
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
				<button class="row-main" type="button" onclick={() => (detail = c)}>
					<img class="thumb" src={c.avatarUrl} alt={c.name} />
					<span class="info">
						<span class="name-line">
							<span class="name">{c.name}</span>
							{#if c.contentRating === 'nsfw'}<NsfwBadge size={15} />{/if}
						</span>
						<span class="tagline">{c.tagline}</span>
						<span class="meta">💬 {c.chats}</span>
					</span>
				</button>
				{#if c.imported}
					<!-- 가져온(charx) 캐릭터: 수정 불가. 로컬이면 '기기간 공유'로 클라우드 전환만 가능. -->
					<!-- 단, 관리자는 가져온 캐릭터의 프롬프트도 편집할 수 있다. -->
					{#if data.isAdmin}
						<button class="edit" type="button" onclick={() => edit(c)}>수정</button>
					{/if}
					<button
						class="edit"
						type="button"
						onclick={() => pickAssets(c)}
						disabled={!!addingAssets}
						title=".zip 으로 장면 이미지 추가"
					>
						{#if addingAssets === c.id}
							{assetProg ? `${assetProg.uploaded}/${assetProg.total}` : '추가 중…'}
						{:else}
							＋에셋
						{/if}
					</button>
					{#if isLocal(c) && localPresent.has(c.id)}
						<button
							class="edit promote"
							type="button"
							onclick={() => promote(c)}
							disabled={!!promoting}
							title="클라우드에 올려 다른 기기에서도 보기"
						>
							{#if promoting === c.id}
								{promoteProg ? `${promoteProg.uploaded}/${promoteProg.total}` : '올리는 중…'}
							{:else}
								⬆ 기기간 공유
							{/if}
						</button>
					{/if}
				{:else}
					<button class="edit" type="button" onclick={() => edit(c)}>수정</button>
				{/if}
				<button
					class="del"
					type="button"
					onclick={() => remove(c)}
					disabled={deleting === c.id}
					aria-label="캐릭터 삭제"
				>
					{deleting === c.id ? '…' : '×'}
				</button>
			</li>
		{/snippet}

		{#if items.length === 0}
			<div class="empty">
				<span class="empty-icon">✦</span>
				<p>아직 만든 캐릭터가 없어요.</p>
				<span class="empty-sub">위 버튼으로 첫 캐릭터를 만들어보세요.</span>
			</div>
		{:else}
			{#if createdItems.length > 0}
				<h2 class="section-label">내가 만든 캐릭터 {createdItems.length}</h2>
				<ul class="list">
					{#each createdItems as c (c.id)}
						{@render ownerRow(c)}
					{/each}
				</ul>
			{/if}
			{#if importedItems.length > 0}
				<h2 class="section-label" class:has-divider={createdItems.length > 0}>
					가져온 캐릭터 {importedItems.length}
				</h2>
				<ul class="list">
					{#each importedItems as c (c.id)}
						{@render ownerRow(c)}
					{/each}
				</ul>
			{/if}
		{/if}
	{:else if items.length === 0}
		<div class="empty">
			<span class="empty-icon">✦</span>
			<p>아직 공개된 캐릭터가 없어요.</p>
		</div>
	{:else}
		<div class="grid">
			{#each items as character (character.id)}
				<CharacterCard {character} onselect={(c) => (detail = c)} />
			{/each}
		</div>
	{/if}
</div>

<!-- 가져온 캐릭터 에셋 추가용 공용 파일 입력(행 버튼이 트리거). -->
<input
	bind:this={assetInput}
	type="file"
	accept=".zip,application/zip,application/octet-stream"
	onchange={onAssetPick}
	hidden
/>

<CharacterDetailModal character={detail} onclose={() => (detail = null)} />

<style>
	.user {
		max-width: 720px;
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

	.profile-head {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 24px;
	}
	.avatar {
		width: 76px;
		height: 76px;
		flex-shrink: 0;
		border-radius: 50%;
		overflow: hidden;
		background: var(--bg-elev);
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.avatar-fallback {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		font-size: 2.2rem;
		font-weight: 700;
		color: #fff;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
	}
	.profile-info h1 {
		margin: 0 0 4px;
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.count {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.9rem;
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

	/* 방문자: 캐릭터 그리드 */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 18px;
	}

	/* 소유자: 섹션 제목(만든 캐릭터 / 가져온 캐릭터 구분) */
	.section-label {
		margin: 0 0 12px;
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.01em;
		color: var(--text-dim);
		text-transform: none;
	}
	/* 두 섹션 사이 구분선 — 가져온 캐릭터 섹션이 만든 캐릭터 아래에 올 때만. */
	.section-label.has-divider {
		margin-top: 28px;
		padding-top: 24px;
		border-top: 1px solid var(--border);
	}

	/* 소유자: 관리 리스트 */
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
	.edit {
		flex-shrink: 0;
		padding: 0 16px;
		border: none;
		border-left: 1px solid var(--border);
		background: transparent;
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.edit:hover {
		background: var(--accent-soft);
	}
	.edit:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.edit.promote {
		white-space: nowrap;
		font-size: 0.8rem;
	}
	.del {
		flex-shrink: 0;
		width: 46px;
		border: none;
		border-left: 1px solid var(--border);
		background: transparent;
		color: var(--text-faint);
		font-size: 1.25rem;
		line-height: 1;
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
