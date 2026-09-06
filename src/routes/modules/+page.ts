import { loadJson } from '$lib/api/load';
import type { ModulesPageData } from '$lib/api/modules';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:modules');
	return loadJson<ModulesPageData>(fetch, '/api/modules/page');
};
