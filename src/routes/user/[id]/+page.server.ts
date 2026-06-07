import { error } from '@sveltejs/kit';
import { listCharactersByCreator } from '$lib/server/db/characters';
import { getPublicProfile } from '$lib/server/db/users';
import { isAdmin } from '$lib/server/auth';
import { canSeeNsfw } from '$lib/nsfw';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const profile = await getPublicProfile(db, params.id);
	// display_name 미설정(프로필 미완성) 유저는 공개 페이지가 없는 것으로 취급.
	if (!profile || !profile.name) error(404, '사용자를 찾을 수 없어요.');

	const isOwner = locals.user?.id === params.id;
	// 비공개 캐릭터는 본인에게만 보인다. 외부 방문자에겐 공개 캐릭터만 조회.
	const all = await listCharactersByCreator(db, params.id, isOwner);
	// NSFW 캐릭터는 본인 또는 파라과이(PY) 방문자에게만 노출(그 외엔 SFW 만).
	const characters =
		isOwner || canSeeNsfw(locals.user) ? all : all.filter((c) => c.contentRating === 'sfw');

	// 관리자는 가져온(import) 캐릭터의 프롬프트도 편집할 수 있다.
	return { profile, characters, isOwner, isAdmin: isAdmin(locals.user?.email) };
};
