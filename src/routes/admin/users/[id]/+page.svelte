<script lang="ts">
	import { usd, num, dateTime, ago } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 펼친 프롬프트 캐릭터 id 집합.
	let openIds = $state<Set<string>>(new Set());
	function toggle(id: string) {
		const next = new Set(openIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		openIds = next;
	}

	const prefLabel = (p: string | null) =>
		p === 'male' ? '남성향' : p === 'female' ? '여성향' : '—';
</script>

<a class="back" href="/admin">← 유저 목록</a>

<!-- 프로필 헤더 -->
<header class="head">
	<div class="avatar">{(data.detail.name ?? data.detail.email).charAt(0).toUpperCase()}</div>
	<div class="who">
		<h2>{data.detail.name ?? '(이름 미설정)'}</h2>
		<p class="email">{data.detail.email}</p>
		<p class="meta">
			가입 {dateTime(data.detail.createdAt)} · 취향 {prefLabel(data.detail.preference)} · 성인인증
			{data.detail.ageVerified ? '✓' : '✗'}
		</p>
	</div>
	<a class="pub-link" href={`/user/${data.detail.id}`}>공개 프로필 ↗</a>
</header>

{#if data.detail.persona}
	<div class="persona">
		<span class="persona-k">페르소나</span>
		<p>{data.detail.persona}</p>
	</div>
{/if}

<!-- 사용량 카드 -->
<section class="cards">
	<div class="card"><span class="k">세션</span><span class="v">{num(data.stats.sessions)}</span></div>
	<div class="card"><span class="k">메시지</span><span class="v">{num(data.stats.messages)}</span></div>
	<div class="card"><span class="k">7일 비용</span><span class="v accent-v">{usd(data.stats.cost7d)}</span></div>
	<div class="card"><span class="k">누적 비용</span><span class="v">{usd(data.stats.costTotal)}</span></div>
	<div class="card"><span class="k">마지막 활동</span><span class="v small">{ago(data.stats.lastActive)}</span></div>
</section>

<!-- 캐릭터 목록 (공개+비공개+imported, 프롬프트 Read) -->
<section>
	<h3 class="section-label">제작 캐릭터 {num(data.characters.length)}개 (공개·비공개 전체)</h3>
	{#if data.characters.length === 0}
		<p class="empty">만든 캐릭터가 없어요.</p>
	{:else}
		<ul class="list">
			{#each data.characters as c (c.id)}
				<li class="char">
					<div class="char-head">
						<span class="char-name">{c.name}</span>
						<span class="badge" class:priv={c.visibility === 'private'}>
							{c.visibility === 'private' ? '비공개' : '공개'}
						</span>
						{#if c.contentRating === 'nsfw'}<span class="badge nsfw">NSFW</span>{/if}
						{#if c.imported}<span class="badge imp">charx</span>{/if}
						<span class="char-meta">💬 {num(c.chats)} · {dateTime(c.createdAt)}</span>
						<button class="read-btn" type="button" onclick={() => toggle(c.id)}>
							{openIds.has(c.id) ? '프롬프트 접기' : '프롬프트 보기'}
						</button>
					</div>
					{#if c.tagline}<p class="char-tagline">{c.tagline}</p>{/if}

					{#if openIds.has(c.id)}
						<div class="prompt-box">
							{#if c.intro}
								<span class="field-k">소개(intro · 프롬프트 미반영)</span>
								<pre class="prompt">{c.intro}</pre>
							{/if}
							<span class="field-k">시스템 프롬프트(description)</span>
							<pre class="prompt">{c.description || '(비어 있음)'}</pre>
							{#if c.openings.length > 0}
								<span class="field-k">오프닝 {c.openings.length}개</span>
								{#each c.openings as o, i (i)}
									<pre class="prompt opening">{o.name ? `[${o.name}]\n` : ''}{o.content}</pre>
								{/each}
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.back {
		display: inline-block;
		color: var(--text-dim);
		font-size: 0.88rem;
		margin-bottom: 18px;
	}
	.back:hover {
		color: var(--text);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 18px;
	}
	.avatar {
		width: 56px;
		height: 56px;
		flex-shrink: 0;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 1.5rem;
		font-weight: 700;
		color: #fff;
		background: linear-gradient(135deg, var(--accent), var(--nsfw));
	}
	.who {
		flex: 1;
		min-width: 0;
	}
	.who h2 {
		margin: 0 0 2px;
		font-size: 1.3rem;
		font-weight: 800;
	}
	.email {
		margin: 0 0 4px;
		color: var(--text-dim);
		font-size: 0.9rem;
	}
	.meta {
		margin: 0;
		color: var(--text-faint);
		font-size: 0.78rem;
	}
	.pub-link {
		flex-shrink: 0;
		color: var(--accent);
		font-size: 0.84rem;
		font-weight: 600;
	}
	.pub-link:hover {
		color: var(--accent-hover);
	}

	.persona {
		margin-bottom: 18px;
		padding: 12px 14px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.persona-k {
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--text-dim);
	}
	.persona p {
		margin: 4px 0 0;
		font-size: 0.86rem;
		white-space: pre-wrap;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 12px;
		margin-bottom: 28px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 14px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.card .k {
		font-size: 0.74rem;
		color: var(--text-dim);
		font-weight: 600;
	}
	.card .v {
		font-size: 1.3rem;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}
	.card .v.small {
		font-size: 0.95rem;
	}
	.accent-v {
		color: var(--accent-hover);
	}

	.section-label {
		margin: 0 0 12px;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text-dim);
	}
	.empty {
		color: var(--text-faint);
		font-size: 0.9rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.char {
		padding: 14px 16px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.char-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.char-name {
		font-weight: 700;
		font-size: 0.98rem;
	}
	.badge {
		font-size: 0.68rem;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-hover);
	}
	.badge.priv {
		background: rgba(154, 154, 176, 0.18);
		color: var(--text-dim);
	}
	.badge.nsfw {
		background: rgba(255, 92, 138, 0.16);
		color: var(--nsfw);
	}
	.badge.imp {
		background: rgba(76, 201, 240, 0.16);
		color: #4cc9f0;
	}
	.char-meta {
		font-size: 0.72rem;
		color: var(--text-faint);
		margin-left: 2px;
	}
	.read-btn {
		margin-left: auto;
		padding: 4px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--accent);
		font-size: 0.78rem;
		font-weight: 600;
		transition: background 0.15s ease;
	}
	.read-btn:hover {
		background: var(--accent-soft);
	}
	.char-tagline {
		margin: 6px 0 0;
		font-size: 0.82rem;
		color: var(--text-dim);
	}

	.prompt-box {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field-k {
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--text-dim);
		margin-top: 6px;
	}
	.prompt {
		margin: 0;
		padding: 10px 12px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		max-height: 420px;
		overflow-y: auto;
	}
	.prompt.opening {
		background: var(--bg-elev);
	}
</style>
