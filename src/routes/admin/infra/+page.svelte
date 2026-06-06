<script lang="ts">
	import { num, bytes, dateTime, ago } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const infra = $derived(data.infra);
	const rows = $derived(data.rows);

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
