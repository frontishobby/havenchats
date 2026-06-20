import { loadJson } from '$lib/api/load';
import type { UserPageData } from '$lib/api/pages';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends }) => {
	const data = await loadJson<UserPageData>(fetch, `/api/user/${params.id}`);
	// 페이지가 캐릭터 삭제 후 invalidate(`character:<id>`) 를 호출 → 해당 키로 이 load 가 재실행되도록 등록.
	for (const c of data.characters) depends(`character:${c.id}`);
	return data;
};
