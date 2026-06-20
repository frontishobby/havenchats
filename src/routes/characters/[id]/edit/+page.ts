import { loadJson } from '$lib/api/load';
import type { CharacterEditData } from '$lib/api/characters';
import type { PageLoad } from './$types';

// 비로그인/권한 미달/charx import 등 로더가 redirect 하던 경우는 API 의 { redirect } 힌트로 위임(loadJson 처리).
export const load: PageLoad = async ({ fetch, params }) => {
	return loadJson<CharacterEditData>(fetch, `/api/characters/${params.id}/edit-data`);
};
