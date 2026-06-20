import { loadJson } from '$lib/api/load';
import type { StylesPageData } from '$lib/api/styles';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:styles');
	return loadJson<StylesPageData>(fetch, '/api/styles/page');
};
