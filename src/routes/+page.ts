import { loadJson } from '$lib/api/load';
import type { HomeData } from '$lib/api/pages';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => loadJson<HomeData>(fetch, '/api/home');
