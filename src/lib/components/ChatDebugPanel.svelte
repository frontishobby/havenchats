<script lang="ts">
	import { onMount } from 'svelte';
	import type { Character } from '$lib/types';
	import type { ChatDebugSnapshot, ImageDebug } from '$lib/chatDebug';

	let {
		character,
		sessionId,
		snapshot,
		meta,
		imageDebug,
		model,
		maxSentences,
		userActs,
		draftText,
		streaming
	}: {
		character: Character;
		sessionId: string | null;
		/** 직전 실제 전송으로 받은 라이브 스냅샷(없을 수 있음). */
		snapshot: ChatDebugSnapshot | null;
		/** 직전 응답의 전체 메타(finishReason·usage·providerMetadata·warnings…). */
		meta: Record<string, unknown> | null;
		/** 마지막 실시간 이미지 생성에 사용한 프롬프트/파라미터(없을 수 있음). */
		imageDebug: ImageDebug | null;
		model: string;
		maxSentences: number;
		userActs: number;
		/** 작성 중 입력(미리보기에서 "다음 메시지"로 가상 주입). */
		draftText: string;
		streaming: boolean;
	} = $props();

	// inspect(드라이런) 결과. 있으면 이걸 우선 표시(현재 상태/편집 반영), 없으면 라이브 스냅샷.
	let preview = $state<ChatDebugSnapshot | null>(null);
	let inspecting = $state(false);
	let inspectError = $state<string | null>(null);
	// 표시 소스: 미리보기 우선. 둘 다 없으면 null.
	const view = $derived<ChatDebugSnapshot | null>(preview ?? snapshot);

	// 라이브 스냅샷이 새로 오면(실제 전송) 그게 최신이므로 미리보기를 비워 라이브를 보여준다.
	let lastLiveRef: ChatDebugSnapshot | null = null;
	$effect(() => {
		if (snapshot && snapshot !== lastLiveRef) {
			lastLiveRef = snapshot;
			preview = null;
			resyncVars(snapshot);
		}
	});

	// ── inspect 호출 ── 현재 세션·설정·(선택)편집변수로 "지금 보내면 나갈 프롬프트"를 조립.
	async function runInspect(opts?: { varsOverride?: Record<string, string>; withDraft?: boolean }) {
		if (inspecting) return;
		inspecting = true;
		inspectError = null;
		try {
			const res = await fetch('/api/chat/inspect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					characterId: character.id,
					sessionId: sessionId ?? undefined,
					text: opts?.withDraft ? draftText : undefined,
					model,
					maxSentences,
					userActs,
					varsOverride: opts?.varsOverride
				})
			});
			if (!res.ok) {
				inspectError = `inspect 실패 (HTTP ${res.status})`;
				return;
			}
			const snap = (await res.json()) as ChatDebugSnapshot;
			preview = snap;
			if (!varsDirty) resyncVars(snap);
		} catch (e) {
			inspectError = e instanceof Error ? e.message : String(e);
		} finally {
			inspecting = false;
		}
	}

	// 세션·캐릭터가 바뀌면 자동 미리보기(패널을 비우지 않게).
	let lastKey = '';
	$effect(() => {
		const key = `${character.id}|${sessionId ?? ''}`;
		if (key !== lastKey) {
			lastKey = key;
			varsDirty = false;
			runInspect();
		}
	});

	onMount(() => {
		if (!view) runInspect();
	});

	// ── 변수 편집 ── view.vars.after 를 행 배열로. 편집 중(dirty)이면 새 스냅샷이 와도 덮지 않는다.
	type VarRow = { key: string; value: string };
	let varRows = $state<VarRow[]>([]);
	let varsDirty = $state(false);
	let varsSaving = $state(false);
	let varsSaved = $state(false);

	function resyncVars(snap: ChatDebugSnapshot | null) {
		varRows = Object.entries(snap?.vars.after ?? {}).map(([key, value]) => ({ key, value }));
		varsDirty = false;
		varsSaved = false;
	}

	function varObject(): Record<string, string> {
		const o: Record<string, string> = {};
		for (const r of varRows) {
			const k = r.key.trim().toLowerCase();
			if (k) o[k] = r.value;
		}
		return o;
	}

	function markVarsDirty() {
		varsDirty = true;
		varsSaved = false;
	}
	function addVarRow() {
		varRows = [...varRows, { key: '', value: '' }];
		markVarsDirty();
	}
	function removeVarRow(i: number) {
		varRows = varRows.filter((_, j) => j !== i);
		markVarsDirty();
	}

	async function saveVars() {
		if (!sessionId || varsSaving) return;
		varsSaving = true;
		varsSaved = false;
		try {
			const res = await fetch('/api/chat/vars', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, characterId: character.id, vars: varObject() })
			});
			if (res.ok) {
				varsDirty = false;
				varsSaved = true;
				await runInspect(); // 저장값 반영한 프롬프트로 갱신
			} else {
				inspectError = `변수 저장 실패 (HTTP ${res.status})`;
			}
		} catch (e) {
			inspectError = e instanceof Error ? e.message : String(e);
		} finally {
			varsSaving = false;
		}
	}

	// 편집 변수로 저장 없이 미리보기만(실험).
	function previewWithVars() {
		runInspect({ varsOverride: varObject(), withDraft: true });
	}

	// 어떤 변수가 이전 대비 바뀌었나(하이라이트).
	function changed(key: string): boolean {
		if (!view) return false;
		return (view.vars.before[key] ?? '') !== (view.vars.after[key] ?? '');
	}
	function isNew(key: string): boolean {
		return !!view && !(key in view.vars.before) && key in view.vars.after;
	}

	// ── 응답 메타 파생 ──
	const usage = $derived(
		(meta?.usage ?? null) as {
			inputTokens?: number;
			outputTokens?: number;
			totalTokens?: number;
			cachedInputTokens?: number;
			inputTokenDetails?: {
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
				noCacheTokens?: number;
			};
		} | null
	);
	const finishReason = $derived((meta?.finishReason as string | undefined) ?? null);
	const gatewayCost = $derived.by(() => {
		const pm = meta?.providerMetadata as { gateway?: { cost?: unknown } } | undefined;
		const raw = pm?.gateway?.cost;
		if (raw == null) return null;
		const n = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(n) ? n : null;
	});
	const warnings = $derived.by(() => {
		const w = meta?.warnings;
		return Array.isArray(w) && w.length ? w : null;
	});
	const streamError = $derived((meta?.streamError as string | undefined) ?? null);

	// ── 유틸 ──
	function fmt(n: number | null | undefined): string {
		return typeof n === 'number' ? n.toLocaleString() : '–';
	}
	function pct(a: number, b: number): number {
		if (!b) return 0;
		return Math.min(100, Math.round((a / b) * 100));
	}
	let copied = $state<string | null>(null);
	async function copy(label: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = label;
			setTimeout(() => {
				if (copied === label) copied = null;
			}, 1200);
		} catch {
			/* clipboard 불가 환경 무시 */
		}
	}
	const ACTS_LABEL = ['금지', '적정', '풍부'];
	function shortId(id: string | null): string {
		return id ? id.slice(0, 8) : '(없음)';
	}
	function roleLabel(role: string): string {
		return role === 'user' ? '나' : role === 'assistant' ? 'AI' : role;
	}
