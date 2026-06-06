<script lang="ts">
	import ChatView from '$lib/components/ChatView.svelte';
	import type { PageData } from './$types';

	// 세션 이어가기. UI 본체는 ChatView 공용 컴포넌트.
	let { data }: { data: PageData } = $props();
</script>

<ChatView {data} />
