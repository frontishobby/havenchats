/**
 * 로어북 — 공용 순수함수(클라/서버). 검증·정규화 + 채팅 시 선택·포맷.
 *
 * 저장: characters.lorebook JSON. 채팅 시 최근 대화에서 keys 가 매칭되거나 constant 인 항목만
 * 프롬프트에 주입한다(시스템 prefix 가 아니라 마지막 유저 메시지 끝 → prefix 캐시 보존).
 * 사용처: characterForm(폼 검증), api/import/charx(import 검증), cardToCharacter(import 매핑),
 * api/chat(런타임 주입).
 */

import type { CharacterLorebook, LoreEntry } from '$lib/types';
import { evalCBS, type CbsContext } from '$lib/cbs';

// ── 저장 한도(폼/import 공용) ──
export const LORE_ENTRIES_MAX = 100; // 캐릭터당 항목 수
export const LORE_KEYS_MAX = 20; // 항목당 키워드 수
export const LORE_KEY_MAX = 60; // 키워드 한 개 길이
export const LORE_CONTENT_MAX = 4000; // 항목 본문 길이

// ── 런타임 주입 예산 ──
const LORE_SCAN_DEPTH = 10; // 키워드 스캔할 최근 메시지 수
const LORE_INJECT_MAX = 20; // 한 턴에 주입할 최대 항목 수
const LORE_TOKEN_BUDGET = 1500; // 주입 본문 토큰 예산(estimateTokens 와 동일 기준: 글자/2)

function genId(): string {
	// Workers·브라우저 모두 crypto.randomUUID 지원(보안 컨텍스트).
	return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
}

/**
 * 임의 입력(폼/카드의 raw 배열)을 안전한 CharacterLorebook 으로 정규화. 유효 항목 없으면 null.
 * - keys: 문자열만, trim, 중복 제거, 길이·개수 clamp
 * - content: trim, 길이 clamp
 * - content 가 비거나, constant 아니면서 keys 도 없으면(영영 안 켜짐) 버림
 */
export function normalizeLoreEntries(raw: unknown): CharacterLorebook | null {
	if (!Array.isArray(raw)) return null;
	const entries: LoreEntry[] = [];
	for (const e of raw) {
		const o = (e ?? {}) as {
			id?: unknown;
			keys?: unknown;
			content?: unknown;
			constant?: unknown;
			order?: unknown;
		};
		const id = typeof o.id === 'string' && o.id ? o.id : genId();
		const seen = new Set<string>();
		const keys = (Array.isArray(o.keys) ? o.keys : [])
			.filter((k): k is string => typeof k === 'string')
			.map((k) => k.trim().slice(0, LORE_KEY_MAX))
			.filter((k) => k !== '' && !seen.has(k.toLowerCase()) && (seen.add(k.toLowerCase()), true))
			.slice(0, LORE_KEYS_MAX);
		const content = (typeof o.content === 'string' ? o.content : '').trim().slice(0, LORE_CONTENT_MAX);
		const constant = o.constant === true;
		const order = typeof o.order === 'number' && Number.isFinite(o.order) ? o.order : 0;
		if (!content || (!constant && keys.length === 0)) continue;
		entries.push({ id, keys, content, constant, order });
		if (entries.length >= LORE_ENTRIES_MAX) break;
	}
	return entries.length > 0 ? { entries } : null;
}

/**
 * 최근 대화 텍스트에 비추어 주입할 항목을 고른다.
 * constant 항목은 항상 포함, 그 외엔 keys 중 하나라도 recentText(소문자)에 부분일치하면 포함.
 * order 내림차순 정렬(높은 우선순위 먼저).
 */
export function selectLoreEntries(
	lorebook: CharacterLorebook | null,
	recentText: string
): LoreEntry[] {
	if (!lorebook || lorebook.entries.length === 0) return [];
	const hay = recentText.toLowerCase();
	const hit = lorebook.entries.filter(
		(e) => e.constant || e.keys.some((k) => hay.includes(k.toLowerCase()))
	);
	return hit.sort((a, b) => b.order - a.order);
}

/**
 * 선택된 항목을 프롬프트 블록 문자열로 포맷. 항목 수·토큰 예산까지만 누적. 없으면 null.
 * estimateTokens 와 같은 기준(글자/2)으로 본문 길이를 가늠한다.
 */
export function formatLoreBlock(entries: LoreEntry[]): string | null {
	if (entries.length === 0) return null;
	const picked: string[] = [];
	let budget = LORE_TOKEN_BUDGET;
	for (const e of entries) {
		if (picked.length >= LORE_INJECT_MAX) break;
		const cost = Math.ceil(e.content.length / 2);
		if (cost > budget && picked.length > 0) continue; // 예산 초과 항목은 건너뛰되, 최소 1개는 보장
		budget -= cost;
		picked.push(e.content.trim());
	}
	if (picked.length === 0) return null;
	return [
		`# 설정 (참고 정보)`,
		`아래는 지금 장면에 관련된 설정·배경이다. 자연스럽게 반영하되, 목록을 그대로 나열하지 마라.`,
		...picked.map((c) => `- ${c}`)
	].join('\n');
}

/**
 * 채팅 핸들러용 헬퍼: 최근 window 메시지 content 를 스캔 텍스트로 만들어 선택→(CBS 평가)→포맷.
 * 선택된 항목 content 의 CBS 는 ctx 로 평가(description 이후 같은 ctx — setvar 변이 공유). 없으면 null.
 */
export function buildLoreBlock(
	lorebook: CharacterLorebook | null,
	recentMessages: { content: string }[],
	ctx: CbsContext
): string | null {
	if (!lorebook) return null;
	const recentText = recentMessages.slice(-LORE_SCAN_DEPTH).map((m) => m.content).join('\n');
	const selected = selectLoreEntries(lorebook, recentText)
		.map((e) => ({ ...e, content: evalCBS(e.content, ctx).text.trim() }))
		.filter((e) => e.content !== '');
	return formatLoreBlock(selected);
}
