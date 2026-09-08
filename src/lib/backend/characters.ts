import { getCharacterById, listCharacters } from './db/characters';
import type { Character } from '$lib/types';

/**
 * 유저 제작(D1) 캐릭터를 다룬다.
 * - DB 바인딩이 없으면(빌드/일부 환경) 빈 목록을 반환한다.
 */

/** 노출 가능한 캐릭터 목록. includeNsfw=false 면 NSFW 제외(비로그인). 최신순. */
export async function getVisibleCharacters(
	db: D1Database | undefined,
	includeNsfw: boolean
): Promise<Character[]> {
	const all = db ? await listCharacters(db) : [];
	return includeNsfw ? all : all.filter((c) => c.contentRating === 'sfw');
}

/** id 로 단일 캐릭터 조회 (D1). */
export async function findCharacter(
	db: D1Database | undefined,
	id: string
): Promise<Character | undefined> {
	if (db) return (await getCharacterById(db, id)) ?? undefined;
	return undefined;
}
