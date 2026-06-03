<script lang="ts">
	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onclose} role="presentation">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="프롬프트 작성 가이드"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<button class="close" onclick={onclose} aria-label="닫기">✕</button>

			<header class="g-head">
				<span class="g-logo">✦</span>
				<h2>프롬프트 작성 가이드</h2>
				<p>캐릭터의 역할·말투·세계관·출력 형식까지, 프롬프트에 자유롭게 적을 수 있어요.</p>
			</header>

			<div class="g-body">
				<section>
					<h3>1. 무엇을 적나요</h3>
					<p>
						프롬프트가 곧 <strong>시스템 프롬프트</strong>가 됩니다. 캐릭터의 역할 선언(캐릭터 연기·내레이터·시뮬레이션
						등), 성격·말투·세계관·관계, 그리고 출력 형식까지 모두 여기에 직접 작성해요.
					</p>
					<p class="muted">
						상대(사용자) 정보와 안전 가드레일은 서버가 자동으로 덧붙이니 따로 적지 않아도 돼요.
					</p>
				</section>

				<section class="highlight">
					<h3>2. <code>{'{{나}}'}</code> — 사용자 가리키기</h3>
					<p>
						프롬프트나 첫 상황에 <code>{'{{나}}'}</code> 라고 쓰면, <strong
							>이 서비스를 사용하는 상대(사용자)</strong
						>를 가리켜요. 대화 중에는 사용자의 이름으로 자동 치환됩니다.
					</p>
					<pre>예) {'{{나}}'}는 방금 교실 문을 열고 들어왔다. 너는 {'{{나}}'}를 보고 살짝 미소짓는다.</pre>
				</section>

				<section>
					<h3>3. 출력 형식 (소설 모드)</h3>
					<p>이 서비스는 말풍선이 아닌 <strong>소설 형식(산문)</strong>으로 보여줘요. 예시:</p>
					<ul>
						<li>대사는 <code>이름 | "대사"</code> 형식으로 쓰면 이름이 강조돼요.</li>
						<li>행동·서술·지시문은 <code>( )</code> 또는 <code>*…*</code> 로 감싸면 기울임으로 보여요.</li>
						<li>
							상태창·정보 같은 건 <code>{'```{제목}'}</code> … <code>{'```'}</code> 로 감싸면
							<strong>제목이 달린 박스</strong>로 보여요.
						</li>
					</ul>
					<pre>[출력 형식] 소설 형식으로 서술한다. 대사는 '이름 | "대사"' 형식으로 쓴다.</pre>
				</section>

				<section>
					<h3>4. 상태창·정보 블록</h3>
					<p>
						백틱 3개 + <code>{'{제목}'}</code> 로 시작해 백틱 3개로 닫으면, 그 사이 내용이
						<strong>제목이 달린 박스</strong>로 표시돼요. 상태창·스탯·인벤토리·시스템 안내 등에 어울려요.
						(줄바꿈은 그대로 유지돼요.)
					</p>
					<pre>{'```{상태창}'}
체력 80 / 100   호감도 ★★★☆☆
소지금 1,200원
{'```'}</pre>
					<p class="muted">제목을 빼고 백틱 3개만 써도 박스로 보여요(제목 없는 박스).</p>
				</section>

				<section>
					<h3>5. 첫 상황(오프닝)</h3>
					<p>
						채팅을 시작할 때 캐릭터가 건네는 <strong>첫 메시지</strong>예요. 프롬프트의 출력 형식과 같은
						톤으로 첫 장면·대사를 적어주세요. 여러 개 추가하면 사용자가 골라 시작할 수 있어요.
					</p>
				</section>

				<section>
					<h3>6. 작성 팁</h3>
					<ul>
						<li>핵심 설정은 짧고 명확하게 — 모순되는 지시는 피해요.</li>
						<li>금지·필수 규칙은 따로 묶어 적으면 잘 지켜져요.</li>
						<li>성인(NSFW) 콘텐츠라면 연령제한을 켜고, 등장인물이 성인임을 명시해요.</li>
					</ul>
				</section>
			</div>

			<button class="g-done" onclick={onclose}>확인</button>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 120;
		background: rgba(0, 0, 0, 0.65);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 20px;
		overflow-y: auto;
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 540px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 24px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
		max-height: calc(100vh - 40px);
		display: flex;
		flex-direction: column;
	}
	.close {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.95rem;
		z-index: 1;
	}
	.close:hover {
		background: var(--bg-elev);
		color: var(--text);
	}

	.g-head {
		text-align: center;
		margin-bottom: 18px;
		flex-shrink: 0;
	}
	.g-logo {
		color: var(--accent);
		font-size: 1.6rem;
	}
	.g-head h2 {
		margin: 6px 0 6px;
		font-size: 1.25rem;
		font-weight: 800;
	}
	.g-head p {
		margin: 0 auto;
		max-width: 420px;
		font-size: 0.85rem;
		color: var(--text-dim);
		line-height: 1.6;
	}

	.g-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		margin-bottom: 18px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	section {
		border-top: 1px solid var(--border);
		padding-top: 14px;
	}
	section:first-child {
		border-top: none;
		padding-top: 0;
	}
	section.highlight {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		padding: 14px;
	}
	h3 {
		margin: 0 0 8px;
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--text);
	}
	h3 code {
		font-size: 0.9rem;
	}
	p {
		margin: 0 0 8px;
		font-size: 0.86rem;
		line-height: 1.65;
		color: var(--text-dim);
	}
	p:last-child {
		margin-bottom: 0;
	}
	p.muted {
		color: var(--text-faint);
		font-size: 0.8rem;
	}
	strong {
		color: var(--text);
	}
	ul {
		margin: 0 0 8px;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	li {
		font-size: 0.85rem;
		line-height: 1.55;
		color: var(--text-dim);
	}
	code {
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 1px 5px;
		font-size: 0.82rem;
		color: var(--text);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	pre {
		margin: 8px 0 0;
		padding: 10px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.78rem;
		line-height: 1.55;
		color: var(--text-dim);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.g-done {
		flex-shrink: 0;
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
	.g-done:hover {
		background: var(--accent-hover);
	}
</style>
