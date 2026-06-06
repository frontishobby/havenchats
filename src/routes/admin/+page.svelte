<script lang="ts">
	import { goto } from '$app/navigation';
	import { usd, num, date, ago } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// 일별 cost: 빈 날짜를 0 으로 채워 최근 N일을 연속 막대로. (KST 기준 날짜 문자열)
	const dayKey = (ms: number) =>
		new Intl.DateTimeFormat('en-CA', {
			timeZone: 'Asia/Seoul',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		}).format(new Date(ms));

	const trend = $derived.by(() => {
		const byDay = new Map(data.daily.map((d) => [d.day, d]));
		const out: { day: string; cost: number; messages: number }[] = [];
		const now = Date.now();
		for (let i = data.trendDays - 1; i >= 0; i--) {
			const key = dayKey(now - i * 86_400_000);
			const hit = byDay.get(key);
			out.push({ day: key, cost: hit?.cost ?? 0, messages: hit?.messages ?? 0 });
		}
		return out;
	});
	const trendMax = $derived(Math.max(...trend.map((d) => d.cost), 1e-9));

	function openUser(id: string) {
		goto(`/admin/users/${id}`);
	}
</script>

<!-- 요약 카드 -->
<section class="cards">
	<div class="card">
		<span class="k">총 유저</span>
		<span class="v">{num(data.summary.users)}</span>
		<span class="sub">활성 7일 {num(data.summary.active7d)} · 30일 {num(data.summary.active30d)}</span>
	</div>
	<div class="card">
		<span class="k">세션 / 메시지</span>
		<span class="v">{num(data.summary.sessions)}</span>
		<span class="sub">메시지 {num(data.summary.messages)}</span>
	</div>
	<div class="card">
		<span class="k">누적 비용</span>
		<span class="v">{usd(data.summary.costTotal, 2)}</span>
		<span class="sub">전체 기간</span>
	</div>
	<div class="card accent">
		<span class="k">최근 7일 비용</span>
		<span class="v">{usd(data.summary.cost7d, 2)}</span>
		<span class="sub">롤링 7일</span>
	</div>
</section>

<!-- 일별 비용 추이 -->
<section class="trend">
	<h2 class="section-label">일별 비용 (최근 {data.trendDays}일, KST)</h2>
	<div class="bars">
		{#each trend as d (d.day)}
			<div class="bar-col" title={`${d.day} · ${usd(d.cost, 4)} · ${num(d.messages)}msg`}>
				<div class="bar-track">
					<div class="bar-fill" style:height={`${(d.cost / trendMax) * 100}%`}></div>
				</div>
				<span class="bar-label">{d.day.slice(5)}</span>
			</div>
		{/each}
	</div>
</section>

<!-- 유저 목록 -->
<section>
	<h2 class="section-label">유저 {num(data.users.length)}명 (7일 비용순)</h2>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th class="l">이름</th>
					<th class="l">이메일</th>
					<th>가입일</th>
					<th>세션</th>
					<th>메시지</th>
					<th>7일 비용</th>
					<th>누적 비용</th>
					<th>마지막 활동</th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as u (u.id)}
					<tr onclick={() => openUser(u.id)}>
						<td class="l name">
						{u.name ?? '(미설정)'}
						{#if u.blocked}<span class="blocked-tag">차단</span>{/if}
					</td>
						<td class="l email">{u.email}</td>
						<td>{date(u.createdAt)}</td>
						<td>{num(u.sessions)}</td>
						<td>{num(u.messages)}</td>
						<td class="cost">{usd(u.cost7d)}</td>
						<td class="cost dim">{usd(u.costTotal)}</td>
						<td class="dim">{ago(u.lastActive)}</td>
					</tr>
				{/each}
				{#if data.users.length === 0}
					<tr><td colspan="8" class="empty">유저가 없어요.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
</section>

<style>
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 14px;
		margin-bottom: 28px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 16px 18px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.card.accent {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.card .k {
		font-size: 0.78rem;
		color: var(--text-dim);
		font-weight: 600;
	}
	.card .v {
		font-size: 1.6rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.card .sub {
		font-size: 0.74rem;
		color: var(--text-faint);
	}

	.section-label {
		margin: 0 0 12px;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text-dim);
	}

	.trend {
		margin-bottom: 32px;
	}
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		height: 120px;
		padding: 8px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.bar-col {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		height: 100%;
	}
	.bar-track {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: flex-end;
		justify-content: center;
	}
	.bar-fill {
		width: 70%;
		min-height: 2px;
		background: linear-gradient(180deg, var(--accent-hover), var(--accent));
		border-radius: 3px 3px 0 0;
		transition: height 0.2s ease;
	}
	.bar-label {
		font-size: 0.62rem;
		color: var(--text-faint);
		white-space: nowrap;
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.86rem;
	}
	thead th {
		padding: 11px 12px;
		text-align: right;
		font-size: 0.74rem;
		font-weight: 700;
		color: var(--text-dim);
		background: var(--bg-elev);
		white-space: nowrap;
	}
	th.l {
		text-align: left;
	}
	tbody td {
		padding: 11px 12px;
		text-align: right;
		border-top: 1px solid var(--border);
		white-space: nowrap;
	}
	td.l {
		text-align: left;
	}
	tbody tr {
		cursor: pointer;
		transition: background 0.12s ease;
	}
	tbody tr:hover {
		background: var(--bg-card-hover);
	}
	.name {
		font-weight: 600;
	}
	.blocked-tag {
		display: inline-block;
		margin-left: 6px;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 0.66rem;
		font-weight: 700;
		background: rgba(255, 92, 138, 0.16);
		color: var(--nsfw);
		vertical-align: middle;
	}
	.email {
		color: var(--text-dim);
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cost {
		font-variant-numeric: tabular-nums;
		color: var(--accent-hover);
		font-weight: 600;
	}
	.dim {
		color: var(--text-faint);
		font-weight: 400;
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 32px;
	}
</style>
