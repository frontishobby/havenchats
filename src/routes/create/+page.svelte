<script lang="ts">
	// 캐릭터 만들기 — 플레이스홀더.
	// 현재 캐릭터는 src/lib/data/characters.ts 의 목 데이터이고, 캐릭터 저장용 D1 테이블/리포지토리가
	// 아직 없으므로 폼은 추후 구현한다. (description 이 사실상 전체 프롬프트가 되도록 설계됨)
</script>

<svelte:head>
	<title>캐릭터 만들기 — Haven</title>
</svelte:head>

<div class="create">
	<a class="back" href="/">← 탐색으로</a>

	<header class="head">
		<span class="logo">✦</span>
		<h1>캐릭터 만들기</h1>
		<p class="sub">
			나만의 캐릭터·시나리오·시뮬레이션을 만들어 보세요. 역할·말투·세계관·출력 형식까지
			<strong>프롬프트(설정)에 자유롭게</strong> 적을 수 있어요.
		</p>
	</header>

	<div class="soon">
		<p class="soon-title">🚧 준비 중</p>
		<p class="soon-desc">
			캐릭터 제작 폼을 만들고 있어요. 곧 이름·소개·프롬프트·첫 인사·태그·등급을 직접 입력해
			캐릭터를 등록할 수 있게 됩니다.
		</p>
	</div>
</div>

<style>
	.create {
		max-width: 640px;
		margin: 0 auto;
		padding: 32px 20px 64px;
	}
	.back {
		display: inline-block;
		color: var(--text-dim);
		font-size: 0.88rem;
		margin-bottom: 28px;
	}
	.back:hover {
		color: var(--text);
	}
	.head {
		text-align: center;
		margin-bottom: 32px;
	}
	.logo {
		color: var(--accent);
		font-size: 2rem;
	}
	.head h1 {
		margin: 10px 0 8px;
		font-size: 1.6rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.sub {
		margin: 0 auto;
		max-width: 460px;
		color: var(--text-dim);
		font-size: 0.92rem;
		line-height: 1.6;
	}
	.sub strong {
		color: var(--text);
	}
	.soon {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 28px 24px;
		text-align: center;
	}
	.soon-title {
		margin: 0 0 8px;
		font-size: 1.05rem;
		font-weight: 700;
	}
	.soon-desc {
		margin: 0 auto;
		max-width: 440px;
		color: var(--text-dim);
		font-size: 0.9rem;
		line-height: 1.6;
	}
</style>
