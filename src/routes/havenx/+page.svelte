<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import type { HavenxManifest, HavenxProgress } from '$lib/local/havenx';

	interface Item {
		file: File;
		manifest: HavenxManifest | null;
		thumbUrl: string | null;
		error: string;
		status: 'ready' | 'importing' | 'done' | 'failed';
		note: string;
	}

	let fileInput = $state<HTMLInputElement | null>(null);
	let items = $state<Item[]>([]);
	let reading = $state(false);
	let includeSessions = $state(true);
	let busy = $state(false);
	let progress = $state<HavenxProgress | null>(null);
	let dragOver = $state(false);

	const readyCount = $derived(items.filter((i) => i.status === 'ready' && i.manifest).length);
	const anySessions = $derived(items.some((i) => (i.manifest?.sessions?.length ?? 0) > 0));
	const allDone = $derived(items.length > 0 && items.every((i) => i.status !== 'ready' && i.status !== 'importing'));

	async function addFiles(files: FileList | File[] | null | undefined) {
		if (!files?.length) return;
		reading = true;
		const { peekHavenx } = await import('$lib/local/havenx');
		for (const file of Array.from(files)) {
			const idx = items.push({ file, manifest: null, thumbUrl: null, error: '', status: 'ready', note: '' }) - 1;
			try {
				const { manifest, thumbnail } = await peekHavenx(file);
				items[idx].manifest = manifest;
				items[idx].thumbUrl = thumbnail ? URL.createObjectURL(thumbnail) : null;
			} catch (e) {
				items[idx].error = e instanceof Error ? e.message : '파일을 읽지 못했어요.';
				items[idx].status = 'failed';
			}
		}
		reading = false;
	}

	function onPick(e: Event) {
		const input = e.target as HTMLInputElement;
		addFiles(input.files);
		input.value = '';
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		addFiles(e.dataTransfer?.files);
	}

	function remove(i: number) {
		const it = items[i];
		if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
		items.splice(i, 1);
	}

	async function importAll() {
		if (busy) return;
		busy = true;
		const { importHavenx } = await import('$lib/local/havenx');
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'ready' || !items[i].manifest) continue;
			items[i].status = 'importing';
			progress = null;
			try {
				const r = await importHavenx(items[i].file, { includeSessions }, (p) => (progress = p));
				items[i].status = 'done';
				const bits = [`이미지 ${r.images}장`];
				if (r.sessions) bits.push(`대화 ${r.sessions}개`);
				if (r.missing) bits.push(`빠진 이미지 ${r.missing}`);
				if (r.styleReused) bits.push('그림체는 기존 것 사용');
				items[i].note = bits.join(' · ');
			} catch (e) {
				items[i].status = 'failed';
				items[i].error = e instanceof Error ? e.message : '가져오기에 실패했어요.';
			}
		}
		progress = null;
		busy = false;
		await invalidateAll();
	}

	function counts(m: HavenxManifest): string[] {
		const c = m.character;
		const out = [`오프닝 ${c.greetings.length}`];
		const scenes =
			c.scenes?.kind === 'grid' ? c.scenes.entries.length : c.scenes?.kind === 'named' ? c.scenes.images.length : 0;
		if (scenes) out.push(`장면 이미지 ${scenes}${c.scenes?.kind === 'grid' ? ` · 축 ${c.scenes.axes.length}` : ''}`);
		if (c.lorebook) out.push(`로어북 ${c.lorebook.entries.length}`);
		if (m.style) out.push(`그림체 '${m.style.title}'`);
		if (m.sessions?.length) out.push(`대화 ${m.sessions.length}개`);
		out.push(c.contentRating === 'nsfw' ? 'NSFW' : 'SFW');
		return out;
	}

	const pct = $derived(
		progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
	);
</script>

<svelte:head>
	<title>havenx 가져오기 — Haven</title>
</svelte:head>

