import { loadJson } from '$lib/api/load';
import type { HomeData } from '$lib/api/pages';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const data = await loadJson<HomeData>(fetch, '/api/home');
	// authError 는 클라 URL(?auth=…)에서 덮어쓴다(서버 응답 무관).
	return { ...data, authError: url.searchParams.get('auth') };
};
