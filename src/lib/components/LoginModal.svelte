<script lang="ts">
	import { loginModal } from '$lib/state/loginModal.svelte';

	function close() {
		loginModal.open = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && loginModal.open) close();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if loginModal.open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="로그인"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<button class="close" onclick={close} aria-label="닫기">✕</button>

			<div class="head">
				<span class="logo">✦</span>
				<h2>Haven에 로그인</h2>
				<p class="sub">로그인하고 모든 캐릭터와 이야기를 시작하세요.</p>
			</div>

			<div class="providers">
				<a class="provider" href="/auth/google" data-sveltekit-preload-data="off">
					<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
						<path
							fill="#EA4335"
							d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
						/>
						<path
							fill="#4285F4"
							d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
						/>
						<path
							fill="#FBBC05"
							d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
						/>
						<path
							fill="#34A853"
							d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
						/>
					</svg>
					<span>Google로 계속하기</span>
				</a>
				<!-- 추후 다른 로그인 옵션을 여기에 추가 -->
			</div>

			<p class="terms">계속하면 서비스 약관 및 개인정보처리방침에 동의하는 것으로 간주됩니다.</p>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.65);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 20px;
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 380px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 32px 24px 22px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
		text-align: center;
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
	.head .logo {
		font-size: 1.8rem;
		color: var(--accent);
	}
	.head h2 {
		margin: 8px 0 6px;
		font-size: 1.25rem;
		font-weight: 800;
	}
	.head .sub {
		margin: 0 0 22px;
		font-size: 0.88rem;
		color: var(--text-dim);
		line-height: 1.5;
	}
	.providers {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.provider {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 12px 16px;
		border-radius: var(--radius-sm);
		background: #fff;
		color: #1f1f1f;
		font-weight: 600;
		font-size: 0.92rem;
		transition: opacity 0.15s ease;
	}
	.provider:hover {
		opacity: 0.9;
	}
	.terms {
		margin: 18px 0 0;
		font-size: 0.7rem;
		color: var(--text-faint);
		line-height: 1.5;
	}
</style>
