import { error, redirect } from '@sveltejs/kit';

/**
 * 클라이언트 load 용 GET 헬퍼 — 같은 오리진 Worker API 호출.
 *  - 401 → SvelteKit error(401)
 *  - 그 외 !ok → 응답의 { error } 메시지로 error(status)
 *  - 본문이 { redirect } soft-redirect 힌트면 클라 네비게이트(redirect)
 *  - 정상 → 파싱된 데이터(T)
 *
 * SvelteKit universal load 의 `fetch` 를 넘겨 호출한다(쿠키 동봉·SSR 호환).
 */
export async function loadJson<T>(fetchFn: typeof fetch, path: string): Promise<T> {
	const res = await fetchFn(path);
	if (!res.ok) {
		let msg = '문제가 발생했어요.';
		try {
			msg = ((await res.json()) as { error?: string }).error ?? msg;
		} catch {
			/* 비-JSON 응답 */
		}
		throw error(res.status, msg);
	}
	const data = (await res.json()) as T & { redirect?: string };
	if (data && typeof data === 'object' && typeof data.redirect === 'string') {
		throw redirect(302, data.redirect);
	}
	return data;
}
