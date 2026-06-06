<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		parseCharx,
		runImport,
		applyExternalModule,
		type ParsedCharx,
		type ImportProgress
	} from '$lib/import/charx';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let parsing = $state(false);
	let parsed = $state<ParsedCharx | null>(null);
	let thumbUrl = $state<string | null>(null);
	let error = $state('');

	// 선택적: 별도 .risum 모듈(로어북·감정 스프라이트)을 캐릭터에 병합.
	let moduleInput = $state<HTMLInputElement | null>(null);
	let attachingModule = $state(false);
	let attachedModule = $state<{
		name: string;
		loreAdded: number;
		displayAdded: number;
		assetsAdded: number;
	} | null>(null);

	let importing = $state(false);
	let progress = $state<ImportProgress | null>(null);

	// 실험적: 재현 안 되는 스크립트를 LLM 으로 분석.
	let analyzing = $state(false);
	let analysis = $state('');
	let analyzeError = $state('');

	const card = $derived(parsed?.card ?? null);
	const scripts = $derived(parsed?.card?.scripts ?? []);

	function reset() {
		if (thumbUrl) URL.revokeObjectURL(thumbUrl);
		thumbUrl = null;
		parsed = null;
		error = '';
		progress = null;
		analysis = '';
		analyzeError = '';
		analyzing = false;
		attachedModule = null;
		attachingModule = false;
	}

	async function onPickModule(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // 같은 파일 재선택 허용
		if (!file || !parsed) return;
		attachingModule = true;
		error = '';
		try {
			// parsed 는 $state 프록시 → in-place 수정(card·extra)이 반응성으로 전파됨.
			attachedModule = await applyExternalModule(parsed, file);
		} catch (err) {
			error = err instanceof Error ? err.message : '.risum 을 읽지 못했어요.';
		} finally {
			attachingModule = false;
		}
	}

	async function analyzeScripts() {
		if (!scripts.length || analyzing) return;
		analyzing = true;
		analyzeError = '';
		analysis = '';
		try {
			const res = await fetch('/api/import/analyze-script', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scripts })
			});
			const data = (await res.json().catch(() => ({}))) as { analysis?: string; error?: string };
			if (!res.ok || !data.analysis) throw new Error(data.error || '분석에 실패했어요.');
			analysis = data.analysis;
		} catch (err) {
			analyzeError = err instanceof Error ? err.message : '분석에 실패했어요.';
		} finally {
			analyzing = false;
		}
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

			<div class="module">
				{#if attachedModule}
					<p class="module-on">
						✓ 모듈 <b>{attachedModule.name}</b> 병합됨 — 로어북 +{attachedModule.loreAdded}, 표시
						스크립트 +{attachedModule.displayAdded}, 이미지 +{attachedModule.assetsAdded}
					</p>
					<span class="module-hint">교체하려면 '다른 파일'로 처음부터 다시 선택하세요.</span>
				{:else}
					<button
						class="module-btn"
						onclick={() => moduleInput?.click()}
						disabled={attachingModule || importing}
					>
						{attachingModule ? '모듈 읽는 중…' : '＋ .risum 모듈 추가 (선택)'}
					</button>
					<span class="module-hint">
						별도 .risum(로어북·감정 스프라이트)을 이 캐릭터에 합쳐요. 트리거·코드는 charx 와 같이
						경고로만 표시돼요.
					</span>
				{/if}
				<input
					bind:this={moduleInput}
					type="file"
					accept=".risum,application/octet-stream"
					onchange={onPickModule}
					hidden
				/>
			</div>

			{#if scripts.length}
				<div class="analyze">
					<button class="analyze-btn" onclick={analyzeScripts} disabled={analyzing}>
						{#if analyzing}
							🔬 분석 중… (LLM)
						{:else}
							🔬 이 스크립트가 뭘 하는지 분석 <span class="exp">실험적</span>
						{/if}
					</button>
					<span class="analyze-hint">
						재현되지 않는 트리거·코드 {scripts.length}개를 AI(Gemini)에게 보내 설명을 받아요.
					</span>
					{#if analyzeError}<p class="analyze-err">{analyzeError}</p>{/if}
					{#if analysis}<div class="analysis">{analysis}</div>{/if}
				</div>
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
	.module {
		margin-top: 14px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.module-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px;
		border-radius: var(--radius-sm);
		border: 1px dashed var(--border);
		background: var(--bg-elev);
		color: var(--text);
		font-size: 0.84rem;
		font-weight: 700;
		cursor: pointer;
	}
	.module-btn:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.module-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.module-on {
		margin: 0;
		font-size: 0.84rem;
		font-weight: 700;
		color: var(--accent);
	}
	.module-hint {
		display: block;
		margin-top: 6px;
		font-size: 0.76rem;
		color: var(--text-faint);
	}
	.analyze {
		margin-top: 14px;
	}
	.analyze-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text);
		font-size: 0.84rem;
		font-weight: 700;
		cursor: pointer;
	}
	.analyze-btn:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.analyze-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.analyze-btn .exp {
		font-size: 0.68rem;
		font-weight: 700;
		color: var(--accent);
		background: rgba(124, 92, 255, 0.14);
		border-radius: 999px;
		padding: 1px 7px;
	}
	.analyze-hint {
		display: block;
		margin-top: 6px;
		font-size: 0.76rem;
		color: var(--text-faint);
	}
	.analyze-err {
		margin: 10px 0 0;
		font-size: 0.82rem;
		color: #ff8a8a;
	}
	.analysis {
		margin-top: 12px;
		padding: 14px 16px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.84rem;
		line-height: 1.6;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 480px;
		overflow-y: auto;
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
