import { loadJson } from '$lib/api/load';
import type { AdminStatsData } from '$lib/api/admin';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const period = url.searchParams.get('period') ?? '';
	return loadJson<AdminStatsData>(fetch, `/api/admin/stats?period=${period}`);
};
