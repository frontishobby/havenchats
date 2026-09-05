<script module lang="ts">
	import type { Audience, Opening } from '$lib/types';

	/** 보조 생성 결과 — 폼에 채워 넣을 캐릭터 필드 묶음. */
	export interface AssistCharacter {
		name: string;
		tagline: string;
		intro: string;
		description: string;
		tags: string[];
		greetings: Opening[];
		audience: Audience;
		nsfw: boolean;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { ASSIST_MODELS, ASSIST_MODEL_IDS, DEFAULT_ASSIST_MODEL_ID, getModel } from '$lib/data/models';
	import type { AssistStreamEvent } from '$lib/api/characters';

	let {
		nsfw = false,
		current,
		onapply
	}: {
		/** 제작 폼의 현재 NSFW 토글(생성 힌트로 전달). */
		nsfw?: boolean;
		/** 제작 폼의 현재 내용(있으면 보존하며 수정 모드로 전송). */
		current?: AssistCharacter;
		/** 생성 성공 시 폼을 채우는 콜백. */
		onapply: (c: AssistCharacter) => void;
	} = $props();

	/** 폼에 의미 있는 내용이 이미 있는지(수정 모드 판단 — 버튼·안내 문구용). */
	const hasContent = $derived(
		!!(
			current &&
			(current.name?.trim() ||
				current.tagline?.trim() ||
				current.intro?.trim() ||
				current.description?.trim() ||
				(current.tags && current.tags.length > 0) ||
				current.greetings?.some((g) => g.content?.trim()))
		)
	);

	const ROUGH_MAX = 4000;
	const MODEL_KEY = 'haven:assist-model';

	let rough = $state('');
	let loading = $state(false);
	let error = $state('');
	let done = $state(false);
	/** 스트림 진행 상황(서버 progress 이벤트). */
	let progress = $state<{ chars: number; field: string } | null>(null);
	/** 진행 중인 요청 취소용. */
	let abort: AbortController | null = null;
	let cancelled = false;

	/**
	 * 서버는 10초마다 ping 을 보내므로, 그보다 훨씬 긴 시간 아무 바이트도 안 오면 연결이 죽은 것.
	 * (서버 자체 상한은 5분 — 그쪽은 error 이벤트로 끝난다.)
	 */
	const STALL_MS = 60_000;

	const FIELD_LABEL: Record<string, string> = {
		name: '이름',
		tagline: '한 줄 소개',
		intro: '소개글',
		description: '프롬프트',
		tags: '태그',
		greetings: '첫 상황',
		nsfw: '마무리',
		audience: '마무리'
	};
	const progressText = $derived.by(() => {
		if (!progress) return '';
		const label = FIELD_LABEL[progress.field];
		const chars = progress.chars.toLocaleString('ko-KR');
		return label ? `${label} 작성 중 · ${chars}자` : `${chars}자`;
	});

	// 모델 선택(localStorage 저장) — assist 는 구조화 출력이 안정적인 모델(ASSIST_MODELS)만.
	let model = $state(DEFAULT_ASSIST_MODEL_ID);
	let modelOpen = $state(false);
	let iconFailed = $state<Record<string, boolean>>({});
	const currentModel = $derived(getModel(model) ?? ASSIST_MODELS[0]);

	onMount(() => {
		const saved = localStorage.getItem(MODEL_KEY);
		if (saved && ASSIST_MODEL_IDS.has(saved)) model = saved;
	});

	function selectModel(id: string) {
		model = id;
		modelOpen = false;
		localStorage.setItem(MODEL_KEY, id);
	}

	const canGenerate = $derived(!loading && rough.trim().length > 0);

	async function generate() {
		if (!canGenerate) return;
		loading = true;
		error = '';
		done = false;
		progress = null;
		cancelled = false;
		const ac = new AbortController();
		abort = ac;
		// 무수신 감시: 바이트가 올 때마다 재무장.
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		const armStall = () => {
			clearTimeout(stallTimer);
			stallTimer = setTimeout(() => ac.abort(), STALL_MS);
		};
		try {
			armStall();
			const res = await fetch('/api/characters/assist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					rough: rough.trim(),
					nsfw,
					model,
					current: hasContent ? current : undefined
				}),
				signal: ac.signal
			});
			if (res.status === 429) {
				const data = (await res.json().catch(() => ({}))) as { limit?: number };
				error = `오늘 사용량 한도에 도달했어요${data.limit ? ` ($${data.limit})` : ''}. 내일 다시 시도해 주세요.`;
				return;
			}
			const ctype = res.headers.get('content-type') ?? '';
			if (!res.ok || !res.body || !ctype.includes('ndjson')) {
				// 스트림 진입 전 실패(401/400/500) — JSON 에러.
				const data = (await res.json().catch(() => ({}))) as { message?: string };
				throw new Error(data.message ?? '생성에 실패했어요.');
			}

			// NDJSON 스트림: progress/ping 은 진행 표시·생존 확인, done/error 로 끝난다.
			let character: AssistCharacter | null = null;
			let failed: string | null = null;
			const handle = (ev: AssistStreamEvent) => {
				if (ev.t === 'progress') progress = { chars: ev.chars, field: ev.field };
				else if (ev.t === 'done') character = ev.character;
				else if (ev.t === 'error') failed = ev.message || '생성에 실패했어요.';
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
							/* 깨진 줄 무시 */
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
				const { done: eof, value } = await reader.read();
				if (eof) break;
				armStall();
				buf += dec.decode(value, { stream: true });
				drain();
			}
			drain(true);

			if (failed) throw new Error(failed);
			if (!character) throw new Error('서버 응답이 중간에 끊겼어요. 다시 시도해 주세요.');
			onapply(character);
			done = true;
		} catch (e) {
			if (ac.signal.aborted) {
				error = cancelled ? '취소했어요.' : '서버 응답이 끊겨 중단했어요. 다시 시도해 주세요.';
			} else {
				error = e instanceof Error ? e.message : '생성에 실패했어요.';
			}
		} finally {
			clearTimeout(stallTimer);
			loading = false;
			progress = null;
			abort = null;
		}
	}

	function cancel() {
		cancelled = true;
		abort?.abort();
	}

