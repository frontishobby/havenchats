<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { MODELS, DEFAULT_MODEL_ID, getModel } from '$lib/data/models';
	import { openLogin } from '$lib/state/loginModal.svelte';
	import NsfwBadge from '$lib/components/NsfwBadge.svelte';
	import type { ChatMessage } from '$lib/types';
	import type { PageData } from './$types';

	const SENTENCE_MIN = 5;
	const SENTENCE_MAX = 30;
	const SENTENCE_KEY = 'haven:maxSentences';

	const USER_ACTS_KEY = 'haven:userActs';
	const USER_ACTS_LABELS = ['금지', '적정', '풍부'];

	const MODEL_KEY = 'haven:model';

	let { data }: { data: PageData } = $props();
	const character = $derived(data.character);

	function greetingMessages(content: string): ChatMessage[] {
		return content ? [{ id: crypto.randomUUID(), role: 'assistant', content }] : [];
	}

	// 첫 상황(오프닝)은 메인 상세 모달에서 골라 ?o=<index> 로 전달된다. (범위 보정은 서버 load)
	function openingFor(c: typeof data.character, idx: number): string {
		if (c.greetings.length === 0) return '';
		const i = idx >= 0 && idx < c.greetings.length ? idx : 0;
		return c.greetings[i].content;
	}

	let messages = $state<ChatMessage[]>(
		greetingMessages(openingFor(data.character, data.openingIndex))
	);
	let input = $state('');
	let streaming = $state(false);
	let imgFailed = $state(false);
	let scroller = $state<HTMLDivElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);

	// ── 채팅 설정 ──
	let showSettings = $state(false);
	let modelOpen = $state(false); // 모델 드롭다운 열림
	let model = $state(DEFAULT_MODEL_ID); // 선택된 모델 ID
	let maxSentences = $state(12); // 응답 분량(문장 수)
	let userActs = $state(1); // '나' 행동·대사 생성: 0=금지, 1=적정, 2=풍부
	let iconFailed = $state<Record<string, boolean>>({});

	const currentModel = $derived(getModel(model) ?? MODELS[0]);

	onMount(() => {
		const savedModel = localStorage.getItem(MODEL_KEY);
		if (savedModel && getModel(savedModel)) model = savedModel;
		const savedLen = Number(localStorage.getItem(SENTENCE_KEY));
		if (savedLen) maxSentences = Math.min(SENTENCE_MAX, Math.max(SENTENCE_MIN, savedLen));
		const savedActs = localStorage.getItem(USER_ACTS_KEY);
		if (savedActs !== null) userActs = Math.min(2, Math.max(0, Number(savedActs)));
	});
	$effect(() => {
		localStorage.setItem(MODEL_KEY, model);
	});
	$effect(() => {
		localStorage.setItem(SENTENCE_KEY, String(maxSentences));
	});
	$effect(() => {
		localStorage.setItem(USER_ACTS_KEY, String(userActs));
	});

	function selectModel(id: string) {
		model = id;
		modelOpen = false;
	}

	function closeSettings() {
		showSettings = false;
		modelOpen = false;
	}

	// 다른 캐릭터로 이동(컴포넌트 재사용) 시 이야기를 새로 시작
	let currentId = data.character.id;
	$effect(() => {
		if (character.id !== currentId) {
			currentId = character.id;
			messages = greetingMessages(openingFor(character, data.openingIndex));
			input = '';
		}
	});

	// ── 소설 파서: {@html} 없이 텍스트 세그먼트로만 렌더 → XSS 안전.
	//   • 대사 줄("이름 | 대사")   → parseInline: 괄호( )/별표(*) 안만 기울임, 대사 본문은 정자체.
	//   • 서술/지시문 줄(그 외 전체) → parseNarration: 줄 전체를 기울임. 단 "..." 대사는 정자체로 유지.
	//   모델이 묘사를 괄호로 감싸든(한 줄·여러 줄) 그냥 산문으로 쓰든 일관되게 기울임으로 보인다.
	type Segment = { text: string; italic: boolean };

	// 대사 줄 안의 인라인 지시문: ( )/*..* 안만 기울임. 구분자(괄호·별표)는 제거.
	function parseInline(content: string): Segment[] {
		const segments: Segment[] = [];
		const re = /\(([^)]*)\)|\*([^*]+)\*/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			if (m.index > last) segments.push({ text: content.slice(last, m.index), italic: false });
			segments.push({ text: m[1] ?? m[2] ?? '', italic: true });
			last = re.lastIndex;
		}
		if (last < content.length) segments.push({ text: content.slice(last), italic: false });
		return segments;
	}

	// 서술 줄: 큰따옴표("..." / “...”) 안=대사(정자체), 그 밖 전체=기울임.
	// 괄호·별표는 기울임 구분자로 보고 제거(내용만 남김).
	const QUOTE_RE = /"([^"]*)"|“([^”]*)”/g;
	function parseNarration(line: string): Segment[] {
		const segments: Segment[] = [];
		const pushNarr = (raw: string) => {
			const clean = raw.replace(/[()*]/g, '');
			if (clean) segments.push({ text: clean, italic: true });
		};
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = QUOTE_RE.exec(line)) !== null) {
			if (m.index > last) pushNarr(line.slice(last, m.index));
			const inner = m[1] ?? m[2] ?? '';
			segments.push({ text: `"${inner}"`, italic: false });
			last = QUOTE_RE.lastIndex;
		}
		if (last < line.length) pushNarr(line.slice(last));
		return segments;
	}

	// 비어있지 않은 줄 단위로 분리 (대사/지시문이 줄바꿈으로 구분됨)
	function toLines(content: string): string[] {
		return content
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	}

	// "발화자 | 대사" 형식이면 분리. 발화자는 |·(·줄바꿈 없는 짧은 토큰.
	function parseSpeaker(line: string): { speaker: string; rest: string } | null {
		const m = /^([^|\n(]{1,24}?)\s*\|\s*(.+)$/.exec(line);
		return m ? { speaker: m[1].trim(), rest: m[2] } : null;
	}

	const lastMessage = $derived(messages[messages.length - 1]);

	async function scrollToBottom() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	async function send() {
		const text = input.trim();
		if (!text || streaming) return;

		// 비로그인 상태에서는 전송 대신 로그인 모달을 띄운다 (입력값은 유지)
		if (!data.user) {
			openLogin();
			return;
		}

		input = '';
		resetTextareaHeight();

		messages.push({ id: crypto.randomUUID(), role: 'user', content: text });

		// 보낼 메시지는 빈 placeholder 를 넣기 전에 만든다(인사말 + 이전 턴 + 방금 입력)
		const outgoing = messages.map(({ role, content }) => ({ role, content }));

		// assistant placeholder. $state 배열은 push 시 프록시로 감싸므로,
		// 반드시 messages[idx] (프록시)를 통해 수정해야 반응성이 동작한다.
		const idx = messages.length;
		messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '' });
		streaming = true;
		await scrollToBottom();

		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					characterId: character.id,
					messages: outgoing,
					model,
					maxSentences,
					userActs,
					userName: data.user?.name ?? undefined,
					userPersona: data.user?.persona ?? undefined
				})
			});

			if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				messages[idx].content += decoder.decode(value, { stream: true });
				await scrollToBottom();
			}
		} catch (e) {
			messages[idx].content = '⚠️ 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.';
			console.error(e);
		} finally {
			streaming = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	}

	function onWindowKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (modelOpen) modelOpen = false;
		else if (showSettings) showSettings = false;
	}

	function autoGrow() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
	}
	function resetTextareaHeight() {
		if (textarea) textarea.style.height = 'auto';
	}
