<script lang="ts">
	import { goto } from '$app/navigation';
	import { parseCharx, runImport, type ParsedCharx, type ImportProgress } from '$lib/import/charx';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let parsing = $state(false);
	let parsed = $state<ParsedCharx | null>(null);
	let thumbUrl = $state<string | null>(null);
	let error = $state('');

	let importing = $state(false);
	let progress = $state<ImportProgress | null>(null);

	const card = $derived(parsed?.card ?? null);

	function reset() {
		if (thumbUrl) URL.revokeObjectURL(thumbUrl);
		thumbUrl = null;
		parsed = null;
		error = '';
		progress = null;
	}

	async function onPick(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		reset();
		parsing = true;
		try {
			const result = await parseCharx(file);
			parsed = result;
			// 썸네일 미리보기.
			if (result.card.iconPath) {
				const bytes = result.files[result.card.iconPath];
				if (bytes) {
					thumbUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : '파일을 읽지 못했어요.';
		} finally {
			parsing = false;
		}
	}

	async function start() {
		if (!parsed) return;
		importing = true;
		error = '';
		try {
			// charx 캐릭터는 성인물 가정 — NSFW + 남성향 고정(선택 없음).
			const res = await runImport(parsed, { contentRating: 'nsfw', audience: 'male' }, (p) => {
				progress = p;
			});
			// charx 캐릭터는 비공개·기기 한정 → 수정 불가. 내 캐릭터 목록으로 이동(채팅/삭제/기기간 공유).
			await goto(`/user/${data.user.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : '가져오기에 실패했어요.';
			importing = false;
		}
	}

	const pct = $derived(
		progress && progress.total > 0 ? Math.round((progress.uploaded / progress.total) * 100) : 0
	);
	const phaseLabel: Record<ImportProgress['phase'], string> = {
		creating: '캐릭터 생성 중…',
		storing: '이미지 저장 중…',
		finalizing: '마무리 중…',
		done: '완료'
	};
</script>

<svelte:head>
	<title>charx 가져오기 — Haven</title>
</svelte:head>

<div class="page">
	<header class="head">
		<h1>charx 가져오기</h1>
		<p class="sub">
			캐릭터 카드(.charx)를 Haven 캐릭터로 가져와요. 장면 이미지는 <b>이 기기에만</b> 저장되고
			캐릭터는 <b>비공개</b>예요. 나중에 '기기간 공유'를 누르면 클라우드에 올려 다른 기기에서도 볼 수 있어요.
		</p>
	</header>

	{#if error}<p class="error">{error}</p>{/if}

	{#if !parsed}
		<button class="drop" onclick={() => fileInput?.click()} disabled={parsing}>
			{#if parsing}
				불러오는 중…
			{:else}
				<span class="big">＋</span>
				<span>.charx 파일 선택</span>
				<span class="hint">브라우저에서 압축을 풀어 미리 확인해요</span>
			{/if}
		</button>
		<input
			bind:this={fileInput}
			type="file"
			accept=".charx,application/zip,application/octet-stream"
			onchange={onPick}
			hidden
		/>
	{:else if card}
		<section class="preview">
			<div class="top">
				{#if thumbUrl}<img class="thumb" src={thumbUrl} alt={card.name} />{/if}
				<div class="meta">
					<h2>{card.name}</h2>
					<p class="tagline">{card.tagline}</p>
					<div class="stats">
						<span>오프닝 {card.greetings.length}개</span>
						<span>장면 이미지 {card.images.length}장</span>
						<span>프롬프트 {card.description.length.toLocaleString()}자</span>
						{#if card.tags.length}<span>태그 {card.tags.length}</span>{/if}
					</div>
				</div>
			</div>

			{#if card.warnings.length}
				<ul class="warns">
					{#each card.warnings as w (w)}<li>⚠️ {w}</li>{/each}
				</ul>
			{/if}

			{#if importing && progress}
				<div class="prog">
					<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
					<span class="plabel">{phaseLabel[progress.phase]} ({progress.uploaded}/{progress.total})</span>
				</div>
			{/if}

			<div class="actions">
				<button class="ghost" onclick={reset} disabled={importing}>다른 파일</button>
				<button class="primary" onclick={start} disabled={importing}>
					{importing ? '가져오는 중…' : '가져오기'}
				</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: 28px 20px 64px;
	}
	.head h1 {
		margin: 0 0 6px;
		font-size: 1.5rem;
		font-weight: 800;
	}
	.sub {
		margin: 0 0 20px;
		color: var(--text-dim);
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.error {
		background: rgba(255, 92, 92, 0.12);
		border: 1px solid rgba(255, 92, 92, 0.4);
		color: #ff8a8a;
		padding: 10px 14px;
		border-radius: var(--radius-sm);
		font-size: 0.88rem;
		margin-bottom: 16px;
	}
	.drop {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 48px 20px;
		background: var(--bg-card);
		border: 1.5px dashed var(--border);
		border-radius: var(--radius);
		color: var(--text-dim);
		cursor: pointer;
	}
	.drop:hover {
		border-color: var(--accent);
		color: var(--text);
	}
	.drop .big {
		font-size: 2rem;
		color: var(--accent);
	}
	.drop .hint {
		font-size: 0.78rem;
		color: var(--text-faint);
	}
	.preview {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
	}
	.top {
		display: flex;
		gap: 16px;
	}
	.thumb {
		width: 96px;
		height: 96px;
		object-fit: cover;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
	}
	.meta h2 {
		margin: 0 0 4px;
		font-size: 1.2rem;
		font-weight: 800;
	}
	.tagline {
		margin: 0 0 10px;
		color: var(--text-dim);
		font-size: 0.88rem;
		line-height: 1.4;
	}
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.stats span {
		font-size: 0.76rem;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 10px;
	}
	.warns {
		margin: 16px 0 0;
		padding: 12px 14px;
		list-style: none;
		background: rgba(255, 196, 0, 0.08);
		border: 1px solid rgba(255, 196, 0, 0.3);
		border-radius: var(--radius-sm);
		font-size: 0.82rem;
		color: #e6c200;
		line-height: 1.5;
	}
	.warns li + li {
		margin-top: 6px;
	}
	.prog {
		margin-top: 18px;
	}
	.bar {
		height: 8px;
		background: var(--bg-elev);
		border-radius: 999px;
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.2s;
	}
	.plabel {
		display: block;
		margin-top: 6px;
		font-size: 0.78rem;
		color: var(--text-dim);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 22px;
	}
	.actions button {
		padding: 9px 18px;
		border-radius: var(--radius-sm);
		font-weight: 700;
		font-size: 0.88rem;
		cursor: pointer;
	}
	.ghost {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-dim);
	}
	.primary {
		background: var(--accent);
		border: none;
		color: #fff;
	}
	.primary:disabled,
	.ghost:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
