<script lang="ts">
	import { onMount } from 'svelte';
	import { apiKeyModal } from '$lib/state/apiKeyModal.svelte';
	import { base64ToBlob, blobToBase64, blobToWebp } from '$lib/imagePreview';
	import type { ArtStyle } from '$lib/types';

	let {
		description,
		nsfw = false,
		onuse
	}: {
		/** 폼의 프롬프트(설정) — 외형 추출 근거. */
		description: string;
		/** NSFW 캐릭터 여부(rating:nsfw). */
		nsfw?: boolean;
		/**
		 * "이 썸네일 사용" → webp File 을 폼 썸네일로 등록하는 콜백.
		 * styleId 는 그 썸네일을 만들 때 쓴 그림체 id(없으면 '') — 폼이 추천 그림체로 반영한다.
		 */
		onuse: (file: File, styleId: string) => void;
	} = $props();

	const SITU_MAX = 1000;

	// 그림체 선택(내가 만들거나 즐겨찾기한 것 — listMine 과 동일 후보).
	let styles = $state<ArtStyle[]>([]);
	let styleId = $state('');
	const currentStyle = $derived(styles.find((s) => s.id === styleId) ?? null);

	let situation = $state('');
	let previewUrl = $state<string | null>(null);
	let finalBlob = $state<Blob | null>(null);
	/** finalBlob 을 만들 때 실제로 쓴 그림체 id(생성 시점 캡처 — "사용" 시 추천 그림체로 전달). */
	let usedStyleId = $state('');
	let generating = $state(false);
	let error = $state<string | null>(null);
	let noKey = $state(false);
	let using = $state(false);
	let zoomed = $state(false); // 미리보기 크게 보기(라이트박스)

	onMount(async () => {
		try {
			const res = await fetch('/api/styles/mine');
			if (res.ok) styles = ((await res.json()) as { styles: ArtStyle[] }).styles ?? [];
		} catch {
			/* 무시 */
		}
	});

	function revoke(u: string | null) {
		if (u) URL.revokeObjectURL(u);
	}

	/**
	 * NDJSON 스트림 소비. t:situation 으로 편집 input 채우고, t:frame/final 로 프리뷰 갱신.
	 * 최종 Blob 을 반환(없으면 null).
	 */
	async function streamGenerate(body: Record<string, unknown>): Promise<Blob | null> {
		error = null;
		noKey = false;
		const res = await fetch('/api/characters/thumbnail', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (res.status === 429) {
			const d = (await res.json().catch(() => ({}))) as { limit?: number };
			error = `오늘 사용량 한도에 도달했어요${d.limit ? ` ($${d.limit})` : ''}. 내일 다시 시도해 주세요.`;
			return null;
		}
		const ctype = res.headers.get('content-type') ?? '';
		if (!res.ok || !res.body || !ctype.includes('ndjson')) {
			const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
			error = d.message ?? '생성에 실패했어요.';
			if (d.error === 'no_key') noKey = true;
			return null;
		}
		let final: Blob | null = null;
		const handle = (o: Record<string, unknown>) => {
			if (o.t === 'situation' && typeof o.situation === 'string') {
				situation = o.situation.slice(0, SITU_MAX);
			} else if ((o.t === 'frame' || o.t === 'final') && typeof o.img === 'string') {
				const blob = base64ToBlob(o.img);
				if (o.t === 'final') final = blob;
				revoke(previewUrl);
				previewUrl = URL.createObjectURL(blob);
			} else if (o.t === 'error') {
				error = (o.message as string) ?? '생성에 실패했어요.';
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
		return final;
	}

	/** 썸네일 생성/재생성. regenSituation=true 면 설정 기반으로 상황을 새로 만든다. */
	async function generate(regenSituation = false) {
		if (generating) return;
		// 상황을 직접 안 적었고 설정도 없으면 생성 불가(서버도 거부).
		if (!situation.trim() && !description.trim()) {
			error = '프롬프트(설정)를 먼저 작성하거나 상황을 직접 입력해 주세요.';
			return;
		}
		generating = true;
		finalBlob = null;
		// 생성 시작 시점의 그림체를 캡처(중간에 드롭다운을 바꿔도 이 컷의 그림체는 고정).
		const genStyleId = styleId;
		try {
			const blob = await streamGenerate({
				description,
				style: currentStyle?.prompt ?? '',
				situation: regenSituation ? '' : situation.trim(),
				regenSituation,
				nsfw
			});
			if (blob) {
				finalBlob = blob;
				usedStyleId = genStyleId;
			}
		} finally {
			generating = false;
		}
	}

	/** "이 썸네일 사용": NAI 2x 업스케일 → webp 변환 → 폼 썸네일 등록. */
	async function useThumb() {
		if (!finalBlob || using) return;
		using = true;
		error = null;
		noKey = false;
		try {
			// 1) 원본 치수(업스케일 요청에 필요).
			const bmp = await createImageBitmap(finalBlob);
			const w = bmp.width;
			const h = bmp.height;
			bmp.close?.();

			// 2) NAI 업스케일(서버 경유 — 키는 서버에만). 실패 시 사유 노출, 등록 안 함.
			const b64 = await blobToBase64(finalBlob);
			const res = await fetch('/api/characters/thumbnail/upscale', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ image: b64, width: w, height: h })
			});
			if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
				const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				error = d.message ?? '업스케일에 실패했어요.';
				if (d.error === 'no_key') noKey = true;
				return;
			}
			const upscaled = await res.blob();

			// 3) webp 변환 후 등록.
			const webp = await blobToWebp(upscaled);
			onuse(new File([webp], 'thumbnail.webp', { type: 'image/webp' }), usedStyleId);
		} catch (e) {
			error = e instanceof Error ? e.message : '썸네일 변환에 실패했어요.';
		} finally {
			using = false;
		}
	}

	function openKeys() {
		apiKeyModal.open = true;
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && zoomed && (zoomed = false)} />

