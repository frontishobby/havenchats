<script lang="ts">
	let { size = 16 }: { size?: number } = $props();
</script>

<svg
	class="badge-nsfw"
	width={size}
	height={size}
	viewBox="0 0 100 100"
	aria-label="18세 이상"
	role="img"
>
	<path d="M50 16 L61 39 L84 50 L61 61 L50 84 L39 61 L16 50 L39 39 Z" fill="#e5202e" />
</svg>

<style>
	.badge-nsfw {
		flex: none;
		display: block;
	}
</style>
