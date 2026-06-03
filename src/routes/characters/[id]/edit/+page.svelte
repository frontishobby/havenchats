<script lang="ts">
	import CharacterForm from '$lib/components/CharacterForm.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const c = data.character;
</script>

<svelte:head>
	<title>캐릭터 수정 — Haven</title>
</svelte:head>

<CharacterForm
	mode="edit"
	characterId={c.id}
	returnTo={`/user/${data.ownerId}`}
	returnLabel="내 프로필"
	initial={{
		name: c.name,
		tagline: c.tagline,
		intro: c.intro,
		description: c.description,
		audience: c.audience,
		contentRating: c.contentRating,
		tags: c.tags,
		greetings: c.greetings,
		avatarUrl: c.avatarUrl,
		imageSet: c.imageSet
	}}
/>
