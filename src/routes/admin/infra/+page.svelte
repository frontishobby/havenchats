<script lang="ts">
	import { num, bytes, dateTime, ago, usd } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const infra = $derived(data.infra);
	const rows = $derived(data.rows);
	const billing = $derived(data.billing);

	/** 큰 수 압축 표기(1.2K / 3.4M / 25B). */
	function compact(n: number): string {
		if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
		return num(Math.round(n));
	}

	/** 청구 항목 사용량 표기: 'gb' 는 GB, 'ms' 는 CPU-ms, 'count' 는 압축 수. */
	function usageText(item: { monthly: number | null; unit: 'gb' | 'count' | 'ms' }): string {
		if (item.monthly == null) return '—';
		if (item.unit === 'gb') return `${item.monthly.toFixed(item.monthly >= 10 ? 1 : 3)} GB`;
		if (item.unit === 'ms') return `${compact(item.monthly)} ms`;
		return compact(item.monthly);
	}

	function freeText(item: { unit: 'gb' | 'count' | 'ms'; free: number }): string {
		if (item.free <= 0) return '—';
		if (item.unit === 'gb') return `${item.free} GB`;
		if (item.unit === 'ms') return `${compact(item.free)} ms`;
		return compact(item.free);
	}

	// 테이블 라벨(스키마 대응).
	const TABLE_LABELS: Record<string, string> = {
		users: '유저',
		oauth_accounts: 'OAuth 계정',
		characters: '캐릭터',
		chat_sessions: '세션',
		chat_messages: '메시지'
	};

	const totalRows = $derived(rows.reduce((a, r) => a + r.rows, 0));

	// R2 저장 용량 = payload + metadata.
	const r2Total = $derived(
		infra.r2.storage ? infra.r2.storage.payloadSize + infra.r2.storage.metadataSize : null
	);

	// 배포 상태 → 색상 클래스.
	function statusClass(s: string): string {
		if (s === 'success') return 'ok';
		if (s === 'failure' || s === 'canceled') return 'bad';
		return 'pending';
	}
</script>

