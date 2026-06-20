import { loadJson } from '$lib/api/load';
import type { AdminUserDetailData } from '$lib/api/admin';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	return loadJson<AdminUserDetailData>(fetch, `/api/admin/users/${params.id}`);
};
