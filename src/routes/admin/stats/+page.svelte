<script lang="ts">
	import { goto } from '$app/navigation';
	import { getModel } from '$lib/data/models';
	import { usd, num } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function modelLabel(id: string | null): string {
		if (!id) return '(미기록)';
		return getModel(id)?.label ?? id;
	}

	function intOrDash(n: number | null): string {
		return n == null ? '—' : num(Math.round(n));
	}
</script>

<!-- 모델별 통계 -->
<section>
	<h2 class="section-label">모델별 비용 (cost 기록된 응답 기준)</h2>
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
	<h2 class="section-label">캐릭터별 사용량 Top 20 (비용순)</h2>
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
