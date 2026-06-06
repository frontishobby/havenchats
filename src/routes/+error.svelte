<script lang="ts">
	import { page } from '$app/stores';

	// 상태 코드별 간단 메시지. 404는 가장 흔한 케이스.
	const messages: Record<number, { title: string; desc: string }> = {
		404: { title: '페이지를 찾을 수 없어요', desc: '주소가 바뀌었거나 삭제된 페이지일 수 있어요.' },
		403: { title: '접근할 수 없어요', desc: '이 페이지를 볼 권한이 없어요.' },
		500: { title: '문제가 발생했어요', desc: '잠시 후 다시 시도해 주세요.' }
	};

	let info = $derived(
		messages[$page.status] ?? {
			title: '문제가 발생했어요',
			desc: $page.error?.message ?? '잠시 후 다시 시도해 주세요.'
		}
	);
</script>

<div class="error-page">
	<div class="status">{$page.status}</div>
	<h1>{info.title}</h1>
	<p>{info.desc}</p>
	<a class="home-btn" href="/">홈으로</a>
</div>

<style>
	.error-page {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 8px;
		padding: 40px 20px;
		min-height: calc(100dvh - 60px); /* 헤더(60px) 제외한 영역 중앙 */
	}
	.status {
		font-size: 3rem;
		font-weight: 800;
		color: var(--accent);
		line-height: 1;
	}
	h1 {
		margin: 8px 0 0;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--text);
	}
	p {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.92rem;
	}
	.home-btn {
		margin-top: 16px;
		display: inline-block;
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		font-size: 0.88rem;
		padding: 9px 20px;
		border-radius: 999px;
		transition: background 0.15s ease;
	}
	.home-btn:hover {
		background: var(--accent-hover);
	}
</style>
