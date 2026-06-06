<script lang="ts">
	import ChatView from '$lib/components/ChatView.svelte';
	import type { PageData } from './$types';

	// 채팅 UI 본체는 ChatView 컴포넌트로 추출돼 디버그 모드(/chat/[id]/debug)와 공유된다.
	let { data }: { data: PageData } = $props();
</script>

<ChatView {data} />
