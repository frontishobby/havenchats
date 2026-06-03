<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { profileModal } from '$lib/state/profileModal.svelte';

	let { user }: { user: App.Locals['user'] } = $props();

	const dismissable = $derived(!!user?.profileComplete);

	let name = $state('');
	let persona = $state('');
	let preference = $state<'male' | 'female' | null>(null);
	let saving = $state(false);
	let error = $state('');
	let initialized = $state(false);

	// 모달이 열릴 때 현재 프로필로 폼 초기화
	$effect(() => {
		if (profileModal.open && !initialized) {
			name = user?.name ?? '';
			persona = user?.persona ?? '';
			preference = user?.preference ?? null;
			error = '';
			initialized = true;
		} else if (!profileModal.open && initialized) {
			initialized = false;
		}
	});

	const canSave = $derived(name.trim().length > 0 && preference !== null);

	function close() {
		if (dismissable) profileModal.open = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}

	async function save() {
		if (!canSave || saving) return;
		saving = true;
		error = '';
		try {
			const res = await fetch('/api/profile', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), persona: persona.trim(), preference })
			});
			if (!res.ok) {
				const j = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(j.error ?? '저장에 실패했어요.');
			}
			await invalidateAll();
			profileModal.open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : '저장에 실패했어요.';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if profileModal.open && user}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="프로필 설정"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			{#if dismissable}
				<button class="close" onclick={close} aria-label="닫기">✕</button>
			{/if}

			<div class="head">
				<h2>{dismissable ? '프로필 수정' : '프로필 설정'}</h2>
				<p class="sub">대화에 사용할 정보를 설정해 주세요.</p>
			</div>

			<div class="field">
				<label for="pf-name">이름</label>
				<input
					id="pf-name"
					type="text"
					placeholder="대화에서 불릴 이름"
					maxlength="40"
					bind:value={name}
				/>
			</div>

			<div class="field">
				<label for="pf-persona">페르소나 <span class="opt">(선택)</span></label>
				<textarea
					id="pf-persona"
					rows="3"
					placeholder="모든 대화에 적용할 '나'의 설정 (성격, 배경 등)"
					maxlength="2000"
					bind:value={persona}
				></textarea>
			</div>

			<div class="field">
				<span class="field-label">취향</span>
				<div class="pref">
					<button
						type="button"
						class="pref-btn"
						class:active={preference === 'male'}
						onclick={() => (preference = 'male')}
					>
						<strong>남성향</strong>
						<span>여성 캐릭터 위주</span>
					</button>
					<button
						type="button"
						class="pref-btn"
						class:active={preference === 'female'}
						onclick={() => (preference = 'female')}
					>
						<strong>여성향</strong>
						<span>남성 캐릭터 위주</span>
					</button>
				</div>
			</div>

			{#if error}<p class="error">{error}</p>{/if}

			<button class="save" onclick={save} disabled={!canSave || saving}>
				{saving ? '저장 중…' : '시작하기'}
			</button>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 110;
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
		max-width: 420px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 26px 24px 22px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
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
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
	.head h2 {
		margin: 0 0 6px;
		font-size: 1.2rem;
		font-weight: 800;
	}
	.head .sub {
		margin: 0 0 20px;
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.field {
		margin-bottom: 16px;
	}
	.field label,
	.field .field-label {
		display: block;
		font-size: 0.82rem;
		font-weight: 600;
		margin-bottom: 6px;
		color: var(--text);
	}
	.opt {
		color: var(--text-faint);
		font-weight: 400;
	}
	.field input,
	.field textarea {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px 12px;
		color: var(--text);
		font-size: 0.92rem;
		outline: none;
		resize: none;
		line-height: 1.5;
	}
	.field input:focus,
	.field textarea:focus {
		border-color: var(--accent);
	}
	.pref {
		display: flex;
		gap: 10px;
	}
	.pref-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		text-align: center;
		transition: all 0.15s ease;
	}
	.pref-btn span {
		font-size: 0.72rem;
		color: var(--text-faint);
	}
	.pref-btn.active {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.pref-btn.active span {
		color: var(--text-dim);
	}
	.error {
		margin: 0 0 12px;
		font-size: 0.8rem;
		color: var(--nsfw);
	}
	.save {
		width: 100%;
		padding: 12px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.95rem;
		transition: background 0.15s ease;
	}
	.save:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.save:not(:disabled):hover {
		background: var(--accent-hover);
	}
</style>
