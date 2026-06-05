<script lang="ts">
	import CharacterForm from '$lib/components/CharacterForm.svelte';
</script>

<svelte:head>
	<title>캐릭터 만들기 — Haven</title>
</svelte:head>

<div class="import-bar">
	<span>캐릭터 카드(.charx)가 있나요?</span>
	<a href="/import">.charx 가져오기 →</a>
</div>

<CharacterForm mode="create" />

<style>
	.import-bar {
		max-width: 720px;
		margin: 18px auto -8px;
		padding: 10px 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.86rem;
		color: var(--text-dim);
	}
	.import-bar a {
		color: var(--accent);
		font-weight: 700;
		white-space: nowrap;
	}
</style>
