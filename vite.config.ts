import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// 정적 SPA — 서버 없음. /api·/img 는 브라우저 안의 로컬 앱(src/lib/local)이 처리한다.
export default defineConfig({
	plugins: [sveltekit()],
	// webp WASM 인코더 워커(src/lib/webpEncode.worker.ts)가 내부에서 동적 import 를 쓰므로 ES 모듈 워커로 번들.
	worker: { format: 'es' },
});
