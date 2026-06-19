import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterVercel from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// 호스팅 분기: Vercel 빌드(process.env.VERCEL)면 adapter-vercel, 아니면 adapter-cloudflare.
// 로컬 dev(VERCEL 미설정)는 cloudflare 어댑터 → platformProxy 로 D1/R2 바인딩 로컬 에뮬레이트.
const onVercel = !!process.env.VERCEL;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: onVercel
			? adapterVercel({
					// D1·R2 가 APAC(서울) 이라 같은 리전으로 고정해 프록시 왕복 지연 최소화.
					// Hobby 는 단일 리전. maxDuration 은 Hobby 상한(60s).
					runtime: 'nodejs22.x',
					regions: ['icn1'],
					maxDuration: 60
				})
			: adapterCloudflare({
					platformProxy: { persist: true }
				})
	}
};

export default config;
