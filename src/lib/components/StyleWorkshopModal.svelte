<script lang="ts">
	import { scrollLock } from '$lib/scrollLock';
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';
	import { base64ToBlob, blobToWebp } from '$lib/imagePreview';
	import { NAI_MODELS, DEFAULT_NAI_MODEL, getNaiModel } from '$lib/naiModels';
	import type { ArtStyle } from '$lib/types';

	let {
		open = $bindable(),
		edit = null,
		onPublished
	}: {
		open: boolean;
		/** 수정 대상 그림체(본인 소유). 있으면 필드를 채워 열고 저장 시 PATCH. null 이면 새로 만들기. */
		edit?: ArtStyle | null;
		onPublished?: () => void;
	} = $props();
	const isEdit = $derived(!!edit);

	// 수정 모드로 열릴 때 기존 값 채움(썸네일은 기존 URL 미리보기, 새로 안 만들면 그대로 유지).
	$effect(() => {
		if (!open || !edit) return;
		style = edit.prompt;
		negative = edit.negative ?? '';
		quality = edit.quality ?? '';
		extrasOpen = !!(edit.negative || edit.quality);
		naiModel = getNaiModel(edit.model).id;
		title = edit.title;
		memo = edit.memo ?? '';
		thumbUrl = edit.thumbnailUrl;
		thumbBlob = null;
	});

	const RESOLUTIONS = ['832x1216', '1024x1024'] as const;
	type Res = (typeof RESOLUTIONS)[number];

	// 그림체(저장될 스타일 프롬프트) · 상황(테스트용)
	let style = $state('');
	let situation = $state('');
	// 선택 네거티브/퀄리티 프롬프트(비면 모델별 고정값 사용). 그림체와 함께 저장된다.
	let negative = $state('');
	let quality = $state('');
	let extrasOpen = $state(false);
	let resolution = $state<Res>('832x1216');
	// 이 그림체를 깎는 NovelAI 모델. 저장 시 그림체에 박혀 채팅·썸네일도 같은 모델로 생성된다.
	let naiModel = $state(DEFAULT_NAI_MODEL);
	const naiModelInfo = $derived(getNaiModel(naiModel));

	// 기존 그림체 불러오기(드롭다운): 열릴 때 내 목록을 받아 두고, 고르면 프롬프트·모델·네거티브·퀄리티를 채운다.
	let mine = $state<ArtStyle[]>([]);
	let loadFrom = $state('');
	$effect(() => {
		if (!open) return;
		fetch('/api/styles/mine')
			.then((r) => (r.ok ? (r.json() as Promise<{ styles: ArtStyle[] }>) : { styles: [] }))
			.then((d) => (mine = d.styles))
			.catch(() => (mine = []));
	});
	const loadable = $derived(mine.filter((s) => s.id !== edit?.id));
	function applyStyle(id: string) {
		loadFrom = id;
		const s = mine.find((x) => x.id === id);
		if (!s) return;
		style = s.prompt;
		negative = s.negative ?? '';
		quality = s.quality ?? '';
		extrasOpen = !!(s.negative || s.quality);
		naiModel = getNaiModel(s.model).id;
	}

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
		if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
	}
	function close() {
		open = false;
		reset();
		style = '';
		situation = '';
		negative = '';
		quality = '';
		extrasOpen = false;
		naiModel = DEFAULT_NAI_MODEL;
		loadFrom = '';
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
			await streamGenerate(
				{ style, situation, resolution, model: naiModel, negative, quality },
				(blob) => {
					revoke(previewUrl);
					previewUrl = URL.createObjectURL(blob);
				}
			);
		} finally {
			generating = false;
		}
	}

	async function generateThumb() {
		if (thumbGenerating || !style.trim()) return;
		thumbGenerating = true;
		try {
			const finalBlob = await streamGenerate(
				{ style, thumbnail: true, model: naiModel, negative, quality },
				(blob) => {
					revoke(thumbUrl);
					thumbUrl = URL.createObjectURL(blob);
				}
			);
			if (finalBlob) {
				// 업로드용 webp 변환(채팅·캐릭터 썸네일과 동일). 실패 시 원본(보통 PNG) 그대로.
				let upload = finalBlob;
				try {
					upload = await blobToWebp(finalBlob);
				} catch (e) {
					console.warn('[workshop] webp 변환 실패 — 원본 업로드:', String(e));
				}
				thumbBlob = upload;
				thumbExt = upload.type.includes('png')
					? 'png'
					: upload.type.includes('jpeg')
						? 'jpg'
						: 'webp';
			}
		} finally {
			thumbGenerating = false;
		}
	}

	// 새로 만들기는 썸네일 필수, 수정은 기존 썸네일 유지 가능.
	const canPublish = $derived(!!style.trim() && !!title.trim() && (isEdit || !!thumbBlob));

	async function publish(shared: boolean) {
		if (publishing || !canPublish) return;
		if (!isEdit && !thumbBlob) return;
		publishing = shared ? 'share' : 'save';
		error = null;
		try {
			const fd = new FormData();
			fd.append('title', title.trim());
			fd.append('memo', memo.trim());
			fd.append('prompt', style.trim());
			fd.append('model', naiModel);
			fd.append('negative', negative.trim());
			fd.append('quality', quality.trim());
			if (!isEdit) fd.append('shared', shared ? '1' : '0');
			if (thumbBlob) fd.append('thumbnail', thumbBlob, `thumb.${thumbExt}`);
			const res = isEdit
				? await fetch(`/api/styles/${edit!.id}`, { method: 'PATCH', body: fd })
				: await fetch('/api/styles', { method: 'POST', body: fd });
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
	<div class="backdrop" use:scrollLock onclick={close} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="그림체 깎기"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="head">
				<h2>{isEdit ? '그림체 수정' : '그림체 깎기'}</h2>
				<button class="close" onclick={close} aria-label="닫기">✕</button>
			</div>

			{#if noKey}
				<div class="notice">
					NovelAI 키가 필요해요. <button class="link" onclick={openKeys}>API 키 등록</button>
				</div>
			{/if}

			<!-- 1) 그림체 깎기(자유 장면 미리보기) -->
			<div class="body">
				<div class="preview">
					{#if previewUrl}
						<img src={previewUrl} alt="미리보기" />
					{:else}
						<div class="ph">그림체·상황을 적고 <b>장면 생성</b>을 눌러보세요</div>
					{/if}
					{#if generating}<div class="overlay">생성 중…</div>{/if}
				</div>

				<div class="controls">
					{#if loadable.length}
						<label class="fl" for="ws-load">기존 그림체 불러오기</label>
						<select id="ws-load" value={loadFrom} onchange={(e) => applyStyle(e.currentTarget.value)}>
							<option value="">— 직접 입력 —</option>
							{#each loadable as s (s.id)}
								<option value={s.id}>{s.title} · {getNaiModel(s.model).label}</option>
							{/each}
						</select>
					{/if}
					<span class="fl">모델</span>
					<div class="res-row model-row" role="radiogroup" aria-label="NovelAI 모델">
						{#each NAI_MODELS as m (m.id)}
							<button
								class="res"
								class:active={naiModel === m.id}
								role="radio"
								aria-checked={naiModel === m.id}
								onclick={() => (naiModel = m.id)}
							>
								{m.label}
							</button>
						{/each}
					</div>
					<label class="fl" for="ws-style">그림체 프롬프트</label>
					<textarea id="ws-style" rows="4" bind:value={style} placeholder="예: artist:xxx, watercolor, soft lighting …"></textarea>
					<label class="fl" for="ws-situ">상황 (테스트용 · 저장 안 됨)</label>
					<textarea id="ws-situ" rows="2" bind:value={situation} placeholder="예: 1girl, smile, outdoors"></textarea>
					<button class="extras-toggle" onclick={() => (extrasOpen = !extrasOpen)} aria-expanded={extrasOpen}>
						<span class="chev" class:open={extrasOpen}>›</span>
						<span>퀄리티 · 네거티브 <span class="opt">(선택)</span></span>
						{#if !extrasOpen && (negative.trim() || quality.trim())}<span class="badge">지정됨</span>{/if}
					</button>
					{#if extrasOpen}
						<label class="fl" for="ws-quality">퀄리티 프롬프트 <span class="opt">(비면 모델 기본 꼬리)</span></label>
						<textarea
							id="ws-quality"
							rows="2"
							maxlength="1500"
							bind:value={quality}
							placeholder="예: 1.3::very aesthetic, masterpiece::, no text, -1::multiple views::"
						></textarea>
						<label class="fl" for="ws-negative">네거티브 프롬프트 <span class="opt">(비면 모델 기본 네거티브)</span></label>
						<textarea
							id="ws-negative"
							rows="2"
							maxlength="1500"
							bind:value={negative}
							placeholder="예: lowres, bad anatomy, bad hands, text, watermark"
						></textarea>
						<p class="hint">지정하면 모델 기본값을 통째로 대체해요. 네거티브 앞의 미성년 차단 태그는 항상 유지됩니다.</p>
					{/if}
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
					<p class="hint">
						그림체는 모든 이미지에 적용될 스타일 태그예요. 퀄리티·네거티브는 비워두면 모델에 맞춰 자동 적용됩니다.
						저장하면 <b>{naiModelInfo.label}</b> 그림체로 표시되고, 채팅·썸네일도 이 모델로 생성돼요.
					</p>
				</div>
			</div>

			<!-- 2) 저장 / 공유 -->
			<div class="share-sec">
				<div class="share-head">{isEdit ? '수정 저장' : '저장 / 공유'}</div>
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
						<p class="hint">{isEdit ? '새로 만들지 않으면 기존 썸네일을 유지해요.' : '마음에 들 때까지 다시 눌러 고르세요.'}</p>
						<button class="ghost sm" onclick={generateThumb} disabled={thumbGenerating || !style.trim()}>
							{thumbUrl ? '썸네일 다시' : '썸네일 생성'}
						</button>
					</div>
				</div>

				{#if error}<p class="err">{error}</p>{/if}

				<div class="actions">
					{#if isEdit}
						<button class="primary" onclick={() => publish(false)} disabled={!!publishing || !canPublish}>
							{publishing ? '저장 중…' : '수정 저장'}
						</button>
					{:else}
						<button class="primary" onclick={() => publish(true)} disabled={!!publishing || !canPublish}>
							{publishing ? '저장 중…' : '저장'}
						</button>
					{/if}
				</div>
				{#if !canPublish}
					<p class="hint center">{isEdit ? '제목과 그림체 프롬프트는 비울 수 없어요.' : '제목과 썸네일을 준비하면 저장할 수 있어요.'}</p>
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
	.extras-toggle {
		margin-top: 10px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0;
		background: none;
		border: 0;
		color: var(--text-dim, #aaa);
		font-size: 0.82rem;
		cursor: pointer;
	}
	.extras-toggle:hover {
		color: var(--text, #eee);
	}
	.extras-toggle .chev {
		display: inline-block;
		transition: transform 0.15s;
	}
	.extras-toggle .chev.open {
		transform: rotate(90deg);
	}
	.extras-toggle .badge {
		font-size: 0.7rem;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--accent, #6c5ce7);
		color: #fff;
	}
	.opt {
		color: var(--text-faint);
		font-weight: 400;
	}
	.controls textarea,
	.controls select,
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
	.controls select:focus,
	.share-sec textarea:focus,
	.share-sec input:focus {
		border-color: var(--accent);
	}
	.res-row {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.model-row {
		margin-top: 0;
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

	/* 모바일: 여백을 줄여 폭·높이를 더 쓴다 */
	@media (max-width: 640px) {
		.backdrop {
			padding: 10px;
		}
		.modal {
			padding: 16px 14px;
			max-height: calc(100dvh - 20px);
			border-radius: 14px;
		}
	}
</style>
