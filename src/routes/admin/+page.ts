import { loadJson } from '$lib/api/load';
import type { AdminOverviewData } from '$lib/api/admin';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	return loadJson<AdminOverviewData>(fetch, '/api/admin/overview');
};