<div class="page">
	<header class="head">
		<h1>havenx 가져오기</h1>
		<p class="sub">
			Haven 캐릭터 패키지(<b>.havenx</b>)를 가져와요. 프롬프트·오프닝·로어북·장면 이미지·썸네일·추천 그림체,
			들어 있다면 대화 기록까지 그대로 들어와요. 내보내기는 캐릭터 상세 창 아래 'havenx 내보내기'.
		</p>
	</header>

	<button
		class="drop"
		class:over={dragOver}
		onclick={() => fileInput?.click()}
		ondragover={(e) => {
			e.preventDefault();
			dragOver = true;
		}}
		ondragleave={() => (dragOver = false)}
		ondrop={onDrop}
		disabled={busy}
	>
		{#if reading}
			읽는 중…
		{:else}
			<span class="big">＋</span>
			<span>.havenx 파일 선택 (여러 개 가능)</span>
			<span class="hint">여기로 끌어다 놓아도 돼요</span>
		{/if}
	</button>
	<input bind:this={fileInput} type="file" accept=".havenx,application/zip" multiple onchange={onPick} hidden />

	{#if items.length}
		<ul class="list">
			{#each items as it, i (it.file.name + i)}
				<li class="item" class:failed={it.status === 'failed'}>
					{#if it.thumbUrl}
						<img class="thumb" src={it.thumbUrl} alt="" />
					{:else}
						<div class="thumb ph">{(it.manifest?.character.name ?? it.file.name).charAt(0)}</div>
					{/if}
					<div class="meta">
						<h2>{it.manifest?.character.name ?? it.file.name}</h2>
						{#if it.manifest}
							<p class="tagline">{it.manifest.character.tagline}</p>
							<div class="stats">
								{#each counts(it.manifest) as s (s)}<span>{s}</span>{/each}
							</div>
						{/if}
						{#if it.error}<p class="err">{it.error}</p>{/if}
						{#if it.status === 'importing'}
							<div class="prog">
								<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
								<span class="plabel">{progress?.phase ?? '시작'} {progress?.total ? `${progress.done}/${progress.total}` : ''}</span>
							</div>
						{:else if it.status === 'done'}
							<p class="ok">✓ 가져옴 — {it.note}</p>
						{/if}
					</div>
					{#if it.status === 'ready' && !busy}
						<button class="x" onclick={() => remove(i)} aria-label="목록에서 빼기">✕</button>
					{/if}
				</li>
			{/each}
		</ul>

		<div class="actions">
			{#if anySessions}
				<label class="opt">
					<input type="checkbox" bind:checked={includeSessions} disabled={busy} />
					대화 기록도 가져오기
				</label>
			{/if}
			{#if allDone}
				<button class="primary" onclick={() => goto('/')}>캐릭터 목록으로</button>
			{:else}
				<button class="primary" onclick={importAll} disabled={busy || readyCount === 0}>
					{busy ? '가져오는 중…' : `${readyCount}개 가져오기`}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: 28px 16px 64px;
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
	.drop {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 40px 20px;
		background: var(--bg-card);
		border: 1.5px dashed var(--border);
		border-radius: var(--radius);
		color: var(--text-dim);
		cursor: pointer;
	}
	.drop:hover,
	.drop.over {
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
	.list {
		list-style: none;
		margin: 18px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.item {
		position: relative;
		display: flex;
		gap: 14px;
		padding: 14px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.item.failed {
		border-color: rgba(255, 92, 92, 0.4);
	}
	.thumb {
		width: 84px;
		height: 84px;
		object-fit: cover;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
	}
	.thumb.ph {
		display: grid;
		place-items: center;
		background: var(--bg-elev);
		font-size: 1.8rem;
		font-weight: 800;
		color: var(--text-faint);
	}
	.meta {
		min-width: 0;
		flex: 1;
	}
	.meta h2 {
		margin: 0 0 4px;
		font-size: 1.05rem;
		font-weight: 800;
		padding-right: 24px;
	}
	.tagline {
		margin: 0 0 8px;
		color: var(--text-dim);
		font-size: 0.85rem;
		line-height: 1.4;
	}
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.stats span {
		font-size: 0.74rem;
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 2px 9px;
	}
	.err {
		margin: 6px 0 0;
		color: #ff8a8a;
		font-size: 0.82rem;
	}
	.ok {
		margin: 8px 0 0;
		color: #6fd39a;
		font-size: 0.82rem;
	}
	.x {
		position: absolute;
		top: 8px;
		right: 8px;
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 4px;
	}
	.prog {
		margin-top: 10px;
	}
	.bar {
		height: 6px;
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
		margin-top: 4px;
		font-size: 0.76rem;
		color: var(--text-dim);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
		margin-top: 18px;
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.primary {
		padding: 9px 18px;
		border-radius: var(--radius-sm);
		font-weight: 700;
		font-size: 0.88rem;
		background: var(--accent);
		border: none;
		color: #fff;
		cursor: pointer;
	}
	.primary:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
