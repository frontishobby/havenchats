<script lang="ts">
	import CharacterForm from '$lib/components/CharacterForm.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const c = $derived(data.character);
</script>

<svelte:head>
	<title>캐릭터 수정 — Haven</title>
</svelte:head>

<CharacterForm
	mode="edit"
	characterId={c.id}
	returnTo="/"
	returnLabel="메인"
	allowScriptVars={data.allowScriptVars}
	initial={{
		name: c.name,
		tagline: c.tagline,
		intro: c.intro,
		description: c.description,
		audience: c.audience,
		contentRating: c.contentRating,
		visibility: c.visibility,
		tags: c.tags,
		greetings: c.greetings,
		avatarUrl: c.avatarUrl,
		imageSet: c.imageSet,
		lorebook: c.lorebook,
		defaultVariables: data.defaultVariables,
		recommendedStyleId: c.recommendedStyleId
	}}
/>
