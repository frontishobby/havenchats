<script lang="ts">
	import { goto } from '$app/navigation';
	import { getModel } from '$lib/data/models';
	import { usd, num } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const PERIODS: { key: string; label: string }[] = [
		{ key: '1d', label: '1일' },
		{ key: '7d', label: '7일' },
		{ key: '30d', label: '30일' },
		{ key: 'all', label: '전체' }
	];
	const periodLabel = $derived(PERIODS.find((p) => p.key === data.period)?.label ?? '1일');

	function selectPeriod(key: string) {
		if (key === data.period) return;
		// keepFocus/noScroll 로 탭 전환처럼 자연스럽게. ?period= 만 갱신 → 서버 load 재실행.
		goto(key === '1d' ? '/admin/stats' : `/admin/stats?period=${key}`, {
			keepFocus: true,
			noScroll: true
		});
	}

	function modelLabel(id: string | null): string {
		if (!id) return '(미기록)';
		return getModel(id)?.label ?? id;
	}

	function intOrDash(n: number | null): string {
		return n == null ? '—' : num(Math.round(n));
	}

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
</script>

<!-- 기간 선택 + 총 사용액 -->
<section class="period-bar">
	<div class="seg">
		{#each PERIODS as p (p.key)}
			<button
				class="seg-btn"
				class:active={data.period === p.key}
				type="button"
				onclick={() => selectPeriod(p.key)}
			>
				{p.label}
			</button>
		{/each}
	</div>
	<div class="total">
		<span class="total-k">총 사용액 · {periodLabel}</span>
		<span class="total-v">{usd(data.totalSpend, 2)}</span>
	</div>
</section>

<!-- 일별 비용 추이 (기간 선택과 무관, 최근 14일 고정) -->
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

<!-- 모델별 통계 -->
<section>
	<h2 class="section-label">모델별 비용 · {periodLabel} (cost 기록된 응답 기준)</h2>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th class="l">모델</th>
					<th>응답 수</th>
					<th>총 비용</th>
					<th>평균</th>
					<th>최소</th>
					<th>최대</th>
					<th>총 input 토큰</th>
					<th>평균 input</th>
				</tr>
			</thead>
			<tbody>
				{#each data.models as m (m.model ?? '∅')}
					<tr>
						<td class="l name">{modelLabel(m.model)}</td>
						<td>{num(m.messages)}</td>
						<td class="cost">{usd(m.costSum, 4)}</td>
						<td class="cost dim">{usd(m.costAvg, 6)}</td>
						<td class="dim">{usd(m.costMin, 6)}</td>
						<td class="dim">{usd(m.costMax, 6)}</td>
						<td class="dim">{num(m.inTokSum)}</td>
						<td class="dim">{intOrDash(m.inTokAvg)}</td>
					</tr>
				{/each}
				{#if data.models.length === 0}
					<tr><td colspan="8" class="empty">비용이 기록된 응답이 아직 없어요.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
	<p class="note">
		비용은 AI Gateway 실측(USD)이며 assistant 응답 단위로 집계돼요. mock 폴백·구버전 응답은
		비용이 없어 제외됩니다.
	</p>
</section>

<!-- 캐릭터별 통계 -->
<section>
	<h2 class="section-label">캐릭터별 사용량 · {periodLabel} Top 20 (비용순)</h2>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th class="l">캐릭터</th>
					<th>세션</th>
					<th>메시지</th>
					<th>총 비용</th>
				</tr>
			</thead>
			<tbody>
				{#each data.characters as c (c.characterId)}
					<tr>
						<td class="l name">
							{#if c.name}
								<a href={`/chat/${c.characterId}`}>{c.name}</a>
							{:else}
								<span class="gone">(삭제/외부 · {c.characterId.slice(0, 8)}…)</span>
							{/if}
						</td>
						<td>{num(c.sessions)}</td>
						<td>{num(c.messages)}</td>
						<td class="cost">{usd(c.cost, 4)}</td>
					</tr>
				{/each}
				{#if data.characters.length === 0}
					<tr><td colspan="4" class="empty">데이터가 없어요.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
</section>

<style>
	.section-label {
		margin: 0 0 12px;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text-dim);
	}
	section {
		margin-bottom: 32px;
	}

	.period-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 16px;
		margin-bottom: 28px;
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
	.seg {
		display: inline-flex;
		padding: 3px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.seg-btn {
		padding: 7px 16px;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--text-dim);
		font-size: 0.86rem;
		font-weight: 600;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.seg-btn:hover {
		color: var(--text);
	}
	.seg-btn.active {
		background: var(--accent);
		color: #fff;
	}
	.total {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
	}
	.total-k {
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--text-dim);
	}
	.total-v {
		font-size: 2.2rem;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--accent-hover);
		font-variant-numeric: tabular-nums;
		line-height: 1;
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
		font-variant-numeric: tabular-nums;
	}
	td.l {
		text-align: left;
	}
	.name {
		font-weight: 600;
	}
	.name a:hover {
		color: var(--accent-hover);
		text-decoration: underline;
	}
	.gone {
		color: var(--text-faint);
		font-weight: 400;
	}
	.cost {
		color: var(--accent-hover);
		font-weight: 600;
	}
	.dim {
		color: var(--text-faint);
		font-weight: 400;
	}
	.note {
		margin: 10px 2px 0;
		font-size: 0.74rem;
		color: var(--text-faint);
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 32px;
	}
</style>
