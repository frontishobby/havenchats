import { loadJson } from '$lib/api/load';
import type { AdminInfraData } from '$lib/api/admin';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	return loadJson<AdminInfraData>(fetch, '/api/admin/infra');
};
