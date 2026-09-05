/**
 * 클라 전용 — NovelAI 이미지 생성을 **브라우저가 직접** 호출한다(image.novelai.net 은 CORS `*`).
 *
 * 왜: Worker 가 수 MB 의 base64 프레임을 파싱/재인코딩하면 요청당 CPU 가 수백 ms 로 무료 플랜
 * 한도(10ms)를 크게 넘긴다. 브라우저가 직접 받으면 Worker 는 프롬프트 조립(prepare)과 저장(commit)만 한다.
 *
 *  - 스트리밍: `/ai/generate-image-stream` + `parameters.stream = 'msgpack'` → 4바이트 big-endian
 *    길이 프리픽스 + msgpack 메시지 반복. `{ event_type: 'intermediate'|'final'|'error'|'retry',
 *    samp_ix, step_ix, gen_id, sigma, image: bin }`. intermediate = JPEG, final = PNG (바이너리 그대로,
 *    base64 없음).
 *  - 폴백: 스트림 실패(엔드포인트 미지원·프레임 없음) 시 `/ai/generate-image` (ZIP) → fflate 로 첫 파일.
 *  - 최종 PNG 는 webp 변환(`blobToWebp`: canvas → WebKit 이면 libwebp WASM 워커 폴백) — 저장량·로딩 절감.
 *    변환 자체가 실패한 경우에만 원본 PNG 유지.
 */

import { decode } from '@msgpack/msgpack';
import { unzipSync } from 'fflate';
import { blobToWebp, sniffImageMime } from '$lib/imagePreview';

const STREAM_URL = 'https://image.novelai.net/ai/generate-image-stream';
const GENERATE_URL = 'https://image.novelai.net/ai/generate-image';

/** prepare 가 돌려주는 NovelAI 요청 바디 형태. */
export interface NovelaiPayload {
	input: string;
	model: string;
	action: string;
	parameters: Record<string, unknown>;
}

export class NovelaiError extends Error {
	constructor(
		message: string,
		public readonly status: number | null = null,
		public readonly code: 'auth' | 'anlas' | 'rate' | 'network' | 'other' = 'other'
	) {
		super(message);
		this.name = 'NovelaiError';
	}
}

/** HTTP 상태 → 사용자 메시지/코드. 401=토큰 무효, 402=Anlas 부족, 429=속도제한. */
function errorFromStatus(status: number, body: string): NovelaiError {
	if (status === 401 || status === 403)
		return new NovelaiError('NovelAI 인증에 실패했습니다. API 키를 다시 등록해 주세요.', status, 'auth');
	if (status === 402) return new NovelaiError('NovelAI Anlas 가 부족합니다.', status, 'anlas');
	if (status === 429)
		return new NovelaiError('NovelAI 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.', status, 'rate');
	let detail = '';
	try {
		const j = JSON.parse(body) as { message?: string };
		if (typeof j.message === 'string') detail = j.message;
	} catch {
		detail = body.slice(0, 200);
	}
	return new NovelaiError(`NovelAI 오류 (${status})${detail ? `: ${detail}` : ''}`, status, 'other');
}

interface StreamEvent {
	event_type?: string;
	image?: Uint8Array;
	code?: unknown;
	message?: unknown;
}

/**
 * msgpack 스트림 생성. 중간 프레임(JPEG)마다 onPreview 호출, 최종(PNG) 바이트 반환.
 * 스트림이 열리지 않거나(비 200) 프레임이 하나도 없으면 throw → 호출부가 ZIP 폴백.
 */
async function generateStream(
	token: string,
	payload: NovelaiPayload,
	onPreview: (frame: Blob) => void,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const body = { ...payload, parameters: { ...payload.parameters, stream: 'msgpack' } };
	const res = await fetch(STREAM_URL, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});
	if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
	if (!res.body) throw new NovelaiError('스트림 응답이 비어 있습니다.');

	const reader = res.body.getReader();
	let buf = new Uint8Array(0);
	let final: Uint8Array | null = null;
	let frames = 0;
	const append = (chunk: Uint8Array) => {
		const next = new Uint8Array(buf.length + chunk.length);
		next.set(buf, 0);
		next.set(chunk, buf.length);
		buf = next;
	};
	const handle = (ev: StreamEvent) => {
		if (ev.event_type === 'error') {
			throw new NovelaiError(`NovelAI 생성 오류${ev.code != null ? ` (${String(ev.code)})` : ''}: ${String(ev.message ?? '')}`);
		}
		if (!(ev.image instanceof Uint8Array) || ev.image.length === 0) return;
		frames++;
		if (ev.event_type === 'final') {
			final = ev.image;
		} else {
			onPreview(new Blob([ev.image as BlobPart], { type: sniffImageMime(ev.image) }));
		}
	};
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		append(value);
		// 길이 프리픽스(4B BE) + 메시지. 버퍼에 온전한 메시지가 있는 동안 반복 소비.
		let off = 0;
		while (buf.length - off >= 4) {
			const len = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
			if (buf.length - off - 4 < len) break;
			const msg = buf.subarray(off + 4, off + 4 + len);
			off += 4 + len;
			let ev: unknown;
			try {
				ev = decode(msg);
			} catch {
				continue; // 알 수 없는 프레임은 건너뜀
			}
			if (ev && typeof ev === 'object') handle(ev as StreamEvent);
		}
		if (off > 0) buf = buf.slice(off);
	}
	if (!final) {
		if (frames === 0) throw new NovelaiError('스트림에 이미지 프레임이 없습니다.');
		throw new NovelaiError('최종 이미지를 받지 못했습니다.');
	}
	return final;
}