</script>

<svelte:window onclick={() => (modelOpen = false)} />

<aside class="assist">
	<div class="a-head">
		<span class="a-logo">✦</span>
		<h2>{hasContent ? 'AI로 캐릭터 다듬기' : 'AI로 캐릭터 만들기'}</h2>
		<p>
			{#if hasContent}
				고칠 점·추가할 점을 적으면 <strong>기존 폼 내용을 유지한 채</strong> 그 부분만 반영해 수정해요.
			{:else}
				러프한 아이디어를 적으면 AI가 폼을 채워줘요. 채운 뒤 자유롭게 다듬어 등록하세요.
			{/if}
		</p>
	</div>

	<div class="model-select">
		<span class="field-label" id="assist-model-label">모델</span>
		<button
			class="model-trigger"
			class:open={modelOpen}
			onclick={(e) => {
				e.stopPropagation();
				modelOpen = !modelOpen;
			}}
			aria-haspopup="listbox"
			aria-expanded={modelOpen}
			aria-labelledby="assist-model-label"
			disabled={loading}
		>
			{#if iconFailed[currentModel.id]}
				<span class="model-icon fallback">{currentModel.label.charAt(0)}</span>
			{:else}
				<img
					class="model-icon"
					src={currentModel.icon}
					alt=""
					onerror={() => (iconFailed[currentModel.id] = true)}
				/>
			{/if}
			<span class="model-name">{currentModel.label}</span>
			<span class="chev">▾</span>
		</button>
		{#if modelOpen}
			<ul class="model-list" role="listbox" aria-labelledby="assist-model-label">
				{#each ASSIST_MODELS as m (m.id)}
					<li>
						<button
							class="model-option"
							class:selected={m.id === model}
							role="option"
							aria-selected={m.id === model}
							onclick={() => selectModel(m.id)}
						>
							{#if iconFailed[m.id]}
								<span class="model-icon fallback">{m.label.charAt(0)}</span>
							{:else}
								<img
									class="model-icon"
									src={m.icon}
									alt=""
									onerror={() => (iconFailed[m.id] = true)}
								/>
							{/if}
							<span class="model-name">{m.label}</span>
							{#if m.id === model}<span class="check">✓</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<textarea
		class="a-input"
		rows="10"
		placeholder={hasContent
			? '고치거나 추가할 점을 적어보세요.\n\n예) 말투를 더 다정하게 바꿔줘. / 첫 상황을 비 오는 밤으로. / 직업을 의사로 바꾸고 배경을 현대로.'
			: '만들고 싶은 캐릭터를 자유롭게 적어보세요.\n\n예) 무뚝뚝하지만 속정 깊은 검술 도장 사범. 나는 도장에 새로 들어온 제자. 엄격한 말투, 가끔 츤데레. 무협 세계관.'}
		maxlength={ROUGH_MAX}
		bind:value={rough}
		disabled={loading}
	></textarea>
	<div class="a-meta">
		<span class="a-count">{rough.length}/{ROUGH_MAX}</span>
	</div>

	{#if error}<p class="a-error">{error}</p>{/if}
	{#if done && !error}<p class="a-done">✓ 폼에 채웠어요. 아래에서 확인·수정하세요.</p>{/if}

	{#if loading}
		<div class="a-run">
			<button class="a-gen" disabled>
				{hasContent ? '수정 중…' : '생성 중…'}
				{#if progressText}<span class="a-progress">{progressText}</span>{/if}
			</button>
			<button class="a-cancel" type="button" onclick={cancel}>취소</button>
		</div>
	{:else}
		<button class="a-gen" onclick={generate} disabled={!canGenerate}>
			{hasContent ? 'AI로 수정 반영' : 'AI로 생성'}
		</button>
	{/if}
	<p class="a-note">생성 결과는 폼에 채워질 뿐, 자동으로 등록되지 않아요. 썸네일·장면 이미지는 직접 추가해 주세요.</p>
</aside>

<style>
	.assist {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 18px;
		display: flex;
		flex-direction: column;
	}
	.a-head {
		margin-bottom: 14px;
	}
	.a-logo {
		color: var(--accent);
		font-size: 1.3rem;
	}
	.a-head h2 {
		margin: 4px 0 6px;
		font-size: 1.05rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.a-head p {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.55;
		color: var(--text-dim);
	}
	/* 모델 선택 드롭다운 (채팅 설정과 동일 룩) */
	.model-select {
		position: relative;
		margin-bottom: 12px;
	}
	.field-label {
		display: block;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-dim);
		margin-bottom: 6px;
	}
	.model-trigger {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.9rem;
		transition: border-color 0.15s ease;
	}
	.model-trigger:hover,
	.model-trigger.open {
		border-color: var(--accent);
	}
	.model-trigger:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.model-icon {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		object-fit: cover;
		flex-shrink: 0;
		background: #fff;
	}
	.model-icon.fallback {
		display: grid;
		place-items: center;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		color: #fff;
		font-size: 0.75rem;
		font-weight: 700;
	}
	.model-name {
		flex: 1;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chev {
		color: var(--text-faint);
		font-size: 0.8rem;
	}
	.model-list {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		z-index: 5;
		margin: 0;
		padding: 6px;
		list-style: none;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
		max-height: 320px;
		overflow-y: auto;
	}
	.model-option {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		background: transparent;
		border: none;
		border-radius: 8px;
		color: var(--text);
		font-size: 0.9rem;
	}
	.model-option:hover {
		background: var(--bg-elev);
	}
	.model-option.selected {
		background: var(--accent-soft);
	}
	.check {
		color: var(--accent);
		font-weight: 700;
	}

	.a-input {
		width: 100%;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 11px 13px;
		color: var(--text);
		font-size: 0.88rem;
		line-height: 1.6;
		outline: none;
		resize: vertical;
	}
	.a-input:focus {
		border-color: var(--accent);
	}
	.a-input::placeholder {
		color: var(--text-faint);
	}
	.a-input:disabled {
		opacity: 0.6;
	}
	.a-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 6px;
	}
	.a-count {
		font-size: 0.72rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.a-error {
		margin: 10px 0 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--nsfw);
	}
	.a-done {
		margin: 10px 0 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--accent);
	}
	.a-gen {
		margin-top: 14px;
		width: 100%;
		padding: 12px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		font-size: 0.92rem;
		transition: background 0.15s ease;
	}
	.a-gen:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.a-gen:not(:disabled):hover {
		background: var(--accent-hover);
	}
	.a-run {
		display: flex;
		gap: 8px;
		margin-top: 14px;
	}
	.a-run .a-gen {
		margin-top: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}
	.a-progress {
		font-size: 0.74rem;
		font-weight: 500;
		opacity: 0.9;
	}
	.a-cancel {
		padding: 0 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-dim);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.a-cancel:hover {
		color: var(--text);
		border-color: var(--text-dim);
	}
	.a-note {
		margin: 12px 0 0;
		font-size: 0.74rem;
		line-height: 1.5;
		color: var(--text-faint);
	}
</style>