</script>

<svelte:head>
	<title>{character.name} — Haven</title>
</svelte:head>

<svelte:window onkeydown={onWindowKey} />

<div class="chat">
	<header class="chat-header">
		<a class="back" href="/" aria-label="뒤로">←</a>
		<div class="avatar-sm">
			{#if imgFailed}
				<span>{character.name.charAt(0)}</span>
			{:else}
				<img src={character.avatarUrl} alt={character.name} onerror={() => (imgFailed = true)} />
			{/if}
		</div>
		<div class="who">
			<div class="name-row">
				<strong>{character.name}</strong>
				{#if character.contentRating === 'nsfw'}
					<NsfwBadge size={17} />
				{/if}
			</div>
			<span class="tagline">{character.tagline}</span>
		</div>
		<div class="header-right">
			<button
				class="settings-btn"
				class:active={showSettings}
				onclick={() => (showSettings = !showSettings)}
				aria-label="채팅 설정"
				aria-expanded={showSettings}
			>
				⚙
			</button>
		</div>
	</header>

	{#if showSettings}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="modal-backdrop" onclick={closeSettings} role="presentation">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="채팅 설정"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
			>
				<div class="modal-head">
					<h2>채팅 설정</h2>
					<button class="modal-close" onclick={closeSettings} aria-label="닫기">✕</button>
				</div>

				<div class="setting">
					<div class="setting-row">
						<span class="field-label" id="model-label">모델</span>
					</div>
					<div class="model-select">
						<button
							class="model-trigger"
							class:open={modelOpen}
							onclick={() => (modelOpen = !modelOpen)}
							aria-haspopup="listbox"
							aria-expanded={modelOpen}
							aria-labelledby="model-label"
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
							<ul class="model-list" role="listbox" aria-labelledby="model-label">
								{#each MODELS as m (m.id)}
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
				</div>

				<div class="setting">
					<div class="setting-row">
						<label for="len-slider">답변 길이</label>
						<span class="len-val">약 {maxSentences}문장</span>
					</div>
					<input
						id="len-slider"
						type="range"
						min={SENTENCE_MIN}
						max={SENTENCE_MAX}
						step="1"
						bind:value={maxSentences}
					/>
					<div class="len-scale">
						<span>짧게 ({SENTENCE_MIN})</span>
						<span>길게 ({SENTENCE_MAX})</span>
					</div>
				</div>

				<div class="setting">
					<div class="setting-row">
						<label for="acts-slider">'나'의 행동·대사 생성</label>
						<span class="len-val">{USER_ACTS_LABELS[userActs]}</span>
					</div>
					<input id="acts-slider" type="range" min="0" max="2" step="1" bind:value={userActs} />
					<div class="len-scale">
						{#each USER_ACTS_LABELS as label (label)}
							<span>{label}</span>
						{/each}
					</div>
					<p class="setting-hint">
						{#if userActs === 0}
							AI는 캐릭터와 상황만 묘사하고, 내 행동·대사는 대신 쓰지 않습니다.
						{:else if userActs === 2}
							AI가 내 행동·대사까지 함께 묘사하며 이야기를 적극적으로 이끕니다.
						{:else}
							내 입력을 따르되, 자연스러운 가벼운 반응 정도만 덧붙입니다.
						{/if}
					</p>
				</div>
			</div>
		</div>
	{/if}

	{#snippet novelBody(content: string)}
		{#each toLines(content) as line, i (i)}
			{@const sp = parseSpeaker(line)}
			<span class="line" class:dialogue={!!sp} class:narration={!sp}>
				{#if sp}<b class="speaker">{sp.speaker}</b>{' '}{/if}
				{#each sp ? parseInline(sp.rest) : parseNarration(line) as seg, j (j)}
					{#if seg.italic}<em>{seg.text}</em>{:else}{seg.text}{/if}
				{/each}
			</span>
		{/each}
	{/snippet}

	<div class="reader" bind:this={scroller}>
		<article class="novel">
			{#each messages as m (m.id)}
				{#if m.content || (streaming && m === lastMessage)}
					<div class="para {m.role}">
						{@render novelBody(m.content)}
						{#if streaming && m.role === 'assistant' && m === lastMessage}
							{#if m.content}<span class="cursor"></span>{:else}<span class="typing"
									><i></i><i></i><i></i></span
								>{/if}
						{/if}
					</div>
				{/if}
			{/each}
		</article>
	</div>

	<div class="composer">
		<div class="composer-inner">
			<textarea
				bind:this={textarea}
				bind:value={input}
				oninput={autoGrow}
				onkeydown={onKeydown}
				placeholder={`행동이나 대사를 입력하세요…`}
				rows="1"
			></textarea>
			<button class="send" onclick={send} disabled={!input.trim() || streaming} aria-label="전송">
				↑
			</button>
		</div>
		<p class="disclaimer">AI가 생성한 이야기이며 실제 인물과 무관합니다.</p>
	</div>
</div>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 60px);
		max-width: 760px;
		margin: 0 auto;
	}

	.chat-header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	.back {
		font-size: 1.4rem;
		color: var(--text-dim);
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: 8px;
	}
	.back:hover {
		background: var(--bg-card);
		color: var(--text);
	}
	.avatar-sm {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		overflow: hidden;
		flex-shrink: 0;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
		display: grid;
		place-items: center;
		color: #fff;
		font-weight: 700;
	}
	.avatar-sm img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.who {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
		min-width: 0;
	}
	.who .name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.who strong {
		font-size: 0.98rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who .tagline {
		font-size: 0.78rem;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.header-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.settings-btn {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-dim);
		font-size: 1rem;
		display: grid;
		place-items: center;
		transition: all 0.15s ease;
	}
	.settings-btn:hover {
		color: var(--text);
		border-color: var(--text-faint);
	}
	.settings-btn.active {
		color: #fff;
		background: var(--accent);
		border-color: var(--accent);
	}

	/* 설정 모달 */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(2px);
		display: grid;
		place-items: center;
		padding: 20px;
	}
	.modal {
		width: 100%;
		max-width: 380px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 18px;
	}
	.modal-head h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 700;
	}
	.modal-close {
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.95rem;
	}
	.modal-close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}
	.setting-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.setting-row label,
	.setting-row .field-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text);
	}
	.len-val {
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--accent);
	}
	.modal input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
		cursor: pointer;
	}
	.len-scale {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: var(--text-faint);
		margin-top: 4px;
	}
	.setting + .setting {
		margin-top: 22px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
	}
	.setting-hint {
		margin: 8px 0 0;
		font-size: 0.74rem;
		line-height: 1.45;
		color: var(--text-dim);
	}

	/* 모델 드롭다운 */
	.model-select {
		position: relative;
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
		max-height: 280px;
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

	/* ── 소설 리더 ── */
	.reader {
		flex: 1;
		overflow-y: auto;
		padding: 28px 24px 40px;
	}
	.novel {
		font-size: 1.05rem;
		line-height: 2;
		color: var(--text);
		letter-spacing: 0.01em;
	}
	.para {
		margin: 0 0 1.5em;
		word-break: break-word;
	}
	/* 줄 단위(대사/지시문) */
	.line {
		display: block;
	}
	.line + .line {
		margin-top: 0.45em;
	}
	/* 캐릭터(서술) 턴 */
	.para.assistant {
		color: #e7e7ef;
	}
	/* 사용자(나) 턴 — 블록 없이 색으로만 옅게 구분 */
	.para.user {
		color: #9fb2ff;
	}
	/* 괄호/별표 안 지시문·해설 → 기울임 */
	.para em {
		font-style: italic;
		color: var(--text-dim);
	}
	.para.user em {
		color: #7e8fd6;
	}
	/* 대사 발화자 라벨: "발화자 | 대사" */
	.speaker {
		font-weight: 700;
		color: var(--accent);
	}
	.para.user .speaker {
		color: #9fb2ff;
	}

	.cursor {
		display: inline-block;
		width: 8px;
		height: 1.1em;
		margin-left: 1px;
		background: var(--accent);
		vertical-align: text-bottom;
		animation: blink 1s steps(2) infinite;
	}
	@keyframes blink {
		0%,
		50% {
			opacity: 1;
		}
		50.01%,
		100% {
			opacity: 0;
		}
	}
	.typing {
		display: inline-flex;
		gap: 5px;
		vertical-align: middle;
	}
	.typing i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
		animation: bounce 1.2s infinite ease-in-out;
	}
	.typing i:nth-child(2) {
		animation-delay: 0.15s;
	}
	.typing i:nth-child(3) {
		animation-delay: 0.3s;
	}
	@keyframes bounce {
		0%,
		60%,
		100% {
			transform: translateY(0);
			opacity: 0.5;
		}
		30% {
			transform: translateY(-5px);
			opacity: 1;
		}
	}

	.composer {
		padding: 12px 16px 16px;
		border-top: 1px solid var(--border);
		background: var(--bg);
	}
	.composer-inner {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 24px;
		padding: 6px 6px 6px 16px;
		transition: border-color 0.15s ease;
	}
	.composer-inner:focus-within {
		border-color: var(--accent);
	}
	textarea {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		resize: none;
		color: var(--text);
		font-size: 0.95rem;
		line-height: 1.5;
		padding: 8px 0;
		max-height: 160px;
	}
	textarea::placeholder {
		color: var(--text-faint);
	}
	.send {
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border: none;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		font-size: 1.2rem;
		font-weight: 700;
		display: grid;
		place-items: center;
		transition:
			background 0.15s ease,
			opacity 0.15s ease;
	}
	.send:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.send:not(:disabled):hover {
		background: var(--accent-hover);
	}
	.disclaimer {
		text-align: center;
		font-size: 0.72rem;
		color: var(--text-faint);
		margin: 8px 0 0;
	}
</style>