/** 비스트리밍 생성(ZIP). 첫 파일의 바이트를 돌려준다. */
async function generateZip(token: string, payload: NovelaiPayload, signal?: AbortSignal): Promise<Uint8Array> {
	const res = await fetch(GENERATE_URL, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(payload),
		signal
	});
	if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
	const zip = new Uint8Array(await res.arrayBuffer());
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(zip);
	} catch (e) {
		throw new NovelaiError(`NovelAI 응답(zip) 해석 실패: ${String(e)}`);
	}
	const first = Object.values(files).find((b) => b.length > 0);
	if (!first) throw new NovelaiError('NovelAI 응답에 이미지가 없습니다.');
	return first;
}

export interface GenerateDirectResult {
	/** 업로드할 최종 이미지(webp 변환 성공 시 webp, 아니면 원본 PNG). */
	blob: Blob;
	/** 스트리밍으로 받았는지(false = ZIP 폴백). */
	streamed: boolean;
}

/**
 * NovelAI 직접 생성 코어: 스트림(프리뷰 콜백) → 실패 시 ZIP 폴백 → 최종 PNG 를 webp 로 변환.
 * 인증/Anlas/속도제한 등 서버가 명시적으로 거부한 경우는 폴백하지 않고 그대로 throw.
 */
export async function generateImageDirect(
	token: string,
	payload: NovelaiPayload,
	opts: { onPreview?: (frame: Blob) => void; signal?: AbortSignal; webpQuality?: number } = {}
): Promise<GenerateDirectResult> {
	let bytes: Uint8Array | null = null;
	let streamed = true;
	try {
		bytes = await generateStream(token, payload, opts.onPreview ?? (() => {}), opts.signal);
	} catch (e) {
		if (e instanceof NovelaiError && e.code !== 'other') throw e; // auth/anlas/rate 는 재시도 무의미
		if (opts.signal?.aborted) throw e;
		console.warn('[novelai] 스트리밍 실패 → ZIP 폴백:', String(e));
		streamed = false;
	}
	if (!bytes) bytes = await generateZip(token, payload, opts.signal);

	const original = new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) });
	let blob = original;
	try {
		const webp = await blobToWebp(original, opts.webpQuality ?? 0.9);
		if (webp.type === 'image/webp' && webp.size > 0) blob = webp;
	} catch (e) {
		console.warn('[novelai] webp 변환 실패 — 원본 업로드:', String(e));
	}
	return { blob, streamed };
}

// ── 토큰 캐시 ────────────────────────────────────────────────────────────────
// 평문 토큰은 메모리에만(모듈 스코프). 탭을 닫으면 사라지며 localStorage 에 저장하지 않는다.
let cachedToken: string | null = null;

/** /api/keys/novelai/token 으로 본인 토큰 수령(캐시). force=true 면 재수령(401 뒤 갱신용). */
export async function getNovelaiToken(force = false): Promise<string> {
	if (cachedToken && !force) return cachedToken;
	const res = await fetch('/api/keys/novelai/token', { cache: 'no-store' });
	if (res.status === 404) throw new NovelaiError('NovelAI 키가 없습니다. 프로필 메뉴 > API 키 관리에서 등록하세요.', 404, 'auth');
	if (!res.ok) throw new NovelaiError('NovelAI 키를 불러오지 못했습니다.', res.status, 'network');
	const d = (await res.json()) as { token?: string };
	if (!d.token) throw new NovelaiError('NovelAI 키를 불러오지 못했습니다.', res.status, 'network');
	cachedToken = d.token;
	return cachedToken;
}

/** 키 삭제/교체 시 캐시 폐기. */
export function clearNovelaiToken() {
	cachedToken = null;
}
