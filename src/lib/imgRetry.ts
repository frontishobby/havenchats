/**
 * `<img src="/img/<key>">` 로드 실패 자동 복구 — Svelte 액션 `use:imgRetry`.
 *
 * 서비스워커(`static/img-sw.js`)가 IndexedDB 에서 응답하는 이미지가 가끔 첫 로드에서만 깨져 엑스박스로
 * 뜨고(2026-09-09, 채팅 생성 이미지 — 재생성을 누르면 같은 키가 바로 뜸), 같은 URL 을 다시 요청하면
 * 정상이다. 원인 후보(서비스워커 IDB 일시 오류·WebKit 의 방금 쓴 Blob 읽기 실패·OneDrive 지연 다운로드가
 * 서비스워커 토큰 복사본 만료로 404)를 하나로 못 박기 어렵고 어느 쪽이든 재요청이면 해결되므로 여기서 복구한다.
 *
 *  1) `error` 시 짧은 지연 뒤 `?r=n` 캐시버스팅으로 서비스워커 경로를 다시 시도(2회).
 *  2) 그래도 실패하면 페이지 런타임 경로 `fetch('/img/<key>')`(app.html 래퍼 → Hono img 라우트 → R2 shim,
 *     로컬에 없으면 sync 의 miss 핸들러가 `silentToken()` 으로 OneDrive 에서 받아 IndexedDB 에 넣음)로
 *     Blob 을 받아 object URL 로 표시한다.
 *  3) 전부 실패하면 `onFail` 을 부른다(호출부가 placeholder 정리 등).
 *
 * 같은 오리진 `/img/` 가 아닌 src(blob:·외부 URL)는 건드리지 않는다. Svelte 가 src 를 새 값으로 바꾸면 재시도
 * 상태를 초기화한다.
 */
export interface ImgRetryOptions {
	/** 모든 복구가 실패했을 때. */
	onFail?: () => void;
}

const RETRY_DELAYS_MS = [300, 1200];
const RETRY_PARAM = 'r';

function localImgPath(src: string): string | null {
	try {
		const u = new URL(src, location.href);
		if (u.origin !== location.origin || !u.pathname.startsWith('/img/')) return null;
		u.searchParams.delete(RETRY_PARAM);
		return u.pathname + u.search;
	} catch {
		return null;
	}
}

export function imgRetry(img: HTMLImageElement, options: ImgRetryOptions = {}): { update(o: ImgRetryOptions): void; destroy(): void } {
	let opts = options;
	let original: string | null = null; // 복구 중인 원본 경로(`/img/<key>[?v=]`)
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let blobUrl: string | null = null;
	let disposed = false;

	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};
	const revoke = () => {
		if (blobUrl) {
			try {
				URL.revokeObjectURL(blobUrl);
			} catch {
				/* 무시 */
			}
			blobUrl = null;
		}
	};
	const fail = () => {
		original = null;
		attempt = 0;
		opts.onFail?.();
	};

	async function fallbackFetch(path: string) {
		try {
			const res = await fetch(path);
			if (!res.ok) throw new Error(`img fallback ${res.status}`);
			const blob = await res.blob();
			if (disposed || original !== path) return;
			revoke();
			blobUrl = URL.createObjectURL(blob);
			img.src = blobUrl;
		} catch (e) {
			console.warn('[imgRetry] 복구 실패:', path, e);
			if (!disposed && original === path) fail();
		}
	}

	const onError = () => {
		if (disposed) return;
		const src = img.getAttribute('src') ?? '';
		if (blobUrl && src === blobUrl) {
			// 폴백으로 받은 blob 마저 디코드 실패 → 포기
			fail();
			return;
		}
		const path = localImgPath(src);
		if (!path) return; // blob:/외부 URL 은 대상 아님
		if (path !== original) {
			original = path;
			attempt = 0;
		}
		clearTimer();
		if (attempt < RETRY_DELAYS_MS.length) {
			const n = ++attempt;
			timer = setTimeout(() => {
				timer = null;
				if (disposed || original !== path) return;
				const sep = path.includes('?') ? '&' : '?';
				img.src = `${path}${sep}${RETRY_PARAM}=${n}`;
			}, RETRY_DELAYS_MS[n - 1]);
			return;
		}
		attempt++;
		void fallbackFetch(path);
	};

	img.addEventListener('error', onError);
	return {
		update(o: ImgRetryOptions) {
			opts = o;
		},
		destroy() {
			disposed = true;
			clearTimer();
			img.removeEventListener('error', onError);
			revoke();
		}
	};
}
