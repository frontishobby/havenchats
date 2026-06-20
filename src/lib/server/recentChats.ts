import { listRecentSessions, type RecentSessionCursor } from './db/chats';
import { findCharacter } from './characters';
import type { Character, RecentChat } from '$lib/types';

/** 사이드바 최근 채팅 한 페이지 크기. 레이아웃 첫 페이지·무한스크롤 추가 로드 공통. */
export const RECENT_PAGE_SIZE = 30;

/** 사이드바 최근 채팅 한 페이지 결과 + 다음 페이지 커서. */
export interface RecentChatsPage {
	chats: RecentChat[];
	/** 다음 페이지 요청에 그대로 넘길 커서(없으면 끝). */
	nextCursor: string | null;
	hasMore: boolean;
}

/** 마지막 메시지를 사이드바 미리보기용 평문으로 — 지문/화자prefix/따옴표/장면토큰 제거. */
function previewText(raw: string): string {
	return raw
		.replace(/```+[^\n]*/g, ' ') // ```{제목} 등 펜스 마커 제거
		.replace(/\{#?[A-Za-z0-9_-]+\}/g, ' ') // 장면 이미지 토큰({#id}/{AAB}) 제거
		.replace(/\([^)]*\)/g, ' ') // (행동/심리 지문) 제거
		.replace(/\*[^*]*\*/g, ' ') // *지문* 제거
		.replace(/^\s*[^|\n]{1,20}\|\s*/gm, '') // "이름 | " 화자 prefix 제거
		.replace(/["'“”‘’]/g, '') // 따옴표 제거
		.replace(/\s+/g, ' ')
		.trim();
}

/** 커서 문자열 → 구조체. 형식 `${lastMessageAt}_${sessionId}`(ts엔 '_' 없음). 손상 시 null. */
export function parseRecentCursor(raw: string | null): RecentSessionCursor | null {
	if (!raw) return null;
	const idx = raw.indexOf('_');
	if (idx <= 0) return null;
	const ts = Number(raw.slice(0, idx));
	const id = raw.slice(idx + 1);
	if (!Number.isFinite(ts) || !id) return null;
	return { lastMessageAt: ts, sessionId: id };
}

/**
 * 최근 채팅 한 페이지 로드 — 세션 조회 → 캐릭터 메타 보강 → 미리보기 변환.
 * 레이아웃 첫 페이지와 `/api/chat/recent` 추가 로드가 동일 로직을 쓰도록 단일화.
 *
 * 커서/hasMore 는 **DB 행 기준**으로 계산한다(캐릭터 삭제 등으로 일부 행이 걸러져도 페이징이 안 끊기게).
 * 따라서 한 페이지가 RECENT_PAGE_SIZE 보다 적은 chats 를 반환할 수 있으나, DB 가 limit 만큼 돌려준 한
 * hasMore=true 로 다음 페이지를 잇는다.
 */
export async function loadRecentChats(
	db: D1Database,
	userId: string,
	limit = RECENT_PAGE_SIZE,
	cursor?: RecentSessionCursor | null
): Promise<RecentChatsPage> {
	const sessions = await listRecentSessions(db, userId, limit, cursor);
	const charCache = new Map<string, Character | undefined>();
	const chats: RecentChat[] = [];
	for (const s of sessions) {
		if (!s.lastContent) continue; // 메시지 없는 빈 세션 제외
		if (!charCache.has(s.characterId)) {
			charCache.set(s.characterId, await findCharacter(db, s.characterId));
		}
		const char = charCache.get(s.characterId);
		if (!char) continue; // 삭제된 캐릭터 등
		chats.push({
			sessionId: s.sessionId,
			characterId: s.characterId,
			characterName: char.name,
			avatarUrl: char.avatarUrl,
			preview: previewText(s.lastContent),
			lastMessageAt: s.lastMessageAt
		});
	}
	const hasMore = sessions.length === limit;
	const last = sessions[sessions.length - 1];
	const nextCursor = hasMore && last ? `${last.lastMessageAt}_${last.sessionId}` : null;
	return { chats, nextCursor, hasMore };
}
