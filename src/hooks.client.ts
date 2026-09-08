import { initLocalRuntime } from '$lib/local/runtime';
import type { ClientInit } from '@sveltejs/kit';

/**
 * 앱 시작 전 1회 — 브라우저 런타임(SQLite WASM + IndexedDB + Hono 앱 + 이미지 서비스워커)을 띄운다.
 * SvelteKit 은 이 promise 가 끝날 때까지 라우트 load 를 시작하지 않으므로, 이후 모든
 * `fetch('/api/..')` 는 `app.html` 의 래퍼를 통해 로컬 앱으로 간다.
 */
export const init: ClientInit = async () => {
	await initLocalRuntime();
};
