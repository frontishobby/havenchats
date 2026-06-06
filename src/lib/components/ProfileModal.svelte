<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { profileModal } from '$lib/state/profileModal.svelte';

	let { user }: { user: App.Locals['user'] } = $props();

	const dismissable = $derived(!!user?.profileComplete);

	const ACCEPT = ['image/webp', 'image/avif'];
	const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

	let name = $state('');
	let personaName = $state('');
	let persona = $state('');
	let preference = $state<'male' | 'female' | null>(null);
	let saving = $state(false);
	let error = $state('');
	let initialized = $state(false);

	// 프로필 사진
	let avatarFile = $state<File | null>(null);
	let avatarPreview = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	// 새로 고른 사진 > 기존 프로필 사진 > 없음(이니셜 폴백)
	const displayAvatar = $derived(avatarPreview ?? user?.avatarUrl ?? null);

	function resetAvatar() {
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		avatarFile = null;
		avatarPreview = null;
		if (fileInput) fileInput.value = '';
	}

	function setAvatar(file: File | undefined | null) {
		if (!file) return;
		if (!ACCEPT.includes(file.type)) {
			error = '프로필 사진은 webp 또는 avif 이미지만 가능해요.';
			return;
		}
		if (file.size > AVATAR_MAX_BYTES) {
			error = '이미지 용량이 너무 커요 (최대 3MB).';
			return;
		}
		error = '';
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		avatarFile = file;
		avatarPreview = URL.createObjectURL(file);
	}

	function onAvatarChange(e: Event) {
		setAvatar((e.target as HTMLInputElement).files?.[0]);
	}

	// 모달이 열릴 때 현재 프로필로 폼 초기화
	$effect(() => {
		if (profileModal.open && !initialized) {
			name = user?.name ?? '';
			personaName = user?.personaName ?? '';
			persona = user?.persona ?? '';
			preference = user?.preference ?? null;
			error = '';
			resetAvatar();
			initialized = true;
		} else if (!profileModal.open && initialized) {
			resetAvatar();
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
			const fd = new FormData();
			fd.set('name', name.trim());
			fd.set('persona_name', personaName.trim());
			fd.set('persona', persona.trim());
			if (preference) fd.set('preference', preference);
			if (avatarFile) fd.set('avatar', avatarFile);
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
				<p class="sub">대화에 사용할 정보를 설정해 주세요.</p>
			</div>

			<div class="avatar-field">
				<button
					type="button"
					class="avatar-pick"
					onclick={() => fileInput?.click()}
					aria-label="프로필 사진 선택"
				>
					{#if displayAvatar}
						<img src={displayAvatar} alt="프로필 사진" />
					{:else}
						<span class="avatar-fallback">
							{(name || user?.email || '?').charAt(0).toUpperCase()}
						</span>
					{/if}
					<span class="avatar-cam">📷</span>
				</button>
				<span class="avatar-hint">프로필 사진 <span class="opt">(webp · avif, 선택)</span></span>
				<input
					bind:this={fileInput}
					type="file"
					accept="image/webp,image/avif"
					class="hidden-input"
					onchange={onAvatarChange}
				/>
			</div>

			<div class="field">
				<label for="pf-name">이름</label>
				<input
					id="pf-name"
					type="text"
					placeholder="다른 사람에게 보여질 이름"
					maxlength="40"
					bind:value={name}
				/>
			</div>

			<div class="field">
				<label for="pf-persona-name">대화용 이름 <span class="opt">(선택)</span></label>
				<input
					id="pf-persona-name"
					type="text"
					placeholder="채팅에서 AI 가 부를 이름 (비우면 위 이름 사용)"
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
	.avatar-field {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		margin-bottom: 20px;
	}
	.avatar-pick {
		position: relative;
		width: 84px;
		height: 84px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-elev);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transition: border-color 0.15s ease;
	}
	.avatar-pick:hover {
		border-color: var(--accent);
	}
	.avatar-pick img {
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
		font-size: 2rem;
		font-weight: 700;
		color: #fff;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
	}
	.avatar-cam {
		position: absolute;
		right: 2px;
		bottom: 2px;
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		font-size: 0.8rem;
		border-radius: 50%;
		background: var(--bg-card);
		border: 1px solid var(--border);
	}
	.avatar-hint {
		font-size: 0.78rem;
		color: var(--text-dim);
	}
	.hidden-input {
		display: none;
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
