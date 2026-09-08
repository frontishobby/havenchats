import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// 정적 SPA 빌드 → build/ (GitHub Pages 가 서빙). 서버 코드 없음.
// GitHub Pages 는 미매칭 경로에 404.html 을 주므로 build 스크립트가 index.html 을 404.html 로 복사한다(SPA 딥링크).
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
