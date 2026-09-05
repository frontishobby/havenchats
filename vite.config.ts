import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SPA dev 서버는 정적 프론트만 담당. API/인증/이미지는 별도 wrangler dev(Worker, :8787)로 프록시.
//   터미널1: npm run dev:worker  (wrangler dev — D1/R2 로컬 바인딩 + Hono API)
//   터미널2: npm run dev         (vite — SPA HMR, 아래 프록시로 Worker 연결)
export default defineConfig({
	plugins: [sveltekit()],
	// webp WASM 인코더 워커(src/lib/webpEncode.worker.ts)가 내부에서 동적 import 를 쓰므로 ES 모듈 워커로 번들.
	worker: { format: 'es' },
	server: {
		proxy: {
			'/api': 'http://localhost:8787',
			'/auth': 'http://localhost:8787',
			'/img': 'http://localhost:8787'
		}
	}
});
