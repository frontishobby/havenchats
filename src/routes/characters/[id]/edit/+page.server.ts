import { error, redirect } from '@sveltejs/kit';
import {
	getCharacterById,
	getCharacterDefaultVars,
	getCharacterLorebook,
	getCharacterOwnership,
	getCharacterPrompt
} from '$lib/server/db/characters';
import { isAdmin } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	if (!locals.user) {
		redirect(302, '/');
	}
	const db = platform?.env?.DB;
	if (!db) error(500, '저장소를 사용할 수 없어요.');

	const owner = await getCharacterOwnership(db, params.id);
	if (!owner) error(404, '캐릭터를 찾을 수 없어요.');
	if (owner.creatorId !== locals.user.id) error(403, '내가 만든 캐릭터만 수정할 수 있어요.');

	const character = await getCharacterById(db, params.id);
	if (!character) error(404, '캐릭터를 찾을 수 없어요.');

	const admin = isAdmin(locals.user.email);

	// charx import 캐릭터는 수정 불가(프롬프트 숨김·영구 비공개). 단, 관리자는 프롬프트 편집 허용.
	if (character.imported && !admin) {
		redirect(302, `/user/${locals.user.id}`);
	}

	// 관리자가 imported 캐릭터를 편집할 땐, getCharacterById 가 가린 원본 프롬프트/로어북/기본 변수를 폼에 복원.
	const adminImported = character.imported && admin;
	let defaultVariables: Record<string, string> | null = null;
	if (adminImported) {
		const [prompt, lorebook, vars] = await Promise.all([
			getCharacterPrompt(db, params.id),
			getCharacterLorebook(db, params.id),
			getCharacterDefaultVars(db, params.id)
		]);
		character.description = prompt ?? '';
		character.lorebook = lorebook;
		defaultVariables = vars;
	}

	// allowScriptVars: 관리자가 import 캐릭터를 편집할 때만 스크립트 변수 편집 노출.
	return { character, ownerId: locals.user.id, allowScriptVars: adminImported, defaultVariables };
};
