<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { profileModal } from '$lib/state/profileModal.svelte';
	import { privacyMode, setHideHistory } from '$lib/state/privacyMode.svelte';

	let { user }: { user: App.Locals['user'] } = $props();

	// 첫 실행(아직 저장한 적 없음)엔 닫기 없이 '시작하기'로 한 번 저장하게 한다. 필드는 전부 선택.
	const dismissable = $derived(!!user?.profileComplete);

	let personaName = $state('');
	let persona = $state('');
	let saving = $state(false);
	let error = $state('');
	let initialized = $state(false);

	// 모달이 열릴 때 현재 프로필로 폼 초기화
	$effect(() => {
		if (profileModal.open && !initialized) {
			personaName = user?.personaName ?? '';
			persona = user?.persona ?? '';
			error = '';
			initialized = true;
		} else if (!profileModal.open && initialized) {
			initialized = false;
		}
	});

	function close() {
		if (dismissable) profileModal.open = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}

	async function save() {
		if (saving) return;
		saving = true;
		error = '';
		try {
			const fd = new FormData();
			fd.set('persona_name', personaName.trim());
			fd.set('persona', persona.trim());
			const res = await fetch('/api/profile', { method: 'POST', body: fd });
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
				<p class="sub">대화에서 '나'를 어떻게 부르고 어떤 사람으로 둘지 정해요. 전부 선택이라 비워도 돼요.</p>
			</div>



			<div class="field">
				<label for="pf-persona-name">대화용 이름 <span class="opt">(선택)</span></label>
				<input
					id="pf-persona-name"
					type="text"
					placeholder="채팅에서 AI 가 부를 이름 (비우면 '나')"
					maxlength="40"
					bind:value={personaName}
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
				<label class="toggle-row">
					<span class="toggle-text">
						<span class="field-label">브라우저 기록 숨김</span>
						<span class="toggle-desc">브라우저 탭 제목을 항상 "Haven" 으로만 표시해요.</span>
					</span>
					<input
						id="pf-hide-history"
						type="checkbox"
						class="toggle-input"
						checked={privacyMode.hideHistory}
						onchange={(e) => setHideHistory(e.currentTarget.checked)}
					/>
					<span class="toggle-switch" aria-hidden="true"></span>
				</label>
			</div>

			{#if error}<p class="error">{error}</p>{/if}

			<button class="save" onclick={save} disabled={saving}>
				{saving ? '저장 중…' : dismissable ? '저장' : '시작하기'}
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
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 420px;
		margin: auto;
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
	.field .toggle-row {
		display: flex;
		align-items: center;
		gap: 12px;
		cursor: pointer;
		margin-bottom: 0;
	}
	.toggle-text {
		flex: 1;
		min-width: 0;
	}
	.toggle-desc {
		display: block;
		font-size: 0.74rem;
		color: var(--text-faint);
		font-weight: 400;
		margin-top: 2px;
		line-height: 1.4;
	}
	.field .toggle-input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		padding: 0;
		border: none;
		background: none;
	}
	.toggle-switch {
		position: relative;
		flex-shrink: 0;
		width: 42px;
		height: 24px;
		border-radius: 999px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		transition: background 0.15s ease;
	}
	.toggle-switch::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--text-faint);
		transition:
			transform 0.15s ease,
			background 0.15s ease;
	}
	.toggle-input:checked + .toggle-switch {
		background: var(--accent);
		border-color: var(--accent);
	}
	.toggle-input:checked + .toggle-switch::after {
		transform: translateX(18px);
		background: #fff;
	}
	.toggle-input:focus-visible + .toggle-switch {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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

	/* 모바일: 바텀시트 */
	@media (max-width: 640px) {
		.backdrop {
			padding: 0;
		}
		.modal {
			max-width: none;
			margin: auto 0 0;
			max-height: calc(100dvh - 32px);
			overflow-y: auto;
			overscroll-behavior: contain;
			border-radius: 18px 18px 0 0;
			border-left: none;
			border-right: none;
			border-bottom: none;
			padding: 20px 16px calc(16px + env(safe-area-inset-bottom));
		}
		.head h2 {
			font-size: 1.1rem;
		}
		.head .sub {
			font-size: 0.82rem;
			margin-bottom: 16px;
		}
		.field {
			margin-bottom: 14px;
		}
	}
</style>