{#if !infra.configured}
	<div class="notice">
		Cloudflare 지표를 보려면 <code>CLOUDFLARE_API_TOKEN</code> ·
		<code>CLOUDFLARE_ACCOUNT_ID</code> 가 설정돼야 해요. (prod 는 Pages secret)
	</div>
{/if}

<!-- 청구 예상 (사용량 기반) -->
{#if billing.available}
	<section>
		<h2 class="section-label">월 청구 예상 (사용량 기반)</h2>
		<div class="bill-top">
			<div class="bill-total">
				<span class="bt-k">총 예상액 · 월</span>
				<span class="bt-v">{usd(billing.monthlyTotal, 2)}</span>
			</div>
			<div class="bill-by-svc">
				{#each billing.services as s (s.key)}
					<div class="svc-chip">
						<span class="sc-k">{s.label}</span>
						<span class="sc-v">{usd(s.subtotal, 2)}</span>
					</div>
				{/each}
			</div>
		</div>

		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th class="l">서비스</th>
						<th class="l">항목</th>
						<th>추정 사용량</th>
						<th>무료 허용</th>
						<th>예상액</th>
					</tr>
				</thead>
				<tbody>
					{#each billing.services as s (s.key)}
						{#each s.items as item, i (s.key + item.name)}
							<tr class:svc-start={i === 0}>
								<td class="l name">{i === 0 ? s.label : ''}</td>
								<td class="l">
									{item.name}
									{#if item.projected}<span class="raw"> · 7일 환산</span>{/if}
								</td>
								<td class:dim={!item.available}>
									{item.available ? usageText(item) : '지표 없음'}
								</td>
								<td class="dim">{freeText(item)}</td>
								<td class="cost" class:zero={item.cost === 0}>{usd(item.cost, 2)}</td>
							</tr>
						{/each}
						<tr class="svc-subtotal">
							<td class="l"></td>
							<td class="l" colspan="3">{s.label} 소계</td>
							<td class="cost">{usd(s.subtotal, 2)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="dim-note">
			공개 Workers 유료 플랜 가격표 기준 <strong>추정치</strong>예요. 저장량은 현재 스냅샷, 쿼리·작업은
			최근 7일을 월(×30/7)로 환산했어요. 정확한 청구는 Cloudflare 대시보드 기준.
		</p>
	</section>
{/if}

<!-- Workers / Pages Functions -->
<section>
	<h2 class="section-label">Workers · Pages Functions — 최근 7일</h2>
	{#if infra.workers.last7d}
		<div class="cards">
			<div class="card">
				<span class="k">요청 수</span>
				<span class="v">{num(infra.workers.last7d.requests)}</span>
			</div>
			<div class="card">
				<span class="k">오류</span>
				<span class="v">{num(infra.workers.last7d.errors)}</span>
			</div>
			<div class="card">
				<span class="k">CPU 시간 (추정)</span>
				<span class="v">{compact(infra.workers.last7d.cpuMsEst)} ms</span>
			</div>
		</div>
		<p class="dim-note">
			CPU 시간은 데이터셋에 합계가 없어 <strong>요청수 × 일별 CPU 중앙값(P50)</strong>으로 근사한
			값이에요. 정적 에셋 서빙은 과금 대상이 아니라 여기 안 잡혀요.
		</p>
	{:else}
		<p class="dim-note">Workers 지표 없음 — 토큰에 Account Analytics:Read 권한이 필요해요.</p>
	{/if}
</section>

<!-- D1 -->
<section>
	<h2 class="section-label">D1 · haven</h2>
	<div class="cards">
		<div class="card">
			<span class="k">DB 크기</span>
			<span class="v">{bytes(infra.d1.sizeBytes)}</span>
		</div>
		<div class="card">
			<span class="k">테이블</span>
			<span class="v">{infra.d1.tableCount ?? rows.length}</span>
		</div>
		<div class="card">
			<span class="k">총 행 수</span>
			<span class="v">{num(totalRows)}</span>
		</div>
	</div>

	<div class="table-wrap">
		<table>
			<thead>
				<tr><th class="l">테이블</th><th>행 수</th></tr>
			</thead>
			<tbody>
				{#each rows as r (r.table)}
					<tr>
						<td class="l name">{TABLE_LABELS[r.table] ?? r.table}<span class="raw"> · {r.table}</span></td>
						<td>{num(r.rows)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<h3 class="sub-label">최근 7일 쿼리 (Analytics)</h3>
	{#if infra.d1.last7d}
		<div class="cards">
			<div class="card">
				<span class="k">읽기 쿼리</span>
				<span class="v">{num(infra.d1.last7d.readQueries)}</span>
			</div>
			<div class="card">
				<span class="k">쓰기 쿼리</span>
				<span class="v">{num(infra.d1.last7d.writeQueries)}</span>
			</div>
			<div class="card">
				<span class="k">읽은 행</span>
				<span class="v">{num(infra.d1.last7d.rowsRead)}</span>
			</div>
			<div class="card">
				<span class="k">쓴 행</span>
				<span class="v">{num(infra.d1.last7d.rowsWritten)}</span>
			</div>
		</div>
	{:else}
		<p class="dim-note">쿼리 지표 없음 — 토큰에 Account Analytics:Read 권한이 필요해요.</p>
	{/if}
</section>

<!-- R2 -->
<section>
	<h2 class="section-label">R2 · haven-images</h2>
	{#if infra.r2.storage}
		<div class="cards">
			<div class="card">
				<span class="k">저장 용량</span>
				<span class="v">{bytes(r2Total)}</span>
			</div>
			<div class="card">
				<span class="k">객체 수</span>
				<span class="v">{num(infra.r2.storage.objectCount)}</span>
			</div>
			<div class="card">
				<span class="k">메타데이터</span>
				<span class="v">{bytes(infra.r2.storage.metadataSize)}</span>
			</div>
		</div>
	{:else}
		<p class="dim-note">저장 스냅샷 없음 — 토큰 권한(Analytics:Read) 또는 데이터 부족.</p>
	{/if}

	<h3 class="sub-label">최근 7일 작업 (과금 클래스)</h3>
	{#if infra.r2.ops}
		<div class="cards">
			<div class="card">
				<span class="k">Class A (쓰기·목록)</span>
				<span class="v">{num(infra.r2.classA)}</span>
			</div>
			<div class="card">
				<span class="k">Class B (읽기)</span>
				<span class="v">{num(infra.r2.classB)}</span>
			</div>
		</div>
		{#if infra.r2.ops.length}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th class="l">작업</th><th>클래스</th><th>요청 수</th></tr>
					</thead>
					<tbody>
						{#each infra.r2.ops as op (op.action)}
							<tr>
								<td class="l name">{op.action}</td>
								<td><span class="badge {op.class}">{op.class === 'free' ? '무료' : op.class}</span></td>
								<td>{num(op.requests)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else}
		<p class="dim-note">작업 지표 없음 — 토큰 권한 또는 데이터 부족.</p>
	{/if}
</section>

<!-- Pages -->
<section>
	<h2 class="section-label">Pages · havenchats — 최근 배포</h2>
	{#if infra.pages}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th class="l">배포</th>
						<th class="l">환경</th>
						<th class="l">상태</th>
						<th class="l">브랜치</th>
						<th>생성</th>
					</tr>
				</thead>
				<tbody>
					{#each infra.pages as d (d.shortId + d.createdAt)}
						<tr>
							<td class="l name">
								{#if d.url}
									<a href={d.url} target="_blank" rel="noreferrer">{d.shortId}</a>
								{:else}
									{d.shortId}
								{/if}
							</td>
							<td class="l">
								<span class="env" class:prod={d.environment === 'production'}>{d.environment}</span>
							</td>
							<td class="l">
								<span class="status {statusClass(d.status)}">{d.status}</span>
								<span class="raw"> · {d.stage}</span>
							</td>
							<td class="l dim">{d.branch ?? '—'}</td>
							<td title={dateTime(d.createdAt)}>{ago(d.createdAt)}</td>
						</tr>
					{/each}
					{#if infra.pages.length === 0}
						<tr><td colspan="5" class="empty">배포 기록이 없어요.</td></tr>
					{/if}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="dim-note">배포 목록 없음 — 토큰에 Pages:Read 권한이 필요해요.</p>
	{/if}
</section>

<style>
	section {
		margin-bottom: 36px;
	}
	.section-label {
		margin: 0 0 14px;
		font-size: 0.92rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.sub-label {
		margin: 22px 0 12px;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text-dim);
	}
	.notice {
		padding: 14px 16px;
		margin-bottom: 24px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.86rem;
		color: var(--text-dim);
		line-height: 1.6;
	}
	.notice code {
		font-size: 0.82em;
		padding: 1px 5px;
		background: var(--bg-elev);
		border-radius: 4px;
		color: var(--text);
	}

	.bill-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 16px;
		margin-bottom: 16px;
		padding: 16px 18px;
		background: var(--bg-card);
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
	}
	.bill-total {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.bt-k {
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--text-dim);
	}
	.bt-v {
		font-size: 2.2rem;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--accent-hover);
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.bill-by-svc {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.svc-chip {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		padding: 8px 14px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.sc-k {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-dim);
	}
	.sc-v {
		font-size: 1.1rem;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}

	.svc-start td {
		border-top-width: 2px;
	}
	.svc-subtotal td {
		border-top: 1px dashed var(--border);
		color: var(--text-dim);
		font-weight: 600;
		font-size: 0.82rem;
	}
	.cost {
		color: var(--accent-hover);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.cost.zero {
		color: var(--text-faint);
		font-weight: 400;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 14px 16px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.card .k {
		font-size: 0.74rem;
		font-weight: 600;
		color: var(--text-dim);
	}
	.card .v {
		font-size: 1.5rem;
		font-weight: 800;
		letter-spacing: -0.01em;
		color: var(--text);
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
	.raw {
		color: var(--text-faint);
		font-weight: 400;
		font-size: 0.86em;
	}
	.dim {
		color: var(--text-faint);
		font-weight: 400;
	}
	.dim-note {
		margin: 4px 2px 0;
		font-size: 0.8rem;
		color: var(--text-faint);
	}
	.empty {
		text-align: center;
		color: var(--text-faint);
		padding: 32px;
	}

	.badge {
		display: inline-block;
		min-width: 20px;
		text-align: center;
		padding: 1px 7px;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
		background: var(--bg-elev);
		color: var(--text-dim);
	}
	.badge.A {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent-hover);
	}
	.badge.B {
		background: color-mix(in srgb, #59b 18%, transparent);
		color: #8ac;
	}

	.env {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
		background: var(--bg-elev);
		color: var(--text-dim);
	}
	.env.prod {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent-hover);
	}
	.status {
		font-weight: 700;
		font-size: 0.82rem;
	}
	.status.ok {
		color: #4caf7d;
	}
	.status.bad {
		color: var(--nsfw);
	}
	.status.pending {
		color: var(--text-dim);
	}
</style>
