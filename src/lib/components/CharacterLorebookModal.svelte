<script module lang="ts">
	import type { LoreEntry } from '$lib/types';
	export type { LoreEntry };
</script>

<script lang="ts">
	import { LORE_ENTRIES_MAX, LORE_CONTENT_MAX } from '$lib/lorebook';

	let {
		open,
		initialEntries,
		onclose,
		onapply
	}: {
		open: boolean;
		initialEntries: LoreEntry[];
		onclose: () => void;
		onapply: (entries: LoreEntry[]) => void;
	} = $props();

	/** 편집용 working 항목 — keys 는 콤마 문자열 한 줄로 다룬다. */
	interface WorkingLore {
		id: string;
		keysText: string;
		content: string;
		constant: boolean;
		order: number;
	}

	let entries = $state<WorkingLore[]>([]);
	let error = $state('');

	// 모달이 열릴 때 부모 항목을 복사해 편집 시작.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			entries = initialEntries.map((e) => ({
				id: e.id,
				keysText: e.keys.join(', '),
				content: e.content,
				constant: e.constant,
				order: e.order
			}));
			error = '';
		}
		wasOpen = open;
	});

	function uid(): string {
		return crypto.randomUUID();
	}

	function addEntry() {
		if (entries.length >= LORE_ENTRIES_MAX) return;
		entries = [...entries, { id: uid(), keysText: '', content: '', constant: false, order: 0 }];
	}

	function removeEntry(i: number) {
		entries = entries.filter((_, idx) => idx !== i);
	}

	function splitKeys(text: string): string[] {
		const seen = new Set<string>();
		return text
			.split(',')
			.map((k) => k.trim())
			.filter((k) => k !== '' && !seen.has(k.toLowerCase()) && (seen.add(k.toLowerCase()), true));
	}

	function apply() {
		const result: LoreEntry[] = [];
		for (const e of entries) {
			const content = e.content.trim();
			const keys = e.constant ? [] : splitKeys(e.keysText);
			if (!content) continue; // 빈 본문은 버림
			if (!e.constant && keys.length === 0) {
				error = '키워드가 없는 항목이 있어요. 키워드를 넣거나 "항상 켜기"로 바꿔 주세요.';
				return;
			}
			result.push({
				id: e.id,
				keys,
				content,
				constant: e.constant,
				order: Number.isFinite(e.order) ? e.order : 0
			});
		}
		onapply(result);
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onclose} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="로어북 관리"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="head">
				<h2>로어북 관리</h2>
				<button class="close" onclick={onclose} aria-label="닫기">✕</button>
			</div>

			<p class="intro">
				키워드가 최근 대화에 등장하면 해당 <strong>설정</strong>이 그때 프롬프트에 주입돼요. 항상 반영할
				항목은 <strong>“항상 켜기”</strong>로 두세요. (캐릭터당 최대 {LORE_ENTRIES_MAX}개)
			</p>

			{#if error}<p class="error">{error}</p>{/if}

			<div class="list">
				{#each entries as entry, i (entry.id)}
					<div class="entry">
						<div class="entry-head">
							<label class="const">
								<input type="checkbox" bind:checked={entries[i].constant} />
								항상 켜기
							</label>
							<input
								class="order"
								type="number"
								bind:value={entries[i].order}
								title="우선순위(높을수록 먼저)"
								aria-label="우선순위"
							/>
							<button class="del" onclick={() => removeEntry(i)} aria-label="항목 삭제">✕</button>
						</div>
						<input
							class="keys"
							type="text"
							placeholder={entry.constant ? '항상 켜짐 — 키워드 불필요' : '키워드 (쉼표로 구분, 예: 비밀, 과거)'}
							disabled={entry.constant}
							bind:value={entries[i].keysText}
						/>
						<textarea
							class="content"
							rows="3"
							maxlength={LORE_CONTENT_MAX}
							placeholder="이 키워드가 나오면 반영할 설정·배경"
							bind:value={entries[i].content}
						></textarea>
					</div>
				{/each}

				{#if entries.length === 0}
					<p class="empty">아직 항목이 없어요. 아래에서 추가하세요.</p>
				{/if}
			</div>

			{#if entries.length < LORE_ENTRIES_MAX}
				<button class="ghost add" onclick={addEntry}>+ 항목 추가</button>
			{/if}

			<div class="foot">
				<button class="cancel" onclick={onclose}>취소</button>
				<button class="apply" onclick={apply}>완료</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
		z-index: 100;
	}
	.modal {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		width: 100%;
		max-width: 640px;
		max-height: 88vh;
		overflow-y: auto;
		padding: 20px;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.head h2 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 800;
	}
	.close {
		background: transparent;
		border: none;
		color: var(--text-dim);
		font-size: 1rem;
		cursor: pointer;
	}
	.intro {
		margin: 0 0 14px;
		font-size: 0.84rem;
		color: var(--text-dim);
		line-height: 1.5;
	}
	.error {
		background: rgba(255, 92, 92, 0.12);
		border: 1px solid rgba(255, 92, 92, 0.4);
		color: #ff8a8a;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.82rem;
		margin: 0 0 12px;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.entry {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 12px;
		background: var(--bg-elev);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.entry-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.const {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.82rem;
		color: var(--text-dim);
		cursor: pointer;
	}
	.order {
		width: 56px;
		margin-left: auto;
		padding: 4px 6px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.8rem;
	}
	.del {
		background: transparent;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 0.9rem;
	}
	.del:hover {
		color: #ff8a8a;
	}
	.keys,
	.content {
		width: 100%;
		padding: 8px 10px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.86rem;
		font-family: inherit;
		box-sizing: border-box;
	}
	.keys:disabled {
		opacity: 0.5;
	}
	.content {
		resize: vertical;
		line-height: 1.5;
	}
	.empty {
		font-size: 0.84rem;
		color: var(--text-faint);
		text-align: center;
		padding: 16px 0;
	}
	.ghost {
		background: transparent;
		border: 1px dashed var(--border);
		color: var(--text-dim);
		border-radius: var(--radius-sm);
		padding: 8px 12px;
		cursor: pointer;
		font-size: 0.84rem;
	}
	.ghost:hover {
		border-color: var(--accent);
		color: var(--text);
	}
	.add {
		width: 100%;
		margin-top: 12px;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 18px;
	}
	.foot button {
		padding: 9px 18px;
		border-radius: var(--radius-sm);
		font-weight: 700;
		font-size: 0.86rem;
		cursor: pointer;
	}
	.cancel {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-dim);
	}
	.apply {
		background: var(--accent);
		border: none;
		color: #fff;
	}
</style>