<aside class="thumb">
	<div class="t-head">
		<span class="t-logo">🖼️</span>
		<h2>AI 썸네일 생성</h2>
		<p>설정(프롬프트)을 바탕으로 외형을 뽑아 썸네일을 만들어요. 그림체를 고르고 여러 번 돌려보세요.</p>
	</div>

	{#if noKey}
		<div class="t-notice">
			NovelAI 키가 필요해요. <button class="link" onclick={openKeys}>API 키 등록</button>
		</div>
	{/if}

	<div class="t-preview">
		{#if previewUrl}
			<button type="button" class="t-zoom-btn" onclick={() => (zoomed = true)} aria-label="크게 보기">
				<img src={previewUrl} alt="썸네일 미리보기" />
				<span class="t-zoom-hint">⤢ 크게</span>
			</button>
		{:else}
			<div class="t-ph">그림체를 고르고<br /><b>썸네일 생성</b>을 눌러보세요</div>
		{/if}
		{#if generating}<div class="t-overlay">생성 중…</div>{/if}
	</div>

	<label class="t-label" for="thumb-style">그림체</label>
	{#if styles.length > 0}
		<select id="thumb-style" class="t-select" bind:value={styleId}>
			<option value="">그림체 없음</option>
			{#each styles as s (s.id)}
				<option value={s.id}>{s.title}{s.creatorName ? ` · ${s.creatorName}` : ''}</option>
			{/each}
		</select>
	{:else}
		<p class="t-hint">
			즐겨찾기한 그림체가 없어요. <a href="/styles" target="_blank" rel="noreferrer">그림체 Hub</a>에서
			만들거나 즐겨찾기하면 여기서 고를 수 있어요. (그림체 없이도 생성돼요.)
		</p>
	{/if}

	<div class="t-label-row">
		<label class="t-label" for="thumb-situ">상황 프롬프트 (danbooru)</label>
		<button
			class="t-mini"
			onclick={() => generate(true)}
			disabled={generating || !description.trim()}
			title="설정을 바탕으로 상황을 새로 생성">↻ 설정 기반</button
		>
	</div>
	<textarea
		id="thumb-situ"
		class="t-situ"
		rows="3"
		maxlength={SITU_MAX}
		bind:value={situation}
		placeholder="생성을 누르면 설정에서 자동으로 채워져요. 직접 수정도 가능해요. 예: 1girl, long black hair, red eyes, school uniform, looking at viewer, upper body"
		disabled={generating}
	></textarea>

	{#if error}<p class="t-error">{error}</p>{/if}

	<div class="t-actions">
		<button class="t-gen" onclick={() => generate(false)} disabled={generating}>
			{generating ? '생성 중…' : previewUrl ? '다시 생성' : '썸네일 생성'}
		</button>
		<button class="t-use" onclick={useThumb} disabled={!finalBlob || generating || using}>
			{using ? '업스케일 중…' : '이 썸네일 사용'}
		</button>
	</div>
	<p class="t-note">
		생성·업스케일 비용은 본인 NovelAI Anlas로 차감돼요. "사용"을 누르면 <strong>2배 업스케일</strong> 후
		webp로 변환해 위 썸네일에 등록되고, 사용한 그림체가 <strong>추천 그림체</strong>로 자동 설정돼요.
	</p>
</aside>

{#if zoomed && previewUrl}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="t-lightbox" role="presentation" onclick={() => (zoomed = false)}>
		<img src={previewUrl} alt="썸네일 크게 보기" />
		<button class="t-lightbox-close" onclick={() => (zoomed = false)} aria-label="닫기">✕</button>
	</div>
{/if}

<style>
	.thumb {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 18px;
		display: flex;
		flex-direction: column;
	}
	.t-head {
		margin-bottom: 14px;
	}
	.t-logo {
		font-size: 1.2rem;
	}
	.t-head h2 {
		margin: 4px 0 6px;
		font-size: 1.05rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.t-head p {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.55;
		color: var(--text-dim);
	}
	.t-notice {
		margin-bottom: 12px;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--nsfw, #f59e0b) 14%, var(--bg));
		font-size: 0.8rem;
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
	.t-preview {
		position: relative;
		width: 100%;
		max-width: 220px;
		margin: 0 auto 14px;
		aspect-ratio: 832 / 1216;
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		display: grid;
		place-items: center;
	}
	.t-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.t-zoom-btn {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
		position: relative;
	}
	.t-zoom-hint {
		position: absolute;
		bottom: 6px;
		right: 6px;
		padding: 2px 7px;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		font-size: 0.68rem;
		font-weight: 700;
		opacity: 0;
		transition: opacity 0.15s ease;
	}
	.t-zoom-btn:hover .t-zoom-hint {
		opacity: 1;
	}
	.t-lightbox {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.85);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 24px;
		cursor: zoom-out;
	}
	.t-lightbox img {
		max-width: 92vw;
		max-height: 92vh;
		object-fit: contain;
		border-radius: var(--radius);
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
	}
	.t-lightbox-close {
		position: fixed;
		top: 18px;
		right: 18px;
		width: 38px;
		height: 38px;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.6);
		color: #fff;
		font-size: 1rem;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.t-lightbox-close:hover {
		background: rgba(0, 0, 0, 0.85);
	}
	.t-ph {
		padding: 0 18px;
		text-align: center;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text-faint);
	}
	.t-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		font-size: 0.85rem;
	}
	.t-label {
		display: block;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-dim);
		margin: 4px 0 6px;
	}
	.t-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 12px;
	}
	.t-label-row .t-label {
		margin: 0;
	}
	.t-mini {
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text-dim);
		font-size: 0.72rem;
		font-weight: 700;
		padding: 4px 9px;
		border-radius: 999px;
		cursor: pointer;
	}
	.t-mini:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--text);
	}
	.t-mini:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.t-select,
	.t-situ {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 9px 11px;
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		line-height: 1.5;
		outline: none;
	}
	.t-situ {
		margin-top: 6px;
		resize: vertical;
	}
	.t-select:focus,
	.t-situ:focus {
		border-color: var(--accent);
	}
	.t-situ:disabled {
		opacity: 0.6;
	}
	.t-hint {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.5;
		color: var(--text-faint);
	}
	.t-hint a {
		color: var(--accent);
		font-weight: 600;
	}
	.t-error {
		margin: 10px 0 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--nsfw);
	}
	.t-actions {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}
	.t-gen,
	.t-use {
		flex: 1;
		padding: 11px;
		border-radius: var(--radius-sm);
		font-size: 0.86rem;
		font-weight: 700;
		border: 1px solid var(--border);
		transition: background 0.15s ease;
	}
	.t-gen {
		background: var(--bg-elev);
		color: var(--text);
	}
	.t-gen:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.t-use {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.t-use:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	.t-gen:disabled,
	.t-use:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.t-note {
		margin: 12px 0 0;
		font-size: 0.74rem;
		line-height: 1.5;
		color: var(--text-faint);
	}
</style>
