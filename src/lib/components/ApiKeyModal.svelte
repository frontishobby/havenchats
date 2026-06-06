<script lang="ts">
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';

	interface KeyStatus {
		registered: boolean;
		isOpus: boolean;
		tier: number | null;
		updatedAt: number | null;
	}

	let status = $state<KeyStatus | null>(null);
	let loading = $state(false);
	let keyInput = $state('');
	let saving = $state(false);
	let deleting = $state(false);
	let error = $state('');
	let saved = $state(false);
	let initialized = $state(false);

	async function loadStatus() {
		loading = true;
		error = '';
		try {
			const res = await fetch('/api/keys/novelai');
			if (res.ok) status = (await res.json()) as KeyStatus;
		} catch (e) {
			console.error(e);
		} finally {
			loading = false;
		}
	}

	// 모달이 열릴 때 현재 상태 로드(닫히면 리셋).
	$effect(() => {
		if (apiKeyModal.open && !initialized) {
			initialized = true;
			keyInput = '';
			saved = false;
			error = '';
			loadStatus();
		} else if (!apiKeyModal.open && initialized) {
			initialized = false;
		}
	});

	function close() {
		apiKeyModal.open = false;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && apiKeyModal.open) close();
	}

	async function save() {
		const key = keyInput.trim();
		if (!key || saving) return;
		saving = true;
		error = '';
		saved = false;
		try {
			const res = await fetch('/api/keys/novelai', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			});
			const d = (await res.json().catch(() => ({}))) as { message?: string };
			if (res.ok) {
				keyInput = '';
				saved = true;
				await loadStatus();
			} else {
				error = d.message ?? '등록에 실패했습니다.';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : '등록에 실패했습니다.';
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (deleting) return;
		if (!confirm('등록된 NovelAI 키를 삭제할까요?')) return;
		deleting = true;
		error = '';
		try {
			const res = await fetch('/api/keys/novelai', { method: 'DELETE' });
			if (res.ok) {
				saved = false;
				await loadStatus();
			}
		} catch (e) {
			console.error(e);
		} finally {
			deleting = false;
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if apiKeyModal.open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="API 키 관리"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<button class="close" onclick={close} aria-label="닫기">✕</button>

			<div class="head">
				<h2>API 키 관리</h2>
				<p class="sub">실시간 이미지 생성에 쓸 NovelAI 키를 등록하세요.</p>
			</div>

			<div class="provider">
				<div class="provider-head">
					<strong>NovelAI</strong>
					{#if loading}
						<span class="badge pending">확인 중…</span>
					{:else if status?.registered}
						<span class="badge ok">등록됨{status.isOpus ? ' · Opus' : ''}</span>
					{:else}
						<span class="badge none">미등록</span>
					{/if}
				</div>

				<p class="hint">
					NovelAI <strong>Opus 등급</strong> 구독이 필요합니다. 키는
					<a href="https://novelai.net" target="_blank" rel="noreferrer noopener">NovelAI</a>
					계정 설정 → Account → <em>Get Persistent API Token</em> 에서 발급해요. 키는 서버에 암호화되어
					저장되며 이미지 생성에만 사용됩니다.
				</p>

				<div class="field">
					<label for="nai-key">{status?.registered ? '키 교체' : '키 등록'}</label>
					<input
						id="nai-key"
						type="password"
						placeholder="pst-..."
						autocomplete="off"
						bind:value={keyInput}
					/>
				</div>

				{#if error}
					<p class="error">{error}</p>
				{/if}
				{#if saved}
					<p class="ok-msg">저장되었습니다.</p>
				{/if}

				<div class="actions">
					{#if status?.registered}
						<button class="del" onclick={remove} disabled={deleting}>
							{deleting ? '삭제 중…' : '삭제'}
						</button>
					{/if}
					<button class="save" onclick={save} disabled={!keyInput.trim() || saving}>
						{saving ? '확인 중…' : status?.registered ? '교체' : '등록'}
					</button>
				</div>
			</div>
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
	.provider-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.provider-head strong {
		font-size: 0.98rem;
		font-weight: 700;
	}
	.badge {
		font-size: 0.72rem;
		font-weight: 700;
		padding: 3px 9px;
		border-radius: 999px;
	}
	.badge.ok {
		color: #fff;
		background: var(--accent);
	}
	.badge.none {
		color: var(--text-faint);
		background: var(--bg-elev);
		border: 1px solid var(--border);
	}
	.badge.pending {
		color: var(--text-dim);
		background: var(--bg-elev);
	}
	.hint {
		margin: 0 0 16px;
		font-size: 0.78rem;
		line-height: 1.55;
		color: var(--text-dim);
	}
	.hint strong {
		color: var(--text);
		font-weight: 600;
	}
	.hint a {
		color: var(--accent);
	}
	.field {
		margin-bottom: 14px;
	}
	.field label {
		display: block;
		font-size: 0.82rem;
		font-weight: 600;
		margin-bottom: 6px;
		color: var(--text);
	}
	.field input {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px 12px;
		color: var(--text);
		font-size: 0.92rem;
		outline: none;
	}
	.field input:focus {
		border-color: var(--accent);
	}
	.error {
		margin: 0 0 12px;
		font-size: 0.8rem;
		color: var(--nsfw);
	}
	.ok-msg {
		margin: 0 0 12px;
		font-size: 0.8rem;
		color: var(--accent);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}
	.save {
		padding: 9px 20px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-size: 0.88rem;
		font-weight: 600;
	}
	.save:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.save:not(:disabled):hover {
		background: var(--accent-hover);
	}
	.del {
		padding: 9px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-dim);
		font-size: 0.88rem;
		font-weight: 600;
	}
	.del:hover {
		color: var(--nsfw);
		border-color: var(--nsfw);
	}
</style>
