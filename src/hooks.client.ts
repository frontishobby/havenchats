import { initLocalRuntime } from '$lib/local/runtime';
import { initStorage } from '$lib/local/sync.svelte';
import type { ClientInit } from '@sveltejs/kit';

/**
 * 앱 시작 전 1회 — 브라우저 런타임(SQLite WASM + IndexedDB + Hono 앱 + 이미지 서비스워커)을 띄운다.
 * SvelteKit 은 이 promise 가 끝날 때까지 라우트 load 를 시작하지 않으므로, 이후 모든
 * `fetch('/api/..')` 는 `app.html` 의 래퍼를 통해 로컬 앱으로 간다.
 */
export const init: ClientInit = async () => {
	await initLocalRuntime();
	// 저장소 모드 확인 + Drive 초기 동기화는 기다리지 않는다(랜딩 오버레이가 진행을 보여주고,
	// 원격 DB 를 받아오면 invalidateAll 로 화면을 새로 그린다).
	void initStorage();
};
