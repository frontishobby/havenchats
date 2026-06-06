<script lang="ts">
	// 차단된 유저에게 표시되는 종료 불가 모달. 백드롭 클릭·Esc·닫기 버튼 모두 없음.
	// 유일한 탈출구는 로그아웃(잘못 차단된 경우 계정 전환용). 그 외 모든 동작 차단.
	let { reason }: { reason: string } = $props();

	// 모달이 떠 있는 동안 배경 스크롤 차단.
	$effect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	});

	// Esc 등 키 입력으로 닫히지 않도록 — 별도 동작 없음(존재만으로 충분하지만 명시).
	function swallow(e: KeyboardEvent) {
		if (e.key === 'Escape') e.preventDefault();
	}
</script>

<svelte:window onkeydown={swallow} />

<div class="backdrop" role="dialog" aria-modal="true" aria-label="계정 차단 안내">
	<div class="modal">
		<span class="icon">🚫</span>
		<h2>이용이 제한된 계정입니다</h2>
		<p class="reason">{reason}</p>
		<p class="sub">
			서비스 이용이 차단되었습니다. 문의가 필요하면 운영자에게 연락해 주세요.
		</p>
		<a class="logout" href="/auth/logout" data-sveltekit-preload-data="off">로그아웃</a>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 9999; /* 모든 UI(사이드바·네비·다른 모달) 위 */
		background: rgba(0, 0, 0, 0.82);
		backdrop-filter: blur(6px);
		display: grid;
		place-items: center;
		padding: 20px;
	}
	.modal {
		width: 100%;
		max-width: 420px;
		background: var(--bg-card);
		border: 1px solid var(--nsfw);
		border-radius: var(--radius);
		padding: 36px 28px 26px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
		text-align: center;
	}
	.icon {
		font-size: 2.4rem;
	}
	.modal h2 {
		margin: 14px 0 12px;
		font-size: 1.3rem;
		font-weight: 800;
		color: var(--text);
	}
	.reason {
		margin: 0 0 14px;
		padding: 12px 14px;
		background: rgba(255, 92, 138, 0.1);
		border: 1px solid rgba(255, 92, 138, 0.35);
		border-radius: var(--radius-sm);
		font-size: 0.92rem;
		line-height: 1.5;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.sub {
		margin: 0 0 22px;
		font-size: 0.82rem;
		color: var(--text-dim);
		line-height: 1.5;
	}
	.logout {
		display: inline-block;
		padding: 10px 22px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 0.88rem;
		font-weight: 600;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.logout:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
</style>
