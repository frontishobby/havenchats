import { error } from '@sveltejs/kit';
import { listCharactersByCreator } from '$lib/server/db/characters';
import { getPublicProfile } from '$lib/server/db/users';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const profile = await getPublicProfile(db, params.id);
	// display_name 미설정(프로필 미완성) 유저는 공개 페이지가 없는 것으로 취급.
	if (!profile || !profile.name) error(404, '사용자를 찾을 수 없어요.');

	const isOwner = locals.user?.id === params.id;
	// 비로그인 방문자에게는 NSFW 캐릭터를 숨긴다(본인은 항상 전체 노출).
	const all = await listCharactersByCreator(db, params.id);
	const characters = isOwner || locals.user ? all : all.filter((c) => c.contentRating === 'sfw');

	return { profile, characters, isOwner };
};
