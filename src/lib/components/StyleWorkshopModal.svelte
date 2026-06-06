<script lang="ts">
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';
	import { base64ToBlob } from '$lib/imagePreview';

	let {
		open = $bindable(),
		onPublished
	}: { open: boolean; onPublished?: () => void } = $props();

	const RESOLUTIONS = ['832x1216', '1024x1024'] as const;
	type Res = (typeof RESOLUTIONS)[number];

	// 화풍(저장될 그림체) · 상황(테스트용)
	let style = $state('');
	let situation = $state('');
	let resolution = $state<Res>('832x1216');

	// 장면 미리보기(자유 생성)
	let previewUrl = $state<string | null>(null);
	let generating = $state(false);
	let error = $state<string | null>(null);
	let noKey = $state(false);

	// 저장/공유 입력
	let title = $state('');
	let memo = $state('');
	let thumbUrl = $state<string | null>(null);
	let thumbBlob = $state<Blob | null>(null);
	let thumbExt = $state('webp');
	let thumbGenerating = $state(false);
	let publishing = $state<false | 'save' | 'share'>(false);

	function reset() {
		revoke(previewUrl);
		revoke(thumbUrl);
		previewUrl = null;
		thumbUrl = null;
		thumbBlob = null;
		error = null;
		noKey = false;
		title = '';
		memo = '';
		publishing = false;
	}
	function revoke(u: string | null) {
		if (u) URL.revokeObjectURL(u);
	}
	function close() {
		open = false;
		reset();
		style = '';
		situation = '';
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) close();
	}

	/**
	 * 스트리밍 생성: NDJSON 프레임을 받아 onFrame(blob)으로 프리뷰를 갱신하고 최종 Blob 을 반환.
	 * 스트리밍 미지원 시 서버가 폴백해 't:final' 1장만 보냄.
	 */
	async function streamGenerate(
		body: Record<string, unknown>,
		onFrame: (blob: Blob) => void
	): Promise<Blob | null> {
		error = null;
		noKey = false;
		const res = await fetch('/api/styles/generate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const ctype = res.headers.get('content-type') ?? '';
		if (!res.ok || !res.body || !ctype.includes('ndjson')) {
			const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
			error = d.message ?? '생성에 실패했습니다.';
			if (d.error === 'no_key') noKey = true;
			return null;
		}
		let finalBlob: Blob | null = null;
		const handle = (o: Record<string, unknown>) => {
			if ((o.t === 'frame' || o.t === 'final') && typeof o.img === 'string') {
				const blob = base64ToBlob(o.img);
				if (o.t === 'final') finalBlob = blob;
				onFrame(blob);
			} else if (o.t === 'error') {
				error = (o.message as string) ?? '생성에 실패했습니다.';
			}
		};
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = '';
		const drain = (flush = false) => {
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const l = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (l) {
					try {
						handle(JSON.parse(l));
					} catch {
						/* 무시 */
					}
				}
			}
			if (flush && buf.trim()) {
				try {
					handle(JSON.parse(buf.trim()));
				} catch {
					/* 무시 */
				}
			}
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			drain();
		}
		drain(true);
		return finalBlob;
	}

	async function generate() {
		if (generating || !style.trim()) return;
		generating = true;
		try {
			await streamGenerate({ style, situation, resolution }, (blob) => {
				revoke(previewUrl);
				previewUrl = URL.createObjectURL(blob);
			});
		} finally {
			generating = false;
		}
	}

	async function generateThumb() {
		if (thumbGenerating || !style.trim()) return;
		thumbGenerating = true;
		try {
			const finalBlob = await streamGenerate({ style, thumbnail: true }, (blob) => {
				revoke(thumbUrl);
				thumbUrl = URL.createObjectURL(blob);
			});
			if (finalBlob) {
				thumbBlob = finalBlob;
				thumbExt = finalBlob.type.includes('png')
					? 'png'
					: finalBlob.type.includes('jpeg')
						? 'jpg'
						: 'webp';
			}
		} finally {
			thumbGenerating = false;
		}
	}

	const canPublish = $derived(!!style.trim() && !!title.trim() && !!thumbBlob);

	async function publish(shared: boolean) {
		if (publishing || !canPublish || !thumbBlob) return;
		publishing = shared ? 'share' : 'save';
		error = null;
		try {
			const fd = new FormData();
			fd.append('title', title.trim());
			fd.append('memo', memo.trim());
			fd.append('prompt', style.trim());
			fd.append('shared', shared ? '1' : '0');
			fd.append('thumbnail', thumbBlob, `thumb.${thumbExt}`);
			const res = await fetch('/api/styles', { method: 'POST', body: fd });
			if (res.ok) {
				onPublished?.();
				close();
			} else {
				const d = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
				error = d.message ?? d.error ?? '실패했습니다.';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : '실패했습니다.';
		} finally {
			publishing = false;
		}
	}

	function openKeys() {
		apiKeyModal.open = true;
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
			aria-label="그림체 깎기"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="head">
				<h2>그림체 깎기</h2>
				<button class="close" onclick={close} aria-label="닫기">✕</button>
			</div>

			{#if noKey}
				<div class="notice">
					NovelAI 키가 필요해요. <button class="link" onclick={openKeys}>API 키 등록</button>
				</div>
			{/if}

			<!-- 1) 화풍 깎기(자유 장면 미리보기) -->
			<div class="body">
				<div class="preview">
					{#if previewUrl}
						<img src={previewUrl} alt="미리보기" />
					{:else}
						<div class="ph">화풍·상황을 적고 <b>장면 생성</b>을 눌러보세요</div>
					{/if}
					{#if generating}<div class="overlay">생성 중…</div>{/if}
				</div>

				<div class="controls">
					<label class="fl" for="ws-style">화풍 프롬프트</label>
					<textarea id="ws-style" rows="4" bind:value={style} placeholder="예: artist:xxx, watercolor, soft lighting …"></textarea>
					<label class="fl" for="ws-situ">상황 (테스트용 · 저장 안 됨)</label>
					<textarea id="ws-situ" rows="2" bind:value={situation} placeholder="예: 1girl, smile, outdoors"></textarea>
					<div class="res-row">
						{#each RESOLUTIONS as r (r)}
							<button class="res" class:active={resolution === r} onclick={() => (resolution = r)}>{r}</button>
						{/each}
					</div>
					<div class="actions">
						<button class="primary" onclick={generate} disabled={generating || !style.trim()}>
							{previewUrl ? '다시 생성' : '장면 생성'}
						</button>
					</div>
					<p class="hint">화풍은 모든 이미지에 적용될 스타일 태그예요. 퀄리티·네거티브는 자동 적용됩니다.</p>
				</div>
			</div>

			<!-- 2) 저장 / 공유 -->
			<div class="share-sec">
				<div class="share-head">저장 / 공유</div>
				<label class="fl" for="ws-title">제목</label>
				<input id="ws-title" type="text" maxlength="60" bind:value={title} placeholder="그림체 이름" />
				<label class="fl" for="ws-memo">메모 <span class="opt">(선택)</span></label>
				<textarea id="ws-memo" rows="2" maxlength="500" bind:value={memo} placeholder="설명"></textarea>

				<div class="thumb-block">
					<div class="thumb-prev">
						{#if thumbUrl}
							<img src={thumbUrl} alt="썸네일" />
						{:else}
							<span class="thumb-ph">표준 장면<br />썸네일</span>
						{/if}
						{#if thumbGenerating}<div class="overlay sm">생성 중…</div>{/if}
					</div>
					<div class="thumb-side">
						<span class="fl">썸네일</span>
						<p class="hint">마음에 들 때까지 다시 눌러 고르세요.</p>
						<button class="ghost sm" onclick={generateThumb} disabled={thumbGenerating || !style.trim()}>
							{thumbUrl ? '썸네일 다시' : '썸네일 생성'}
						</button>
					</div>
				</div>

				{#if error}<p class="err">{error}</p>{/if}

				<div class="actions">
					<button class="ghost" onclick={() => publish(false)} disabled={!!publishing || !canPublish}>
						{publishing === 'save' ? '저장 중…' : '저장 (나만)'}
					</button>
					<button class="primary" onclick={() => publish(true)} disabled={!!publishing || !canPublish}>
						{publishing === 'share' ? '공유 중…' : '공유 (Hub)'}
					</button>
				</div>
				{#if !canPublish}
					<p class="hint center">제목과 썸네일을 준비하면 저장·공유할 수 있어요.</p>
				{/if}
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
		max-width: 720px;
		max-height: calc(100dvh - 40px);
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 22px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 14px;
	}
	.head h2 {
		margin: 0;
		font-size: 1.15rem;
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
	.notice {
		margin-bottom: 12px;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--nsfw, #f59e0b) 14%, var(--bg));
		font-size: 0.82rem;
		color: var(--text-dim);
	}
	.link {
		background: none;
		border: none;
		color: var(--accent);
		font-weight: 700;
		text-decoration: underline;
		cursor: pointer;
	}
	.body {
		display: flex;
		gap: 18px;
	}
	@media (max-width: 620px) {
		.body {
			flex-direction: column;
		}
	}
	.preview {
		position: relative;
		flex: 0 0 300px;
		aspect-ratio: 832 / 1216;
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		display: grid;
		place-items: center;
	}
	@media (max-width: 620px) {
		.preview {
			flex: none;
			width: 100%;
			max-width: 300px;
			margin: 0 auto;
		}
	}
	.preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.ph {
		padding: 0 18px;
		text-align: center;
		font-size: 0.82rem;
		color: var(--text-faint);
	}
	.overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		font-size: 0.85rem;
	}
	.controls {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.fl {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text);
		margin: 10px 0 6px;
	}
	.fl:first-child {
		margin-top: 0;
	}
	.opt {
		color: var(--text-faint);
		font-weight: 400;
	}
	.controls textarea,
	.share-sec textarea,
	.share-sec input {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 9px 11px;
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		line-height: 1.5;
		resize: vertical;
		outline: none;
	}
	.controls textarea:focus,
	.share-sec textarea:focus,
	.share-sec input:focus {
		border-color: var(--accent);
	}
	.res-row {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.res {
		flex: 1;
		padding: 8px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 600;
	}
	.res.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	.actions {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}
	.primary,
	.ghost {
		flex: 1;
		padding: 10px;
		border-radius: var(--radius-sm);
		font-size: 0.86rem;
		font-weight: 700;
		border: 1px solid var(--border);
	}
	.ghost {
		background: transparent;
		color: var(--text-dim);
	}
	.ghost.sm {
		flex: none;
		padding: 6px 12px;
		font-size: 0.78rem;
	}
	.ghost:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--text-faint);
	}
	.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.primary:disabled,
	.ghost:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.hint {
		margin: 8px 0 0;
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--text-faint);
	}
	.hint.center {
		text-align: center;
	}
	.err {
		margin: 10px 0 0;
		font-size: 0.8rem;
		color: var(--nsfw, #f59e0b);
	}

	/* 저장/공유 섹션 */
	.share-sec {
		margin-top: 18px;
		padding-top: 18px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}
	.share-head {
		font-size: 0.9rem;
		font-weight: 800;
		margin-bottom: 10px;
	}
	.overlay.sm {
		font-size: 0.72rem;
	}
	.thumb-block {
		display: flex;
		gap: 12px;
		margin-top: 12px;
		align-items: stretch;
	}
	.thumb-prev {
		position: relative;
		flex: 0 0 96px;
		aspect-ratio: 832 / 1216;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		display: grid;
		place-items: center;
	}
	.thumb-prev img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.thumb-ph {
		text-align: center;
		font-size: 0.7rem;
		color: var(--text-faint);
		line-height: 1.3;
	}
	.thumb-side {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}
	.thumb-side .fl {
		margin-top: 0;
	}
	.thumb-side .ghost.sm {
		margin-top: auto;
	}
</style>
