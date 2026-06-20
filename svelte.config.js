import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// 정적 SPA 빌드 → build/ (Cloudflare Worker 의 ASSETS 로 서빙).
// 서버 로직은 전부 worker/(Hono) 로 분리됐고, 프론트는 클라 렌더 SPA.
/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapterStatic({
			// 모든 라우트를 클라에서 렌더(SPA). fallback 은 미매칭 경로용 단일 진입.
			fallback: 'index.html',
			pages: 'build',
			assets: 'build',
			precompress: false,
			strict: false
		})
	}
};

export default config;
