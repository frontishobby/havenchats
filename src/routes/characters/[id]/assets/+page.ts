import { loadJson } from '$lib/api/load';
import type { CharacterAssetsData } from '$lib/api/characters';
import type { PageLoad } from './$types';

/**
 * 캐릭터 에셋(장면 이미지 카탈로그) 미리보기.
 * 접근 규칙(비공개=제작자만, NSFW=로그인 필수)은 API 가 강제하고, redirect 는 { redirect } 힌트로 위임.
 */
export const load: PageLoad = async ({ fetch, params, depends }) => {
	// promote/에셋 추가 후 invalidate(`character:<id>`) 로 캐시된 load 를 갱신.
	depends(`character:${params.id}`);
	return loadJson<CharacterAssetsData>(fetch, `/api/characters/${params.id}/assets-data`);
};
