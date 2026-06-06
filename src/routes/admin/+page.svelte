<script lang="ts">
	import { goto } from '$app/navigation';
	import { num, date, ago } from '$lib/adminFormat';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state('');

	// 이름/이메일 부분일치(대소문자 무시). 공백 입력은 전체.
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return data.users;
		return data.users.filter(
			(u) => (u.name ?? '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
		);
	});

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
</section>

<!-- 유저 목록 -->
<section>
	<div class="list-head">
		<h2 class="section-label">유저 {num(filtered.length)}명{query.trim() ? ` / 전체 ${num(data.users.length)}` : ''}</h2>
		<input
			class="search"
			type="search"
			bind:value={query}
			placeholder="이름·이메일 검색"
			autocomplete="off"
			spellcheck="false"
		/>
	</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th class="l">이름</th>
					<th class="l">이메일</th>
					<th>가입일</th>
					<th>세션</th>
					<th>메시지</th>
					<th>마지막 활동</th>
				</tr>
			</thead>
			<tbody>
				{#each filtered as u (u.id)}
					<tr onclick={() => openUser(u.id)}>
						<td class="l name">
						{u.name ?? '(미설정)'}
						{#if u.blocked}<span class="blocked-tag">차단</span>{/if}
					</td>
						<td class="l email">{u.email}</td>
						<td>{date(u.createdAt)}</td>
						<td>{num(u.sessions)}</td>
						<td>{num(u.messages)}</td>
						<td class="dim">{ago(u.lastActive)}</td>
					</tr>
				{/each}
				{#if filtered.length === 0}
					<tr><td colspan="6" class="empty">{query.trim() ? '검색 결과가 없어요.' : '유저가 없어요.'}</td></tr>
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
		margin: 0;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text-dim);
	}

	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 12px;
	}
	.search {
		width: min(280px, 60%);
		padding: 8px 12px;
		font-size: 0.86rem;
		color: var(--text);
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		transition: border-color 0.15s ease;
	}
	.search::placeholder {
		color: var(--text-faint);
	}
	.search:focus {
		outline: none;
		border-color: var(--accent);
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
