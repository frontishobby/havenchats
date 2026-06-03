import { characters as builtins, getCharacter as getBuiltin } from '$lib/data/characters';
import { getCharacterById, listCharacters } from './db/characters';
import type { Character } from '$lib/types';

/**
 * 빌트인(목) 캐릭터 + 유저 제작(D1) 캐릭터를 합쳐서 다룬다.
 * - 빌트인 id 는 슬러그('ha-rin'), 유저 캐릭터는 uuid → 충돌 없음.
 * - DB 바인딩이 없으면(빌드/일부 환경) 빌트인만 사용한다.
 */

/** 노출 가능한 캐릭터 목록. includeNsfw=false 면 NSFW 제외(비로그인). 유저 제작이 위로. */
export async function getVisibleCharacters(
	db: D1Database | undefined,
	includeNsfw: boolean
): Promise<Character[]> {
	const created = db ? await listCharacters(db) : [];
	const all = [...created, ...builtins];
	return includeNsfw ? all : all.filter((c) => c.contentRating === 'sfw');
}

/** id 로 단일 캐릭터 조회 (빌트인 우선, 없으면 D1). */
export async function findCharacter(
	db: D1Database | undefined,
	id: string
): Promise<Character | undefined> {
	const builtin = getBuiltin(id);
	if (builtin) return builtin;
	if (db) return (await getCharacterById(db, id)) ?? undefined;
	return undefined;
}
