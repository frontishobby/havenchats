<script lang="ts">
	import ChatView from '$lib/components/ChatView.svelte';
	import type { PageData } from './$types';

	// 디버그 모드: 일반 채팅과 동일한 ChatView 를 debug 플래그로 띄운다(우측 디버그 패널 포함).
	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

<ChatView {data} debug />
