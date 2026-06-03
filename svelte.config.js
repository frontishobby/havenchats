import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// platformProxy: vite dev 에서도 wrangler.jsonc 의 바인딩(D1 등)을 로컬로 에뮬레이트
		adapter: adapter({
			platformProxy: { persist: true }
		})
	}
};

export default config;
