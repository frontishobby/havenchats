<script lang="ts" module>
	import { scrollLock } from '$lib/scrollLock';
	/** 플랫 네임드 이미지 편집용 드래프트 한 장. */
	export interface NamedDraft {
		id: string;
		/** 모델이 `<img="name">` 으로 출력하는 매칭 토큰. */
		name: string;
		/** 새 업로드(있으면). 없으면 기존 이미지 유지(ext 사용). */
		file: File | null;
		/** 기존 이미지 확장자(file 없을 때). */
		ext: string | null;
		/** 기존 이미지 URL(수정 시 미리보기). */
		url: string | null;
		/** 새 업로드 미리보기 objectURL. */
		previewUrl: string | null;
	}
	export interface NamedApply {
		images: NamedDraft[];
	}
</script>

<script lang="ts">
	import { NAMED_LIMITS } from '$lib/imageCodes';

	let {
		open,
		initial,
		onclose,
		onapply
	}: {
		open: boolean;
		initial: NamedDraft[];
		onclose: () => void;
		onapply: (res: NamedApply) => void;
	} = $props();

	const ACCEPT = ['image/webp', 'image/avif'];
	const MAX_BYTES = 3 * 1024 * 1024;

	let images = $state<NamedDraft[]>([]);
	let error = $state('');

	// open 될 때 initial 로 초기화.
	$effect(() => {
		if (open) {
			images = initial.map((d) => ({ ...d }));
			error = '';
		}
	});

	function uid(): string {
		return crypto.randomUUID().slice(0, 8);
	}

	function add() {
		if (images.length >= NAMED_LIMITS.MAX_IMAGES) return;
		images.push({ id: uid(), name: '', file: null, ext: null, url: null, previewUrl: null });
	}

	function remove(i: number) {
		const img = images[i];
		if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
		images.splice(i, 1);
	}

	function pickFile(i: number, e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (!ACCEPT.includes(file.type)) {
			error = '이미지는 webp 또는 avif 만 가능합니다.';
			return;
		}
		if (file.size > MAX_BYTES) {
			error = '이미지 용량이 너무 큽니다 (최대 3MB).';
			return;
		}
		const img = images[i];
		if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
		img.file = file;
		img.previewUrl = URL.createObjectURL(file);
		error = '';
	}

	function apply() {
		const cleaned = images
			.map((d) => ({ ...d, name: d.name.trim() }))
			.filter((d) => d.name || d.file || d.url);
		// 검증: 이름 필수·고유, 이미지 필수.
		const seen = new Set<string>();
		for (const d of cleaned) {
			if (!d.name) {
				error = '각 이미지에 이름(토큰)을 입력해 주세요.';
				return;
			}
			if (d.name.length > NAMED_LIMITS.NAME_MAX) {
				error = `이름은 ${NAMED_LIMITS.NAME_MAX}자 이내로 입력해 주세요.`;
				return;
			}
			if (seen.has(d.name)) {
				error = `이름이 중복됩니다: ${d.name}`;
				return;
			}
			seen.add(d.name);
			if (!d.file && !d.url) {
				error = `"${d.name}" 에 이미지를 추가해 주세요.`;
				return;
			}
		}
		onapply({ images: cleaned });
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="overlay" use:scrollLock onclick={onclose} role="presentation">
		<div
			class="modal"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
		>
			<header>
				<h2>장면 이미지 (플랫)</h2>
				<button class="x" onclick={onclose} aria-label="닫기">✕</button>
			</header>

			<p class="desc">
				이미지마다 <b>이름(토큰)</b>을 정해요. AI 가 본문에 <code>&lt;img="이름"&gt;</code> 를 출력하면 그
				이미지가 표시돼요.
			</p>

			{#if error}<p class="error">{error}</p>{/if}

			<div class="list">
				{#each images as img, i (img.id)}
					<div class="row">
						<label class="thumb">
							{#if img.previewUrl || img.url}
								<img src={img.previewUrl ?? img.url} alt={img.name} />
							{:else}
								<span class="plus">＋</span>
							{/if}
							<input type="file" accept="image/webp,image/avif" onchange={(e) => pickFile(i, e)} hidden />
						</label>
						<input class="name" placeholder="이름 (예: smile, angry_home)" bind:value={images[i].name} />
						<button class="del" onclick={() => remove(i)} aria-label="삭제">✕</button>
					</div>
				{/each}
			</div>

			{#if images.length < NAMED_LIMITS.MAX_IMAGES}
				<button class="add" onclick={add}>＋ 이미지 추가</button>
			{/if}

			<footer>
				<button class="ghost" onclick={onclose}>취소</button>
				<button class="primary" onclick={apply}>적용 ({images.length}장)</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: grid;
		place-items: center;
		z-index: 100;
		padding: 16px;
	}
	.modal {
		width: 100%;
		max-width: 560px;
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	header h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 800;
	}
	.x {
		background: transparent;
		border: none;
		color: var(--text-dim);
		font-size: 1rem;
	}
	.desc {
		margin: 0 0 14px;
		font-size: 0.82rem;
		color: var(--text-dim);
		line-height: 1.5;
	}
	.desc code {
		background: var(--bg-elev);
		padding: 1px 5px;
		border-radius: 4px;
		font-size: 0.8rem;
	}
	.error {
		background: rgba(255, 92, 92, 0.12);
		border: 1px solid rgba(255, 92, 92, 0.4);
		color: #ff8a8a;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.84rem;
		margin-bottom: 12px;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.thumb {
		width: 48px;
		height: 48px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		overflow: hidden;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.thumb .plus {
		color: var(--accent);
		font-size: 1.2rem;
	}
	.name {
		flex: 1;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
		padding: 8px 10px;
		font-size: 0.88rem;
	}
	.del {
		background: transparent;
		border: none;
		color: var(--text-faint);
		font-size: 0.9rem;
	}
	.del:hover {
		color: #ff8a8a;
	}
	.add {
		margin-top: 12px;
		width: 100%;
		padding: 10px;
		background: var(--bg-elev);
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 0.86rem;
		cursor: pointer;
	}
	.add:hover {
		color: var(--text);
		border-color: var(--accent);
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 18px;
	}
	footer button {
		padding: 8px 18px;
		border-radius: var(--radius-sm);
		font-weight: 700;
		font-size: 0.86rem;
		cursor: pointer;
	}
	.ghost {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-dim);
	}
	.primary {
		background: var(--accent);
		border: none;
		color: #fff;
	}

	/* 모바일: 여백을 줄여 폭·높이를 더 쓴다 */
	@media (max-width: 640px) {
		.overlay {
			padding: 10px;
		}
		.modal {
			padding: 16px 14px;
			max-height: calc(100dvh - 20px);
			border-radius: 14px;
		}
	}
</style>
