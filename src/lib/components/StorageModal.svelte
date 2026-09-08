<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { storageModal } from '$lib/state/storageModal.svelte';
	import { sync, connectDrive, disconnectDrive, syncNow, remoteSummary, downloadAllImages, cancelSync, type RemoteSummary } from '$lib/local/sync.svelte';
	import { exportBackup, importBackup, type BackupProgress } from '$lib/local/backup';

	let busy = $state<string | null>(null);
	let msg = $state<string | null>(null);
	let err = $state<string | null>(null);
	let remote = $state<RemoteSummary | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let progress = $state<BackupProgress | null>(null);
	const PRUNE_KEEP = 50;
	let prune = $state<{ total: number; prunable: number; images: number } | null>(null);

	$effect(() => {
		if (storageModal.open) {
			msg = null;
			err = null;
			remote = null;
			if (sync.mode === 'drive') void remoteSummary().then((r) => (remote = r));
			prune = null;
			void fetch(`/api/chat/prune?keep=${PRUNE_KEEP}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((j) => (prune = j as typeof prune))
				.catch(() => {});
		}
	});

	function close() {
		if (busy) return;
		storageModal.open = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}

	async function guard(label: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = label;
		msg = null;
		err = null;
		try {
			await fn();
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	}

	const onConnect = () =>
		guard('connect', async () => {
			await connectDrive();
			if (sync.error) err = sync.error;
			else {
				msg = 'Google Drive 와 연결됐어요.';
				remote = await remoteSummary();
			}
		});
	const onSync = () =>
		guard('sync', async () => {
			await syncNow();
			if (sync.error) err = sync.error;
			else msg = '동기화했어요.';
			remote = await remoteSummary();
		});
	const onDisconnect = () =>
		guard('disconnect', async () => {
			if (!confirm('Drive 연결을 해제할까요? 이 기기의 데이터는 그대로 남고, Drive 의 파일도 지우지 않아요.')) return;
			await disconnectDrive();
			msg = 'Drive 연결을 해제했어요. 이제 이 기기에만 저장돼요.';
		});
	const onExport = () =>
		guard('export', async () => {
			try {
				const bytes = await exportBackup((p) => (progress = p));
				msg = `백업 zip 을 저장했어요 (${fmtBytes(bytes)}).`;
			} catch (e) {
				if ((e as Error)?.name === 'AbortError') return; // 저장 대화상자 취소
				throw e;
			} finally {
				progress = null;
			}
		});
	const onDownloadAll = () =>
		guard('download', async () => {
			const r = await downloadAllImages();
			msg = r.total === 0 ? '이미 전부 이 기기에 있어요.' : `이미지 ${r.downloaded}/${r.total}개를 내려받았어요.`;
		});
	const onPrune = () =>
		guard('prune', async () => {
			if (!prune || prune.prunable === 0) return;
			if (
				!confirm(
					`최근 ${PRUNE_KEEP}개를 제외한 오래된 채팅 ${prune.prunable}개(이미지 ${prune.images}장 포함)를 삭제할까요? 되돌릴 수 없습니다.`
				)
			)
				return;
			const res = await fetch('/api/chat/prune', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ keep: PRUNE_KEEP })
			});
			if (!res.ok) throw new Error('정리에 실패했어요.');
			const j = (await res.json()) as { deleted: number; images: number };
			await invalidateAll();
			prune = (await (await fetch(`/api/chat/prune?keep=${PRUNE_KEEP}`)).json()) as typeof prune;
			msg = `채팅 ${j.deleted}개, 이미지 ${j.images}장을 지웠어요.${sync.mode === 'drive' ? ' Drive 에서도 지워져요.' : ''}`;
		});
	function onPickImport() {
		fileInput?.click();
	}
	function onImportFile(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (fileInput) fileInput.value = '';
		if (!f) return;
		void guard('import', async () => {
			if (!confirm('백업을 가져오면 현재 데이터(캐릭터·대화·설정)가 zip 의 내용으로 바뀝니다. 계속할까요?')) return;
			try {
				const r = await importBackup(f, (p) => (progress = p));
				await invalidateAll();
				msg = `가져왔어요. 이미지 ${r.images}개.${sync.mode === 'drive' ? ' Drive 에도 곧 올라가요.' : ''}`;
			} finally {
				progress = null;
			}
		});
	}

	const fmtBytes = (n: number) =>
		n >= 1024 ** 3
			? `${(n / 1024 ** 3).toFixed(2)} GB`
			: n >= 1024 * 1024
				? `${(n / 1024 / 1024).toFixed(1)} MB`
				: `${(n / 1024).toFixed(0)} KB`;
	const statusText = $derived(
		sync.mode !== 'drive'
			? '이 기기에만 저장'
			: sync.status === 'syncing'
				? sync.phase || '동기화 중…'
				: sync.status === 'needs-auth'
					? 'Drive 재연결 필요'
					: sync.status === 'error'
						? '동기화 오류'
						: sync.pending > 0
							? `올릴 변경 ${sync.pending}건 대기`
							: '동기화됨'
	);
</script>

<svelte:window onkeydown={onKey} />

{#if storageModal.open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation">
		<div class="modal" role="dialog" aria-modal="true" aria-label="저장소" tabindex="-1" onclick={(e) => e.stopPropagation()}>
			<button class="close" onclick={close} aria-label="닫기">✕</button>
			<h2>저장소</h2>

			<section>
				<div class="row">
					<span class="k">현재</span>
					<span class="v">{statusText}</span>
				</div>
				{#if sync.mode === 'drive'}
					<div class="row">
						<span class="k">마지막 동기화</span>
						<span class="v">{sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString('ko-KR') : '—'}</span>
					</div>
					<div class="row">
						<span class="k">Haven 이 쓰는 용량</span>
						<span class="v">{remote ? `${fmtBytes(remote.bytes)} · ${remote.files}개 파일` : '…'}</span>
					</div>
					<div class="row">
						<span class="k">Google Drive 전체</span>
						<span class="v">
							{#if remote}
								{fmtBytes(remote.quotaUsage)} / {remote.quotaLimit === null ? '무제한' : fmtBytes(remote.quotaLimit)}
								{#if remote.quotaLimit}
									<span class="pct">({((remote.quotaUsage / remote.quotaLimit) * 100).toFixed(0)}%)</span>
								{/if}
							{:else}…{/if}
						</span>
					</div>
					{#if remote?.quotaLimit}
						<div class="bar" aria-hidden="true">
							<span class="bar-haven" style:width="{Math.min(100, (remote.bytes / remote.quotaLimit) * 100)}%"></span>
							<span class="bar-other" style:width="{Math.min(100, (Math.max(0, remote.quotaUsage - remote.bytes) / remote.quotaLimit) * 100)}%"></span>
						</div>
						<p class="hint legend"><span class="sw haven"></span>Haven <span class="sw other"></span>다른 파일</p>
					{/if}
					{#if sync.error}<p class="err">{sync.error}</p>{/if}
					<div class="actions">
						{#if sync.status === 'syncing' && sync.cancellable}
							<button class="primary" onclick={cancelSync}>동기화 취소</button>
						{:else}
							<button class="primary" onclick={onSync} disabled={!!busy || sync.status === 'syncing'}>지금 동기화</button>
						{/if}
						<button class="ghost" onclick={onDownloadAll} disabled={!!busy} title="다른 기기에서 만든 이미지는 볼 때 내려받아요. 오프라인 대비로 미리 전부 받으려면.">
							{busy === 'download' ? sync.phase || '내려받는 중…' : '이미지 전부 내려받기'}
						</button>
						<button class="ghost" onclick={onDisconnect} disabled={!!busy}>연결 해제</button>
					</div>
				{:else}
					<p class="hint">브라우저 저장소(IndexedDB)에만 남아요. Google Drive 에 연결하면 다른 기기와 동기화돼요.</p>
					<div class="actions">
						<button class="primary" onclick={onConnect} disabled={!!busy || sync.clientIdMissing}>
							Google Drive 연결
						</button>
					</div>
				{/if}
			</section>

			<section>
				<h3>정리</h3>
				<p class="hint">
					오래된 채팅을 지워 용량을 줄여요. 마지막 대화 기준 최근 {PRUNE_KEEP}개만 남깁니다(생성 이미지도 함께 삭제).
					{#if prune}
						현재 {prune.total}개{prune.prunable > 0 ? ` · 지울 수 있는 것 ${prune.prunable}개(이미지 ${prune.images}장)` : ' · 지울 것 없음'}
					{/if}
				</p>
				<div class="actions">
					<button class="ghost" onclick={onPrune} disabled={!!busy || !prune || prune.prunable === 0}>
						{busy === 'prune' ? '지우는 중…' : `오래된 채팅 정리`}
					</button>
				</div>
			</section>

			<section>
				<h3>백업</h3>
				<p class="hint">DB 와 이미지 전체를 zip 하나로 내려받거나, zip 으로 통째 복원해요.</p>
				<div class="actions">
					<button class="ghost" onclick={onExport} disabled={!!busy}>
						{busy === 'export' ? '만드는 중…' : 'zip 내보내기'}
					</button>
					<button class="ghost" onclick={onPickImport} disabled={!!busy}>
						{busy === 'import' ? '가져오는 중…' : 'zip 가져오기'}
					</button>
					<input class="hidden-input" type="file" accept=".zip,application/zip" bind:this={fileInput} onchange={onImportFile} />
				</div>
			</section>

			{#if progress}
				<p class="hint">
					{progress.phase}
					{#if progress.total > 0}
						{progress.phase === '읽는 중' ? `${fmtBytes(progress.done)} / ${fmtBytes(progress.total)}` : `${progress.done} / ${progress.total}`}
					{:else if progress.done > 0}
						{progress.done}
					{/if}
				</p>
			{/if}
			{#if msg}<p class="ok">{msg}</p>{/if}
			{#if err}<p class="err">{err}</p>{/if}
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
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 440px;
		margin: auto;
		padding: 24px 22px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.close {
		position: absolute;
		top: 12px;
		right: 12px;
		background: none;
		border: none;
		color: var(--text-dim);
		font-size: 1rem;
		cursor: pointer;
	}
	h2 {
		margin: 0;
		font-size: 1.15rem;
	}
	h3 {
		margin: 0 0 6px;
		font-size: 0.92rem;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	section:first-of-type {
		border-top: none;
		padding-top: 0;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 0.86rem;
	}
	.k {
		color: var(--text-dim);
	}
	.v {
		text-align: right;
	}
	.hint {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-dim);
		line-height: 1.45;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 4px;
	}
	.primary,
	.ghost {
		padding: 9px 14px;
		border-radius: 999px;
		font-size: 0.84rem;
		font-weight: 600;
		cursor: pointer;
	}
	.primary {
		border: none;
		background: var(--accent);
		color: #fff;
	}
	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.ghost {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
	}
	.ghost:hover:not(:disabled) {
		background: var(--bg-card-hover);
	}
	button:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.hidden-input {
		display: none;
	}
	.pct {
		color: var(--text-dim);
		font-size: 0.78rem;
	}
	.bar {
		display: flex;
		height: 8px;
		border-radius: 999px;
		background: var(--bg-card);
		overflow: hidden;
		margin-top: 2px;
	}
	.bar-haven {
		background: var(--accent);
	}
	.bar-other {
		background: var(--text-faint);
	}
	.legend {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.72rem;
	}
	.sw {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 3px;
	}
	.sw.haven {
		background: var(--accent);
	}
	.sw.other {
		background: var(--text-faint);
		margin-left: 8px;
	}
	.ok {
		margin: 0;
		font-size: 0.82rem;
		color: var(--accent);
	}
	.err {
		margin: 0;
		font-size: 0.82rem;
		color: #ff7b7b;
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
			gap: 14px;
		}
		h2 {
			font-size: 1.08rem;
		}
		.row {
			font-size: 0.82rem;
		}
		.v {
			min-width: 0;
			overflow-wrap: anywhere;
		}
		.primary,
		.ghost {
			padding: 9px 12px;
			font-size: 0.8rem;
		}
	}
</style>
