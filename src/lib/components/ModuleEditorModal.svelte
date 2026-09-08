<script lang="ts">
	import type { PromptModule } from '$lib/types';
	import type { ModuleUpsertBody } from '$lib/api/modules';

	/**
	 * 모듈 만들기/수정 모달 — 제목·메모·본문·공개 여부.
	 * edit 가 있으면 그 값으로 채워 열고 PATCH, 없으면 POST 로 생성. 저장 후 onSaved(id).
	 */
	let {
		open = $bindable(false),
		edit = null,
		onSaved
	}: {
		open?: boolean;
		edit?: PromptModule | null;
		onSaved?: (id: string) => void | Promise<void>;
	} = $props();

	const MAX_TITLE = 60;
	const MAX_MEMO = 500;
	const MAX_PROMPT = 4000;

	let title = $state('');
	let memo = $state('');
	let prompt = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	// 열릴 때마다 폼 초기화(수정이면 기존 값).
	$effect(() => {
		if (!open) return;
		title = edit?.title ?? '';
		memo = edit?.memo ?? '';
		prompt = edit?.prompt ?? '';
		error = null;
	});

	const canSave = $derived(title.trim() !== '' && prompt.trim() !== '' && !saving);

	function close() {
		if (saving) return;
		open = false;
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		error = null;
		const body: ModuleUpsertBody = {
			title: title.trim().slice(0, MAX_TITLE),
			memo: memo.trim().slice(0, MAX_MEMO),
			prompt: prompt.trim().slice(0, MAX_PROMPT),
			shared: true
		};
		try {
			const res = await fetch(edit ? `/api/modules/${edit.id}` : '/api/modules', {
				method: edit ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				error = d.message ?? d.error ?? `저장 실패 (HTTP ${res.status})`;
				return;
			}
			const d = (await res.json()) as { id: string };
			open = false;
			await onSaved?.(d.id ?? edit?.id ?? '');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) close();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label={edit ? '모듈 수정' : '모듈 만들기'}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="head">
				<h2>{edit ? '모듈 수정' : '모듈 만들기'}</h2>
				<button class="close" onclick={close} aria-label="닫기">✕</button>
			</div>
			<p class="hint">
				캐릭터와 무관하게 재사용할 <strong>일반 지침</strong>(출력 규칙, 문체, 금기 등)을 적어두세요.
				채팅에서 켜면 매 응답의 프롬프트 <strong>맨 끝</strong>에 첨부됩니다. <code>{'{{char}}'}</code>·<code>{'{{나}}'}</code> 사용 가능.
			</p>

			<label class="field">
				<span class="label">제목 <em>{title.length}/{MAX_TITLE}</em></span>
				<input type="text" bind:value={title} maxlength={MAX_TITLE} placeholder="예: 대사 위주 출력" />
			</label>
			<label class="field">
				<span class="label">메모(선택) <em>{memo.length}/{MAX_MEMO}</em></span>
				<input type="text" bind:value={memo} maxlength={MAX_MEMO} placeholder="어떤 효과인지 한 줄 설명" />
			</label>
			<label class="field">
				<span class="label">모듈 본문 <em>{prompt.length}/{MAX_PROMPT}</em></span>
				<textarea
					bind:value={prompt}
					rows="10"
					maxlength={MAX_PROMPT}
					placeholder={'예:\n- 서술보다 대사 비중을 높여라(대사 60% 이상).\n- 매 응답 끝에 캐릭터의 속마음을 한 줄 괄호로 덧붙여라.'}
				></textarea>
			</label>

			{#if error}<p class="err">{error}</p>{/if}
			<div class="actions">
				<button class="ghost" onclick={close} disabled={saving}>취소</button>
				<button class="primary" onclick={save} disabled={!canSave}>
					{saving ? '저장 중…' : '저장'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 120;
		background: rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.modal {
		width: 100%;
		max-width: 560px;
		max-height: calc(100dvh - 40px);
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.head h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 800;
	}
	.close {
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
	.hint {
		margin: 0 0 14px;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text-dim);
	}
	.hint strong {
		color: var(--text);
	}
	.hint code {
		font-size: 0.74rem;
		padding: 1px 4px;
		border-radius: 4px;
		background: var(--bg-elev);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}
	.label {
		display: flex;
		justify-content: space-between;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text);
	}
	.label em {
		font-style: normal;
		font-weight: 500;
		color: var(--text-faint);
	}
	input,
	textarea {
		width: 100%;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text);
		font-size: 0.86rem;
		line-height: 1.5;
		font-family: inherit;
	}
	textarea {
		resize: vertical;
		min-height: 140px;
	}
	input:focus,
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	.err {
		margin: 12px 0 0;
		font-size: 0.8rem;
		color: var(--nsfw, #f59e0b);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 18px;
	}
	.ghost {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-dim);
		font-weight: 700;
		font-size: 0.85rem;
	}
	.primary {
		padding: 10px 20px;
		border-radius: var(--radius-sm);
		border: none;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.85rem;
	}
	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.primary:disabled {
		opacity: 0.5;
	}
</style>
