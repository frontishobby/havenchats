/// <reference lib="webworker" />
/**
 * webp 인코딩 Web Worker (클라 전용, WebKit 폴백).
 *
 * 사파리·iOS 의 모든 브라우저(iOS 크롬 포함 — 엔진이 WebKit)는 canvas.toBlob('image/webp') 인코딩을
 * 지원하지 않아 PNG 를 돌려준다. 그 경우 libwebp WASM(@jsquash/webp, Squoosh 재패키징)으로 직접 인코딩한다.
 * 832×1216 한 장에 아이폰 기준 0.5~1초 정도 걸리므로 메인 스레드 대신 워커에서 돌린다.
 *
 * WASM 은 SIMD 지원 여부에 따라 둘 중 하나만 받는다(브로틀리 압축 시 약 100KB, 이후 캐시).
 * emscripten 글루가 import.meta.url 로 .wasm 을 찾지 않도록 Vite `?url` 로 경로를 받아 직접 컴파일해 넘긴다.
 */
import encode, { init } from '@jsquash/webp/encode';
import { simd } from 'wasm-feature-detect';
import simdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';
import plainWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url';

export type WebpEncodeRequest = {
	id: number;
	data: Uint8ClampedArray;
	width: number;
	height: number;
	/** 0~100 */
	quality: number;
};
export type WebpEncodeResponse = { id: number; buf: ArrayBuffer } | { id: number; error: string };

let ready: Promise<unknown> | null = null;

async function ensureInit() {
	if (!ready) {
		ready = (async () => {
			const url = (await simd()) ? simdWasmUrl : plainWasmUrl;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`webp 인코더 로드 실패(${res.status})`);
			const module = await WebAssembly.compile(await res.arrayBuffer());
			// init(module) 은 d.ts 에 없지만 JS 구현이 WebAssembly.Module 단일 인자를 받는다(글루의 fetch 생략).
			// 내부에서 simd() 를 다시 판별해 같은 글루를 고르므로 여기서 고른 wasm 과 항상 짝이 맞는다.
			await (init as unknown as (m: WebAssembly.Module) => Promise<unknown>)(module);
		})().catch((e) => {
			ready = null; // 다음 요청에서 재시도
			throw e;
		});
	}
	return ready;
}

self.onmessage = async (e: MessageEvent<WebpEncodeRequest>) => {
	const { id, data, width, height, quality } = e.data;
	try {
		await ensureInit();
		const buf = await encode({ data, width, height } as ImageData, { quality });
		const msg: WebpEncodeResponse = { id, buf };
		self.postMessage(msg, [buf]);
	} catch (err) {
		const msg: WebpEncodeResponse = { id, error: err instanceof Error ? err.message : String(err) };
		self.postMessage(msg);
	}
};