</script>

<aside class="dbg" aria-label="채팅 디버그 패널">
	<header class="dbg-head">
		<div class="dbg-title">
			<span class="dot" class:live={view?.source === 'live'}></span>
			<strong>디버그</strong>
			{#if view}
				<span class="src">{view.source === 'live' ? '실전송' : '미리보기'}</span>
			{/if}
		</div>
		<div class="head-actions">
			<button class="mini" onclick={() => runInspect({ withDraft: true })} disabled={inspecting}>
				{inspecting ? '조회 중…' : '↻ 미리보기'}
			</button>
		</div>
	</header>

	{#if inspectError}
		<p class="dbg-err">{inspectError}</p>
	{/if}

	{#if !view}
		<p class="dbg-empty">메시지를 보내거나 <b>↻ 미리보기</b>를 누르면 조립 내부가 표시됩니다.</p>
	{:else}
		<!-- 개요/토큰 -->
		<div class="cards">
			<div class="card">
				<span class="k">모델</span><span class="v mono">{view.model}</span>
			</div>
			<div class="card">
				<span class="k">세션</span><span class="v mono">{shortId(view.session.id)}</span>
			</div>
			<div class="card">
				<span class="k">턴(index)</span><span class="v">{view.session.messageCount}</span>
			</div>
			<div class="card">
				<span class="k">분량/행동</span><span class="v">{view.settings.maxSentences}문장 · {ACTS_LABEL[view.settings.userActs] ?? view.settings.userActs}</span>
			</div>
		</div>

		<div class="tok">
			<div class="tok-row">
				<span>입력 추정</span>
				<span class="mono">{fmt(view.tokens.inputEst)} / {fmt(view.tokens.inputLimit)}</span>
			</div>
			<div class="bar"><i style="width:{pct(view.tokens.inputEst, view.tokens.inputLimit)}%"></i></div>
			<div class="tok-grid">
				<div><span>system</span><b class="mono">{fmt(view.tokens.system)}</b></div>
				<div><span>출력예약</span><b class="mono">{fmt(view.tokens.outputReserve)}</b></div>
				<div><span>컨텍스트</span><b class="mono">{fmt(view.tokens.contextLimit)}</b></div>
				<div><span>window</span><b class="mono">{view.window.length}{view.windowTrimmed ? `/${view.fullWindowLen}✂` : ''}</b></div>
			</div>
			{#if view.windowTrimmed}
				<p class="warn-line">입력 가드로 오래된 window가 잘렸습니다 (요약 경계 {view.summaryUptoSeq}).</p>
			{/if}
		</div>

		<!-- 응답 메타(직전 실제 응답) -->
		{#if meta}
			<details open class="sec">
				<summary>응답 메타 {finishReason && finishReason !== 'stop' ? '⚠️' : ''}</summary>
				<div class="meta-grid">
					<div><span>finishReason</span><b class="mono" class:bad={finishReason && finishReason !== 'stop'}>{finishReason ?? '–'}</b></div>
					<div><span>in</span><b class="mono">{fmt(usage?.inputTokens)}</b></div>
					<div><span>out</span><b class="mono">{fmt(usage?.outputTokens)}</b></div>
					<div><span>total</span><b class="mono">{fmt(usage?.totalTokens)}</b></div>
					<div><span>cacheRead</span><b class="mono">{fmt(usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens)}</b></div>
					<div><span>cacheWrite</span><b class="mono">{fmt(usage?.inputTokenDetails?.cacheWriteTokens)}</b></div>
					<div><span>비용</span><b class="mono">{gatewayCost != null ? `$${gatewayCost.toFixed(5)}` : '–'}</b></div>
					{#if (meta as { mock?: boolean }).mock}<div><span>mock</span><b class="mono">true</b></div>{/if}
				</div>
				{#if streamError}<p class="warn-line bad">streamError: {streamError}</p>{/if}
				{#if warnings}
					<ul class="warns">
						{#each warnings as w, i (i)}<li>{typeof w === 'string' ? w : JSON.stringify(w)}</li>{/each}
					</ul>
				{/if}
			</details>
		{/if}

		<!-- 실시간 이미지 생성 프롬프트(직전 생성) -->
		{#if imageDebug}
			{@const imgFail = !imageDebug.situation || imageDebug.llmError}
			<details open class="sec">
				<summary>이미지 생성 프롬프트 🖼 {imgFail ? '⚠️' : ''}</summary>
				<div class="meta-grid">
					<div><span>prompt LLM</span><b class="mono">{imageDebug.promptModel}</b></div>
					<div>
						<span>finishReason</span>
						<b class="mono" class:bad={imageDebug.finishReason && imageDebug.finishReason !== 'stop'}>
							{imageDebug.finishReason ?? '–'}
						</b>
					</div>
					<div><span>model</span><b class="mono">{imageDebug.model}</b></div>
					<div><span>해상도</span><b class="mono">{imageDebug.resolution}</b></div>
					<div><span>sampler</span><b class="mono">{imageDebug.params.sampler}</b></div>
					<div><span>scheduler</span><b class="mono">{imageDebug.params.scheduler}</b></div>
					<div><span>steps</span><b class="mono">{imageDebug.params.steps}</b></div>
					<div><span>CFG</span><b class="mono">{imageDebug.params.cfgScale}</b></div>
					<div><span>rescale</span><b class="mono">{imageDebug.params.cfgRescale}</b></div>
				</div>

				{#if imageDebug.llmError}
					<p class="warn-line bad">LLM 에러: {imageDebug.llmError}</p>
				{/if}
				{#if imageDebug.warnings.length > 0}
					<ul class="warns">
						{#each imageDebug.warnings as w, i (i)}
							<li>{typeof w === 'string' ? w : JSON.stringify(w)}</li>
						{/each}
					</ul>
				{/if}

				<div class="sub">캐릭터 외형 레퍼런스 (LLM 입력)</div>
				{#if imageDebug.characterRef}
					<pre class="dump small">{imageDebug.characterRef}</pre>
				{:else}
					<p class="muted">없음(description 비어 있음).</p>
				{/if}

				<div class="sub">상황 프롬프트 모델 응답 (원문)</div>
				{#if imageDebug.rawSituation}
					<pre class="dump small">{imageDebug.rawSituation}</pre>
				{:else}
					<p class="muted">빈 응답 — 모델이 아무 텍스트도 내지 않았습니다(안전필터 차단/길이 초과 등 finishReason 확인).</p>
				{/if}

				<div class="sub">정리 후 상황 프롬프트</div>
				{#if imageDebug.situation}
					<pre class="dump small">{imageDebug.situation}</pre>
				{:else}
					<p class="muted">없음 → NovelAI 요청을 보내지 않았습니다.</p>
				{/if}

				<div class="sub">그림체 프롬프트</div>
				{#if imageDebug.stylePrompt}
					<pre class="dump small">{imageDebug.stylePrompt}</pre>
				{:else}
					<p class="muted">미지정 → 기본 그림체 사용.</p>
				{/if}

				<div class="sub">최종 positive (NovelAI 전송)</div>
				{#if imageDebug.positive}
					<pre class="dump small">{imageDebug.positive}</pre>
				{:else}
					<p class="muted">생성 안 됨(상황 프롬프트 실패로 NovelAI 미요청).</p>
				{/if}

				<div class="sub">negative</div>
				<pre class="dump small">{imageDebug.negative}</pre>
			</details>
		{/if}

		<!-- 변수(CBS) — 편집 가능 -->
		<details open class="sec">
			<summary>
				변수 (CBS) <span class="count">{varRows.length}</span>
				{#if view.usedScripting}<span class="flag" title="평가 못 한 매크로가 있어 제거됨">scripting</span>{/if}
			</summary>
			{#if varRows.length === 0}
				<p class="muted">세션 변수가 없습니다. (charx 기본 변수/ setvar 로 생성)</p>
			{/if}
			<div class="vars">
				{#each varRows as row, i (i)}
					<div class="var-row" class:changed={changed(row.key)} class:isnew={isNew(row.key)}>
						<input
							class="v-key mono"
							placeholder="이름"
							bind:value={row.key}
							oninput={markVarsDirty}
						/>
						<input
							class="v-val mono"
							placeholder="값"
							bind:value={row.value}
							oninput={markVarsDirty}
						/>
						<button class="v-del" onclick={() => removeVarRow(i)} aria-label="삭제">×</button>
					</div>
				{/each}
			</div>
			<div class="var-actions">
				<button class="mini" onclick={addVarRow}>+ 추가</button>
				<button class="mini" onclick={previewWithVars} disabled={inspecting}>미리보기 적용</button>
				<span class="spacer"></span>
				{#if varsSaved && !varsDirty}<span class="ok">저장됨</span>{/if}
				<button
					class="mini primary"
					onclick={saveVars}
					disabled={!sessionId || !varsDirty || varsSaving}
					title={sessionId ? '세션 변수에 저장' : '세션이 생성된 뒤 저장 가능'}
				>
					{varsSaving ? '저장 중…' : '저장'}
				</button>
			</div>
			<p class="hint">
				default {Object.keys(view.vars.default).length} · 평가 전 {Object.keys(view.vars.before).length} · 평가 후 {Object.keys(view.vars.after).length}.
				<span class="lg changed-lg">변경</span><span class="lg new-lg">신규</span>
			</p>
		</details>

		<!-- system 프롬프트 -->
		<details open class="sec">
			<summary>
				system 프롬프트 <span class="count">{view.systemPrompt.length}자</span>
				<button class="copy" onclick={(e) => { e.preventDefault(); copy('sys', view.systemPrompt); }}>
					{copied === 'sys' ? '복사됨' : '복사'}
				</button>
			</summary>
			<pre class="dump">{view.systemPrompt}</pre>
		</details>

		<!-- 전송 메시지(window + 지침) -->
		<details class="sec">
			<summary>전송 메시지 <span class="count">{view.messages.length}</span></summary>
			<div class="msgs">
				{#each view.messages as m, i (i)}
					<div class="msg role-{m.role}">
						<div class="msg-h">
							<span class="role">{m.role}</span>
							<span class="mono tk">{m.tokens}t</span>
						</div>
						<pre class="dump small">{m.content}</pre>
					</div>
				{/each}
			</div>
		</details>

		<!-- window(DB 메시지) -->
		<details class="sec">
			<summary>window <span class="count">{view.window.length}{view.windowTrimmed ? `/${view.fullWindowLen}` : ''}</span></summary>
			<div class="msgs">
				{#each view.window as m (m.seq)}
					<div class="msg role-{m.role}">
						<div class="msg-h">
							<span class="role">#{m.seq} {roleLabel(m.role)}</span>
							<span class="mono tk">{m.tokens}t</span>
						</div>
						<pre class="dump small">{m.content}</pre>
					</div>
				{/each}
			</div>
		</details>

		<!-- 로어북 / 장면 카탈로그 -->
		<details class="sec">
			<summary>로어 · 장면 <span class="count">{view.lorebookEntryCount}항목</span></summary>
			{#if view.loreBlock}
				<div class="sub">주입된 로어 블록</div>
				<pre class="dump small">{view.loreBlock}</pre>
			{:else}
				<p class="muted">이번 턴 주입된 로어 없음 (전체 {view.lorebookEntryCount}항목 중 매칭/상시 없음).</p>
			{/if}
			{#if view.imageCatalog}
				<div class="sub">장면 이미지 카탈로그</div>
				<pre class="dump small">{view.imageCatalog}</pre>
			{/if}
		</details>

		<!-- 요약 / 상시 기억 -->
		<details class="sec">
			<summary>요약 · 상시 기억</summary>
			<div class="sub">요약 (경계 seq {view.summaryUptoSeq})</div>
			{#if view.summary}<pre class="dump small">{view.summary}</pre>{:else}<p class="muted">아직 요약 없음.</p>{/if}
			<div class="sub">상시 기억</div>
			{#if view.memory}<pre class="dump small">{view.memory}</pre>{:else}<p class="muted">없음.</p>{/if}
			<p class="hint">요약·상시 기억 편집은 채팅 ⚙ 설정에서.</p>
		</details>

		<!-- 평가 전/후 description -->
		<details class="sec">
			<summary>description (원본 ↔ 평가)</summary>
			<div class="sub">CBS 평가 후</div>
			<pre class="dump small">{view.evaluatedDescription}</pre>
			<div class="sub">원본</div>
			<pre class="dump small">{view.rawDescription}</pre>
		</details>

		<!-- 원본 JSON -->
		<details class="sec">
			<summary>
				원본 스냅샷 JSON
				<button class="copy" onclick={(e) => { e.preventDefault(); copy('json', JSON.stringify(view, null, 2)); }}>
					{copied === 'json' ? '복사됨' : '복사'}
				</button>
			</summary>
			<pre class="dump small">{JSON.stringify(view, null, 2)}</pre>
		</details>
	{/if}

	{#if streaming}<div class="streaming-note">스트리밍 중…</div>{/if}
</aside>

<style>
	.dbg {
		flex: 0 0 var(--dbg-w, 460px);
		width: var(--dbg-w, 460px);
		max-width: 50vw;
		height: 100%;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--bg-card);
		border-left: 1px solid var(--border);
		font-family: 'Pretendard', system-ui, sans-serif;
		font-size: 0.8rem;
		color: var(--text);
		padding: 12px 12px 60px;
	}
	@media (max-width: 900px) {
		.dbg {
			flex: 1 1 auto;
			width: 100%;
			max-width: none;
			height: 50vh;
			border-left: none;
			border-top: 1px solid var(--border);
		}
	}
	.mono {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
	}

	.dbg-head {
		position: sticky;
		top: -12px;
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 2px;
		margin: -12px -12px 8px;
		padding-left: 12px;
		padding-right: 12px;
		background: var(--bg-card);
		border-bottom: 1px solid var(--border);
	}
	.dbg-title {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.dbg-title strong {
		font-size: 0.92rem;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.dot.live {
		background: #34d399;
	}
	.src {
		font-size: 0.68rem;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--bg-elev);
		color: var(--text-dim);
	}

	button.mini {
		padding: 4px 9px;
		font-size: 0.74rem;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--bg-elev);
		color: var(--text);
		cursor: pointer;
	}
	button.mini:hover:not(:disabled) {
		border-color: var(--accent);
	}
	button.mini:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button.mini.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}

	.dbg-err {
		margin: 0 0 8px;
		padding: 6px 8px;
		font-size: 0.74rem;
		color: var(--danger, #ef4444);
		background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
		border-radius: 6px;
	}
	.dbg-empty {
		color: var(--text-dim);
		line-height: 1.6;
		padding: 14px 4px;
	}

	.cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
		margin-bottom: 10px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 7px 9px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 8px;
		min-width: 0;
	}
	.card .k {
		font-size: 0.66rem;
		color: var(--text-faint);
	}
	.card .v {
		font-size: 0.8rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tok {
		padding: 9px 10px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 8px;
		margin-bottom: 10px;
	}
	.tok-row {
		display: flex;
		justify-content: space-between;
		font-size: 0.76rem;
		margin-bottom: 5px;
	}
	.bar {
		height: 6px;
		border-radius: 3px;
		background: var(--bg);
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--nsfw, #f59e0b));
	}
	.tok-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 4px 12px;
		margin-top: 8px;
	}
	.tok-grid > div {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		color: var(--text-dim);
	}
	.warn-line {
		margin: 7px 0 0;
		font-size: 0.7rem;
		color: var(--nsfw, #f59e0b);
	}
	.warn-line.bad,
	.bad {
		color: var(--danger, #ef4444);
	}

	.sec {
		border: 1px solid var(--border);
		border-radius: 8px;
		margin-bottom: 8px;
		background: var(--bg);
		overflow: hidden;
	}
	.sec > summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		list-style: none;
		user-select: none;
	}
	.sec > summary::-webkit-details-marker {
		display: none;
	}
	.sec > summary::before {
		content: '▸';
		color: var(--text-faint);
		font-size: 0.7rem;
	}
	.sec[open] > summary::before {
		content: '▾';
	}
	.count {
		font-size: 0.68rem;
		font-weight: 500;
		color: var(--text-faint);
	}
	.flag {
		font-size: 0.64rem;
		padding: 1px 5px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--nsfw, #f59e0b) 22%, transparent);
		color: var(--nsfw, #f59e0b);
	}
	.copy {
		margin-left: auto;
		padding: 2px 8px;
		font-size: 0.68rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-elev);
		color: var(--text-dim);
		cursor: pointer;
	}
	.copy:hover {
		color: var(--text);
	}

	.dump {
		margin: 0;
		padding: 9px 10px;
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.72rem;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 360px;
		overflow-y: auto;
		color: #cdd3e0;
	}
	.dump.small {
		font-size: 0.68rem;
		max-height: 240px;
	}

	.meta-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 4px 12px;
		padding: 9px 10px;
		border-top: 1px solid var(--border);
	}
	.meta-grid > div {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		color: var(--text-dim);
	}
	.warns {
		margin: 0;
		padding: 6px 10px 9px 26px;
		font-size: 0.7rem;
		color: var(--nsfw, #f59e0b);
	}

	/* 변수 편집 */
	.vars {
		padding: 8px 10px 0;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.var-row {
		display: flex;
		gap: 5px;
		align-items: center;
		border-left: 2px solid transparent;
		padding-left: 4px;
	}
	.var-row.changed {
		border-left-color: var(--accent);
	}
	.var-row.isnew {
		border-left-color: #34d399;
	}
	.v-key,
	.v-val {
		min-width: 0;
		padding: 4px 7px;
		font-size: 0.72rem;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text);
		outline: none;
	}
	.v-key {
		flex: 0 0 38%;
	}
	.v-val {
		flex: 1 1 auto;
	}
	.v-key:focus,
	.v-val:focus {
		border-color: var(--accent);
	}
	.v-del {
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-elev);
		color: var(--text-dim);
		cursor: pointer;
		line-height: 1;
	}
	.v-del:hover {
		color: var(--danger, #ef4444);
		border-color: var(--danger, #ef4444);
	}
	.var-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 9px 10px;
	}
	.var-actions .spacer {
		flex: 1;
	}
	.ok {
		font-size: 0.7rem;
		color: #34d399;
	}
	.hint {
		margin: 0;
		padding: 0 10px 9px;
		font-size: 0.68rem;
		color: var(--text-faint);
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.lg {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding-left: 8px;
		position: relative;
	}
	.lg::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}
	.changed-lg::before {
		background: var(--accent);
	}
	.new-lg::before {
		background: #34d399;
	}
	.muted {
		margin: 0;
		padding: 9px 10px;
		border-top: 1px solid var(--border);
		font-size: 0.72rem;
		color: var(--text-faint);
	}
	.sub {
		padding: 8px 10px 2px;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--text-dim);
		border-top: 1px solid var(--border);
	}
	.sub + .dump {
		border-top: none;
	}

	.msgs {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--border);
	}
	.msg + .msg {
		border-top: 1px solid var(--border);
	}
	.msg-h {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 10px 0;
	}
	.msg-h .role {
		font-size: 0.68rem;
		font-weight: 700;
		color: var(--accent);
	}
	.msg.role-user .msg-h .role {
		color: #9fb2ff;
	}
	.msg.role-system .msg-h .role {
		color: var(--nsfw, #f59e0b);
	}
	.tk {
		font-size: 0.66rem;
		color: var(--text-faint);
	}
	.msg .dump {
		border-top: none;
		background: transparent;
		max-height: 200px;
	}

	.streaming-note {
		position: sticky;
		bottom: 0;
		margin: 8px -12px -60px;
		padding: 6px 12px;
		font-size: 0.7rem;
		color: var(--text-dim);
		background: var(--bg-card);
		border-top: 1px solid var(--border);
	}
</style>
