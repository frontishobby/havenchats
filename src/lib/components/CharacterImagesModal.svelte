<script module lang="ts">
	/** 부모(CharacterForm)와 주고받는 드래프트 타입. previewUrl 은 모달 내부 전용. */
	export interface SceneAxisDraft {
		label: string;
		values: string[];
	}
	export interface SceneEntryDraft {
		id: string;
		combo: number[];
		/** 새 업로드 파일(있으면 교체). 없으면 기존 ext 유지. */
		file: File | null;
		/** 기존 이미지 확장자(수정 모드). 새 파일이 있으면 무시됨. */
		ext: string | null;
	}
	export interface SceneApply {
		axes: SceneAxisDraft[];
		entries: SceneEntryDraft[];
	}
</script>

<script lang="ts">
	import { IMAGE_LIMITS, comboToCode, entryUrl } from '$lib/imageCodes';

	let {
		open,
		characterId,
		initialAxes,
		initialEntries,
		onclose,
		onapply
	}: {
		open: boolean;
		/** 기존 이미지 미리보기용(수정 모드). 생성 모드면 undefined. */
		characterId?: string;
		initialAxes: SceneAxisDraft[];
		initialEntries: SceneEntryDraft[];
		onclose: () => void;
		onapply: (result: SceneApply) => void;
	} = $props();

	const ACCEPT = ['image/webp', 'image/avif'];
	const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

	interface WorkingEntry extends SceneEntryDraft {
		previewUrl: string | null; // 새 파일의 objectURL
	}

	let axes = $state<SceneAxisDraft[]>([]);
	let entries = $state<WorkingEntry[]>([]);
	let error = $state('');

	// 모달이 열릴 때 부모 드래프트를 복사해 편집 시작.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			revokePreviews();
			axes = initialAxes.map((a) => ({ label: a.label, values: [...a.values] }));
			entries = initialEntries.map((e) => ({
				id: e.id,
				combo: [...e.combo],
				file: e.file,
				ext: e.ext,
				previewUrl: e.file ? URL.createObjectURL(e.file) : null
			}));
			error = '';
		}
		wasOpen = open;
	});

	function revokePreviews() {
		for (const e of entries) if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
	}

	function uid(): string {
		return crypto.randomUUID();
	}

	// ── 축(열) ──
	function addAxis() {
		if (axes.length >= IMAGE_LIMITS.MAX_AXES) return;
		axes.push({ label: '', values: [''] });
		for (const e of entries) e.combo.push(0); // 새 축은 기본값 0
	}
	function removeAxis(k: number) {
		axes.splice(k, 1);
		for (const e of entries) e.combo.splice(k, 1);
		if (axes.length === 0) {
			revokePreviews();
			entries = [];
		}
	}
	function addValue(a: number) {
		if (axes[a].values.length >= IMAGE_LIMITS.MAX_AXIS_VALUES) return;
		axes[a].values.push('');
	}
	function removeValue(a: number, v: number) {
		if (axes[a].values.length <= 1) return; // 마지막 값은 못 지움
		axes[a].values.splice(v, 1);
		// 그 값을 쓰던 조합은 제거, 더 뒤 index 는 한 칸 당김.
		const removed = entries.filter((e) => e.combo[a] === v);
		for (const e of removed) if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
		entries = entries
			.filter((e) => e.combo[a] !== v)
			.map((e) => {
				if (e.combo[a] > v) e.combo[a] -= 1;
				return e;
			});
	}

	// ── 조합(행) ──
	const canAddEntry = $derived(axes.length > 0 && axes.every((a) => a.values.length > 0));
	function addEntry() {
		if (!canAddEntry || entries.length >= IMAGE_LIMITS.MAX_ENTRIES) return;
		entries.push({ id: uid(), combo: axes.map(() => 0), file: null, ext: null, previewUrl: null });
	}
	function removeEntry(i: number) {
		const e = entries[i];
		if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
		entries.splice(i, 1);
	}
	function setEntryFile(i: number, file: File | undefined | null) {
		error = '';
		if (!file) return;
		if (!ACCEPT.includes(file.type)) {
			error = '장면 이미지는 webp 또는 avif 만 가능합니다.';
			return;
		}
		if (file.size > IMAGE_MAX_BYTES) {
			error = '장면 이미지 용량이 너무 큽니다 (최대 3MB).';
			return;
		}
		const e = entries[i];
		if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
		e.file = file;
		e.previewUrl = URL.createObjectURL(file);
	}
	function onEntryFileChange(i: number, ev: Event) {
		const input = ev.target as HTMLInputElement;
		setEntryFile(i, input.files?.[0]);
		input.value = '';
	}

	function entryImageUrl(e: WorkingEntry): string | null {
		if (e.previewUrl) return e.previewUrl;
		if (characterId && e.ext) return entryUrl(characterId, { id: e.id, combo: e.combo, ext: e.ext });
		return null;
	}

	function letter(i: number): string {
		return String.fromCharCode(65 + i);
	}

	// ── 적용(완료) ──
	function apply() {
		// 가벼운 클라이언트 검증(자세한 건 서버가 재검증).
		for (const a of axes) {
			if (!a.label.trim()) {
				error = '축 이름을 입력해 주세요.';
				return;
			}
			if (a.values.some((v) => !v.trim())) {
				error = '빈 값 이름이 있습니다. 모든 값에 이름을 입력해 주세요.';
				return;
			}
		}
		const seen = new Set<string>();
		for (const e of entries) {
			const key = e.combo.join(',');
			if (seen.has(key)) {
				error = `중복된 조합이 있습니다: {${comboToCode(e.combo)}}`;
				return;
			}
			seen.add(key);
			if (!e.file && !e.ext) {
				error = `조합 {${comboToCode(e.combo)}} 에 이미지를 추가해 주세요.`;
				return;
			}
		}
		onapply({
			axes: axes.map((a) => ({ label: a.label.trim(), values: a.values.map((v) => v.trim()) })),
			entries: entries.map((e) => ({ id: e.id, combo: [...e.combo], file: e.file, ext: e.ext }))
		});
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onclose} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="장면 이미지 관리"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="head">
				<h2>장면 이미지 관리</h2>
				<button class="close" onclick={onclose} aria-label="닫기">✕</button>
			</div>

			<p class="intro">
				축(열)을 정의하고 조합(행)마다 이미지를 등록하세요. 각 조합엔 <strong>코드</strong>가
				자동 부여되고, AI가 그 코드를 출력하면 해당 이미지가 대화에 나타납니다.
			</p>

			<!-- ① 축 정의 -->
			<section class="block">
				<div class="block-head">
					<h3>① 축 (열)</h3>
					{#if axes.length < IMAGE_LIMITS.MAX_AXES}
						<button class="ghost" onclick={addAxis}>+ 축 추가</button>
					{/if}
				</div>

				{#if axes.length === 0}
					<p class="empty">축을 추가해 시작하세요. (예: 캐릭터 · 의상 · 표정)</p>
				{/if}

				<div class="axes">
					{#each axes as axis, a (a)}
						<div class="axis">
							<div class="axis-head">
								<span class="axis-pos">{a + 1}번째 글자</span>
								<input
									class="axis-label"
									type="text"
									placeholder="축 이름 (예: 표정)"
									maxlength={IMAGE_LIMITS.AXIS_LABEL_MAX}
									bind:value={axes[a].label}
								/>
								<button class="del" onclick={() => removeAxis(a)} aria-label="축 삭제">✕</button>
							</div>
							<div class="values">
								{#each axis.values as _, v (v)}
									<div class="value">
										<span class="badge">{letter(v)}</span>
										<input
											type="text"
											placeholder="값 이름"
											maxlength={IMAGE_LIMITS.VALUE_LABEL_MAX}
											bind:value={axes[a].values[v]}
										/>
										{#if axis.values.length > 1}
											<button
												class="del sm"
												onclick={() => removeValue(a, v)}
												aria-label="값 삭제">✕</button
											>
										{/if}
									</div>
								{/each}
								{#if axis.values.length < IMAGE_LIMITS.MAX_AXIS_VALUES}
									<button class="ghost sm" onclick={() => addValue(a)}>+ 값</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</section>

			<!-- ② 조합 -->
			<section class="block">
				<div class="block-head">
					<h3>② 조합 (행)</h3>
					{#if canAddEntry && entries.length < IMAGE_LIMITS.MAX_ENTRIES}
						<button class="ghost" onclick={addEntry}>+ 조합 추가</button>
					{/if}
				</div>

				{#if !canAddEntry}
					<p class="empty">먼저 축과 값을 1개 이상 만들어 주세요.</p>
				{:else if entries.length === 0}
					<p class="empty">조합을 추가하고 각 조합에 이미지를 올리세요.</p>
				{/if}

				<div class="entries">
					{#each entries as entry, i (entry.id)}
						{@const url = entryImageUrl(entry)}
						<div class="entry">
							<span class="code">{comboToCode(entry.combo)}</span>
							<div class="selects">
								{#each axes as axis, a (a)}
									<label class="sel">
										<span class="sel-label">{axis.label || `축 ${a + 1}`}</span>
										<select bind:value={entries[i].combo[a]}>
											{#each axis.values as val, vi (vi)}
												<option value={vi}>{val || letter(vi)}</option>
											{/each}
										</select>
									</label>
								{/each}
							</div>
							<label class="thumb" class:filled={!!url}>
								{#if url}
									<img src={url} alt="조합 미리보기" />
								{:else}
									<span class="thumb-empty">+ 이미지</span>
								{/if}
								<input
									type="file"
									accept="image/webp,image/avif"
									onchange={(e) => onEntryFileChange(i, e)}
								/>
							</label>
							<button class="del" onclick={() => removeEntry(i)} aria-label="조합 삭제">✕</button>
						</div>
					{/each}
				</div>
			</section>

			{#if error}<p class="error">{error}</p>{/if}

			<div class="foot">
				<button class="cancel" onclick={onclose}>취소</button>
				<button class="apply" onclick={apply}>완료</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(2px);
		display: grid;
		place-items: center;
		padding: 20px;
	}
	.modal {
		width: 100%;
		max-width: 720px;
		max-height: 90vh;
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 22px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.head h2 {
		margin: 0;
		font-size: 1.1rem;
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
	.intro {
		margin: 0 0 18px;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text-dim);
	}
	.intro strong {
		color: var(--text);
	}

	.block {
		margin-bottom: 22px;
	}
	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.block-head h3 {
		margin: 0;
		font-size: 0.92rem;
		font-weight: 700;
	}
	.empty {
		margin: 0 0 8px;
		font-size: 0.78rem;
		color: var(--text-faint);
	}

	.ghost {
		padding: 6px 12px;
		background: transparent;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 0.8rem;
		font-weight: 600;
	}
	.ghost:hover {
		border-color: var(--accent);
		color: var(--text);
	}
	.ghost.sm {
		padding: 4px 9px;
		font-size: 0.75rem;
	}

	/* 축 */
	.axes {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.axis {
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 11px;
	}
	.axis-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
	}
	.axis-pos {
		font-size: 0.68rem;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.axis-label {
		flex: 1;
		min-width: 0;
		font-weight: 600;
	}
	.values {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.value {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 8px 3px 4px;
	}
	.value input {
		width: 92px;
		background: transparent !important;
		border: none !important;
		padding: 2px 0 !important;
		font-size: 0.82rem;
	}
	.badge {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.72rem;
		font-weight: 700;
		flex-shrink: 0;
	}

	/* 조합 */
	.entries {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.entry {
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px;
	}
	.code {
		font-family: ui-monospace, monospace;
		font-weight: 800;
		color: var(--accent);
		font-size: 0.9rem;
		min-width: 42px;
		text-align: center;
		flex-shrink: 0;
	}
	.selects {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}
	.sel {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.sel-label {
		font-size: 0.66rem;
		color: var(--text-faint);
	}
	.sel select {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text);
		font-size: 0.82rem;
		padding: 6px 8px;
		outline: none;
	}
	.sel select:focus {
		border-color: var(--accent);
	}
	.thumb {
		position: relative;
		width: 56px;
		height: 56px;
		flex-shrink: 0;
		border: 1px dashed var(--border);
		border-radius: 10px;
		overflow: hidden;
		display: grid;
		place-items: center;
		cursor: pointer;
		background: var(--bg-card);
	}
	.thumb.filled {
		border-style: solid;
	}
	.thumb:hover {
		border-color: var(--accent);
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.thumb-empty {
		font-size: 0.66rem;
		color: var(--text-faint);
		text-align: center;
	}
	.thumb input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}

	.del {
		border: none;
		background: transparent;
		color: var(--text-faint);
		width: 24px;
		height: 24px;
		border-radius: 50%;
		flex-shrink: 0;
		font-size: 0.78rem;
	}
	.del.sm {
		width: 18px;
		height: 18px;
		font-size: 0.66rem;
	}
	.del:hover {
		background: var(--bg-card);
		color: var(--nsfw);
	}

	.error {
		margin: 0 0 12px;
		font-size: 0.82rem;
		color: var(--nsfw);
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 8px;
	}
	.cancel {
		padding: 10px 18px;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-weight: 600;
		font-size: 0.88rem;
	}
	.cancel:hover {
		color: var(--text);
	}
	.apply {
		padding: 10px 22px;
		background: var(--accent);
		border: none;
		border-radius: var(--radius-sm);
		color: #fff;
		font-weight: 700;
		font-size: 0.88rem;
	}
	.apply:hover {
		background: var(--accent-hover);
	}

	input[type='text'] {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 7px 10px;
		color: var(--text);
		font-size: 0.85rem;
		outline: none;
	}
	input[type='text']:focus {
		border-color: var(--accent);
	}
</style>
