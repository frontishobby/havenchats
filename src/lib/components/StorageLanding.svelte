<script lang="ts">
	import {
		sync,
		chooseLocal,
		connectDrive,
		continueOffline,
		resolveConflict,
		syncNow
	} from '$lib/local/sync.svelte';

	let busy = $state(false);

	async function onDrive() {
		if (busy) return;
		busy = true;
		try {
			await connectDrive();
		} finally {
			busy = false;
		}
	}
	async function onReconnect() {
		if (busy) return;
		busy = true;
		try {
			await syncNow();
		} finally {
			busy = false;
		}
	}
	async function onResolve(pick: 'remote' | 'local') {
		if (busy) return;
		busy = true;
		try {
			await resolveConflict(pick);
		} finally {
			busy = false;
		}
	}

	const syncing = $derived(sync.status === 'syncing');
	const fmt = (iso: string) => {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR');
	};
</script>

<div class="landing">
	<div class="card">
		<div class="brand"><span class="logo">✦</span> Haven<span class="dim">chats</span></div>

		{#if sync.conflict}
			<h1>어느 쪽 데이터를 쓸까요?</h1>
			<p class="sub">
				Drive 에 있는 데이터와 이 기기의 데이터가 다릅니다. (Drive 마지막 수정: {fmt(
					sync.conflict.remoteModified
				)})
			</p>
			<div class="choices">
				<button class="choice" onclick={() => onResolve('remote')} disabled={busy}>
					<strong>Drive 데이터 사용</strong>
					<span>이 기기의 데이터를 Drive 것으로 덮어씁니다.</span>
				</button>
				<button class="choice" onclick={() => onResolve('local')} disabled={busy}>
					<strong>이 기기 데이터 사용</strong>
					<span>Drive 의 데이터를 이 기기 것으로 덮어씁니다.</span>
				</button>
			</div>
		{:else if syncing}
			<h1>동기화 중</h1>
			<p class="sub">{sync.phase || 'Google Drive 와 맞추는 중…'}</p>
			<div class="spinner"></div>
		{:else if sync.mode === 'drive'}
			<h1>Google Drive 다시 연결</h1>
			<p class="sub">Drive 접근 권한이 만료됐어요. 다시 연결하면 최신 데이터로 맞춥니다.</p>
			{#if sync.error}<p class="err">{sync.error}</p>{/if}
			<button class="primary" onclick={onReconnect} disabled={busy}>Google Drive 다시 연결</button>
			<button class="link" onclick={continueOffline}>연결 없이 계속 (변경은 나중에 올라감)</button>
		{:else}
			<h1>데이터를 어디에 저장할까요?</h1>
			<p class="sub">
				이 페이지는 서버가 없어요. 캐릭터·대화·이미지는 전부 여러분의 저장소에 남습니다.
			</p>
			{#if sync.error}<p class="err">{sync.error}</p>{/if}
			<div class="choices">
				<button class="choice" onclick={onDrive} disabled={busy || sync.clientIdMissing}>
					<strong>Google Drive 에 저장</strong>
					<span>
						Google 계정의 앱 전용 폴더에 저장하고 다른 기기와 동기화해요.
						{#if sync.clientIdMissing}(클라이언트 ID 미설정){/if}
					</span>
				</button>
				<button class="choice" onclick={chooseLocal} disabled={busy}>
					<strong>이 기기에만 저장</strong>
					<span>브라우저 저장소(IndexedDB)에만 남아요. 브라우저 데이터를 지우면 사라집니다.</span>
				</button>
			</div>
			<p class="hint">나중에 프로필 메뉴 › 저장소에서 바꿀 수 있어요. 백업 zip 내보내기/가져오기도 거기에.</p>
		{/if}
	</div>
</div>

<style>
	.landing {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: grid;
		place-items: center;
		padding: 20px;
		background: var(--bg);
	}
	.card {
		width: 100%;
		max-width: 460px;
		padding: 32px 28px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.brand {
		font-weight: 800;
		font-size: 1.1rem;
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text);
	}
	.logo {
		color: var(--accent);
	}
	.dim {
		color: var(--text-dim);
		font-weight: 600;
	}
	h1 {
		margin: 8px 0 0;
		font-size: 1.35rem;
	}
	.sub {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.choices {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 6px;
	}
	.choice {
		text-align: left;
		padding: 14px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
		color: var(--text);
		display: flex;
		flex-direction: column;
		gap: 4px;
		cursor: pointer;
	}
	.choice:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--bg-card-hover);
	}
	.choice:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.choice strong {
		font-size: 0.98rem;
	}
	.choice span {
		font-size: 0.8rem;
		color: var(--text-dim);
		line-height: 1.45;
	}
	.primary {
		padding: 12px 16px;
		border: none;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
	}
	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.link {
		background: none;
		border: none;
		color: var(--text-dim);
		font-size: 0.82rem;
		text-decoration: underline;
		cursor: pointer;
	}
	.hint {
		margin: 4px 0 0;
		font-size: 0.76rem;
		color: var(--text-faint);
	}
	.err {
		margin: 0;
		font-size: 0.82rem;
		color: #ff7b7b;
	}
	.spinner {
		width: 26px;
		height: 26px;
		margin: 8px auto 0;
		border: 3px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
