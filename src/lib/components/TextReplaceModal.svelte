<script lang="ts">
	import { scrollLock } from '$lib/scrollLock';
	interface Pair {
		from: string;
		to: string;
	}

	let {
		open,
		text,
		onclose,
		onapply
	}: {
		open: boolean;
		/** 현재 프롬프트 텍스트(치환 대상). */
		text: string;
		onclose: () => void;
		/** 치환 결과 텍스트를 돌려준다. */
		onapply: (next: string) => void;
	} = $props();

	let pairs = $state<Pair[]>([{ from: '', to: '' }]);

	// 모달이 열릴 때마다 입력 초기화.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) pairs = [{ from: '', to: '' }];
		wasOpen = open;
	});

	// 적용할(=from 이 비어있지 않은) 쌍만 추려서 순서대로 치환.
	const active = $derived(pairs.filter((p) => p.from.length > 0));

	function applied(src: string): string {
		let out = src;
		for (const p of active) out = out.split(p.from).join(p.to);
		return out;
	}

	const preview = $derived(applied(text));
	const changed = $derived(preview !== text);

	// 각 행이 현재 텍스트에서 몇 번 매칭되는지(안내용).
	function matchCount(from: string): number {
		if (!from) return 0;
		return text.split(from).length - 1;
	}

	function addPair() {
		pairs = [...pairs, { from: '', to: '' }];
	}
	function removePair(i: number) {
		pairs = pairs.length > 1 ? pairs.filter((_, idx) => idx !== i) : [{ from: '', to: '' }];
	}

	function apply() {
		if (!changed) return;
		onapply(preview);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" use:scrollLock onclick={onclose} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="텍스트 대치"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<button class="close" onclick={onclose} aria-label="닫기">✕</button>

			<header class="r-head">
				<span class="r-logo">🔧</span>
				<h2>텍스트 대치</h2>
				<p>프롬프트 안의 특정 텍스트를 한 번에 다른 텍스트로 바꿔요.</p>
			</header>

			<div class="r-body">
				{#each pairs as pair, i (i)}
					{@const n = matchCount(pair.from)}
					<div class="pair">
						<div class="pair-fields">
							<input
								class="pair-input"
								type="text"
								placeholder="바꿀 텍스트 (X)"
								bind:value={pairs[i].from}
							/>
							<span class="arrow">→</span>
							<input
								class="pair-input"
								type="text"
								placeholder="새 텍스트 (Y)"
								bind:value={pairs[i].to}
							/>
							<button
								type="button"
								class="pair-del"
								onclick={() => removePair(i)}
								aria-label="행 삭제">✕</button
							>
						</div>
						{#if pair.from}
							<span class="match" class:zero={n === 0}>
								{n > 0 ? `${n}곳 발견` : '일치하는 텍스트 없음'}
							</span>
						{/if}
					</div>
				{/each}

				<button type="button" class="add" onclick={addPair}>+ 대치 규칙 추가</button>
			</div>

			<div class="r-foot">
				<span class="summary">
					{#if changed}
						{active.length}개 규칙 적용 예정
					{:else}
						바뀔 내용이 없어요
					{/if}
				</span>
				<button class="apply" onclick={apply} disabled={!changed}>적용</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 120;
		background: rgba(0, 0, 0, 0.65);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 520px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 24px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
		max-height: calc(100dvh - 40px);
		display: flex;
		flex-direction: column;
	}
	.close {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.95rem;
		z-index: 1;
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}

	.r-head {
		text-align: center;
		margin-bottom: 18px;
		flex-shrink: 0;
	}
	.r-logo {
		font-size: 1.5rem;
	}
	.r-head h2 {
		margin: 6px 0 6px;
		font-size: 1.2rem;
		font-weight: 800;
	}
	.r-head p {
		margin: 0 auto;
		max-width: 400px;
		font-size: 0.84rem;
		color: var(--text-dim);
		line-height: 1.55;
	}

	.r-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		margin-bottom: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.pair {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.pair-fields {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pair-input {
		flex: 1;
		min-width: 0;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px 12px;
		color: var(--text);
		font-size: 0.9rem;
		outline: none;
	}
	.pair-input:focus {
		border-color: var(--accent);
	}
	.pair-input::placeholder {
		color: var(--text-faint);
	}
	.arrow {
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: 0.95rem;
	}
	.pair-del {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 0.78rem;
		border-radius: 8px;
		display: grid;
		place-items: center;
	}
	.pair-del:hover {
		background: var(--bg-elev);
		color: var(--nsfw);
	}
	.match {
		font-size: 0.74rem;
		color: var(--accent);
		padding-left: 2px;
	}
	.match.zero {
		color: var(--text-faint);
	}
	.add {
		width: 100%;
		padding: 9px;
		background: transparent;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 0.84rem;
		font-weight: 600;
		transition: all 0.15s ease;
	}
	.add:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	.r-foot {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.summary {
		font-size: 0.8rem;
		color: var(--text-faint);
	}
	.apply {
		padding: 11px 22px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.9rem;
		transition: background 0.15s ease;
	}
	.apply:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.apply:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* 모바일: 여백을 줄여 폭·높이를 더 쓴다 */
	@media (max-width: 640px) {
		.backdrop {
			padding: 10px;
		}
		.modal {
			padding: 16px 14px;
			max-height: calc(100dvh - 20px);
			border-radius: 14px;
		}
	}
</style>
