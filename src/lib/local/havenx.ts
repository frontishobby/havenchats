/**
 * `.havenx` — Haven 캐릭터 패키지(파일 하나에 캐릭터 + 에셋 + 선택적으로 대화 기록). 정본 스펙: docs/HAVENX.md
 *
 * charx 가 RisuAI 카드를 담듯, havenx 는 Haven 고유 구조를 **무손실**로 담는다:
 * 시스템 프롬프트·오프닝·로어북·장면 이미지(grid 축×조합 / named)·썸네일(1024)·상세 이미지(2048)·
 * 추천 그림체·(선택) 채팅 세션과 메시지·실시간 생성 이미지.
 *
 * 컨테이너 = zip. 첫 엔트리가 `manifest.json`(권장 — 가져오기가 스트리밍으로 바로 저장할 수 있음),
 * 나머지는 manifest 가 가리키는 이미지 파일(경로 자유, 관례는 `assets/…`).
 * 가져오면 **항상 새 캐릭터·새 세션 id** 를 발급한다(같은 파일을 두 번 가져오면 사본 2개).
 * 장면 이미지 엔트리 id 는 그대로 유지 → 메시지 안의 고정 토큰 `{#entryId}` 가 그대로 맞는다.
 * 그림체는 원래 id 를 유지해 같은 기기에 이미 있으면 재사용(중복 생성 안 함).
 *
 * 내보내기/가져오기 모두 브라우저 런타임(D1/R2 shim)을 직접 쓴다 — Hono 라우트를 거치지 않는 건
 * 이미지 수천 장을 스트리밍으로 흘리기 위해서(backup.ts 와 같은 방식).
 */
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { getLocalRuntime } from './runtime';
import { guessType, openSaveSink } from './backup';
import { getLocalSceneBlob, localSceneKey } from '$lib/import/localImages';
import type { DisplayScript, ImageAxis, LoreEntry, Opening } from '$lib/types';

export const HAVENX_FORMAT = 'havenx';
export const HAVENX_VERSION = 1;
const MANIFEST = 'manifest.json';

// ── 포맷 타입 ────────────────────────────────────────────────────

export interface HavenxGridScenes {
	kind: 'grid';
	axes: ImageAxis[];
	entries: { id: string; combo: number[]; file: string }[];
}
export interface HavenxNamedScenes {
	kind: 'named';
	images: { id: string; name: string; file: string }[];
}

export interface HavenxCharacter {
	name: string;
	tagline: string;
	intro: string;
	/** 시스템 프롬프트 본문. */
	description: string;
	audience: 'all' | 'male' | 'female';
	contentRating: 'sfw' | 'nsfw';
	tags: string[];
	greetings: Opening[];
	lorebook: { entries: LoreEntry[] } | null;
	scriptData: { defaultVariables?: Record<string, string> } | null;
	displayScripts: DisplayScript[] | null;
	/** charx 에서 온 캐릭터(프롬프트 숨김·수정 불가) 여부. 손으로 만든 패키지는 false. */
	imported: boolean;
	/** zip 안 경로. 없으면 기본 아바타. */
	thumbnail: string | null;
	fullImage: string | null;
	scenes: HavenxGridScenes | HavenxNamedScenes | null;
}

export interface HavenxStyle {
	id: string;
	title: string;
	memo: string | null;
	prompt: string;
	model: string;
	negative: string | null;
	quality: string | null;
	thumbnail: string | null;
}

export interface HavenxMessage {
	seq: number;
	role: 'user' | 'assistant' | 'image_generation';
	/** image_generation 이면 무시(이미지는 `image`). */
	content: string;
	image?: string;
	inputTokens?: number | null;
	cost?: number | null;
	model?: string | null;
	targetSentences?: number | null;
	createdAt: number;
}

export interface HavenxSession {
	model: string | null;
	summary: string | null;
	summaryUptoSeq: number;
	memory: string | null;
	scriptState: Record<string, string> | null;
	appearances: unknown;
	outfits: unknown;
	createdAt: number;
	updatedAt: number;
	lastMessageAt: number | null;
	messages: HavenxMessage[];
}

export interface HavenxManifest {
	format: typeof HAVENX_FORMAT;
	version: number;
	exportedAt: number;
	generator?: string;
	character: HavenxCharacter;
	style?: HavenxStyle | null;
	sessions?: HavenxSession[];
}

export interface HavenxProgress {
	phase: string;
	done: number;
	total: number;
}

// ── 공용 유틸 ────────────────────────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const IMAGE_EXT = new Set(['webp', 'avif', 'png', 'jpg', 'jpeg', 'gif']);

function extOf(path: string): string | null {
	const e = path.split('.').pop()?.toLowerCase() ?? '';
	if (!IMAGE_EXT.has(e)) return null;
	return e === 'jpeg' ? 'jpg' : e;
}

function parseJson<T>(s: string | null | undefined): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

function str(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function safeFileName(name: string): string {
	return (name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'character').slice(0, 60);
}

// ── 내보내기 ─────────────────────────────────────────────────────

interface CharRow {
	id: string;
	name: string;
	tagline: string;
	intro: string;
	description: string;
	thumbnail_key: string | null;
	full_image_key: string | null;
	audience: string;
	content_rating: string;
	tags: string;
	greetings: string;
	image_set: string | null;
	lorebook: string | null;
	script_data: string | null;
	display_scripts: string | null;
	imported: number;
	recommended_style_id: string | null;
}

/** 내보낼 파일 하나 — zip 경로 + 바이트 로더. */
interface AssetSource {
	path: string;
	load: () => Promise<Blob | null>;
}

/** 이 캐릭터의 세션 수(내보내기 UI 의 '대화 포함' 옆 표시용). */
export async function countSessions(characterId: string): Promise<number> {
	const row = await getLocalRuntime()
		.d1.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE character_id = ?')
		.bind(characterId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * 캐릭터 하나를 .havenx 로 내려받는다. 사용자 클릭 핸들러에서 바로 불러야 한다(저장 대화상자).
 * 반환: 쓴 바이트 수와 원본을 못 찾아 빠진 이미지 수(OneDrive 미연결로 지연 다운로드 실패 등).
 */
export async function exportHavenx(
	characterId: string,
	opts: { includeSessions: boolean },
	onProgress?: (p: HavenxProgress) => void
): Promise<{ bytes: number; missing: number }> {
	const rt = getLocalRuntime();
	const d1 = rt.d1;
	const row = await d1
		.prepare('SELECT * FROM characters WHERE id = ?')
		.bind(characterId)
		.first<CharRow>();
	if (!row) throw new Error('캐릭터를 찾을 수 없어요.');

	const { sink, finalize } = await openSaveSink(
		`${safeFileName(row.name)}.havenx`,
		'application/zip',
		'.havenx'
	);

	const assets: AssetSource[] = [];
	const r2Asset = (path: string, key: string): AssetSource => ({
		path,
		load: async () => (await rt.r2.get(key))?.blob() ?? null
	});

	// 썸네일·상세 이미지
	let thumbnail: string | null = null;
	if (row.thumbnail_key) {
		const ext = extOf(row.thumbnail_key) ?? 'webp';
		thumbnail = `assets/thumbnail.${ext}`;
		assets.push(r2Asset(thumbnail, row.thumbnail_key));
	}
	let fullImage: string | null = null;
	if (row.full_image_key) {
		const ext = extOf(row.full_image_key) ?? 'webp';
		fullImage = `assets/full.${ext}`;
		assets.push(r2Asset(fullImage, row.full_image_key));
	}

	// 장면 이미지 — storage:'local'(charx import 직후)은 haven-local-scenes, 그 외는 R2 shim.
	type RawSet = {
		kind?: string;
		axes?: ImageAxis[];
		entries?: { id: string; combo: number[]; ext: string }[];
		images?: { id: string; name: string; ext: string }[];
		storage?: string;
	};
	const set = parseJson<RawSet>(row.image_set);
	const sceneAsset = (id: string, ext: string): AssetSource => {
		const path = `assets/scenes/${id}.${ext}`;
		if (set?.storage === 'local') {
			return { path, load: () => getLocalSceneBlob(localSceneKey(characterId, id)) };
		}
		return r2Asset(path, `charimg/${characterId}/${id}.${ext}`);
	};
	let scenes: HavenxCharacter['scenes'] = null;
	if (set && set.kind === 'named' && Array.isArray(set.images)) {
		scenes = {
			kind: 'named',
			images: set.images.map((i) => {
				const a = sceneAsset(i.id, i.ext);
				assets.push(a);
				return { id: i.id, name: i.name, file: a.path };
			})
		};
	} else if (set && Array.isArray(set.axes) && Array.isArray(set.entries)) {
		scenes = {
			kind: 'grid',
			axes: set.axes,
			entries: set.entries.map((e) => {
				const a = sceneAsset(e.id, e.ext);
				assets.push(a);
				return { id: e.id, combo: e.combo, file: a.path };
			})
		};
	}

	// 추천 그림체
	let style: HavenxStyle | null = null;
	if (row.recommended_style_id) {
		const s = await d1
			.prepare('SELECT * FROM art_styles WHERE id = ?')
			.bind(row.recommended_style_id)
			.first<{
				id: string;
				title: string;
				memo: string | null;
				prompt: string;
				model: string;
				negative: string | null;
				quality: string | null;
				thumbnail_key: string | null;
			}>();
		if (s) {
			let thumb: string | null = null;
			if (s.thumbnail_key) {
				thumb = `assets/style.${extOf(s.thumbnail_key) ?? 'webp'}`;
				assets.push(r2Asset(thumb, s.thumbnail_key));
			}
			style = {
				id: s.id,
				title: s.title,
				memo: s.memo,
				prompt: s.prompt,
				model: s.model,
				negative: s.negative,
				quality: s.quality,
				thumbnail: thumb
			};
		}
	}

	// 채팅 세션(선택)
	const sessions: HavenxSession[] = [];
	if (opts.includeSessions) {
		const { results: srows } = await d1
			.prepare('SELECT * FROM chat_sessions WHERE character_id = ? ORDER BY created_at')
			.bind(characterId)
			.all<{
				id: string;
				model: string | null;
				summary: string | null;
				summary_upto_seq: number;
				memory: string | null;
				script_state: string | null;
				appearances: string | null;
				outfits: string | null;
				created_at: number;
				updated_at: number;
				last_message_at: number | null;
			}>();
		for (const [si, s] of (srows ?? []).entries()) {
			const { results: mrows } = await d1
				.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq')
				.bind(s.id)
				.all<{
					id: string;
					seq: number;
					role: HavenxMessage['role'];
					content: string;
					input_tokens: number | null;
					cost: number | null;
					model: string | null;
					target_sentences: number | null;
					created_at: number;
				}>();
			const messages: HavenxMessage[] = (mrows ?? []).map((m) => {
				const msg: HavenxMessage = {
					seq: m.seq,
					role: m.role,
					content: m.role === 'image_generation' ? '' : m.content,
					inputTokens: m.input_tokens,
					cost: m.cost,
					model: m.model,
					targetSentences: m.target_sentences,
					createdAt: m.created_at
				};
				if (m.role === 'image_generation' && m.content) {
					const path = `assets/sessions/${si + 1}/${m.seq}.${extOf(m.content) ?? 'webp'}`;
					msg.image = path;
					assets.push(r2Asset(path, m.content));
				}
				return msg;
			});
			sessions.push({
				model: s.model,
				summary: s.summary,
				summaryUptoSeq: s.summary_upto_seq ?? 0,
				memory: s.memory,
				scriptState: parseJson(s.script_state),
				appearances: parseJson(s.appearances),
				outfits: parseJson(s.outfits),
				createdAt: s.created_at,
				updatedAt: s.updated_at,
				lastMessageAt: s.last_message_at,
				messages
			});
		}
	}

	const manifest: HavenxManifest = {
		format: HAVENX_FORMAT,
		version: HAVENX_VERSION,
		exportedAt: Date.now(),
		generator: 'havenchats.com',
		character: {
			name: row.name,
			tagline: row.tagline,
			intro: row.intro ?? '',
			description: row.description,
			audience: row.audience === 'male' || row.audience === 'female' ? row.audience : 'all',
			contentRating: row.content_rating === 'nsfw' ? 'nsfw' : 'sfw',
			tags: parseJson<string[]>(row.tags) ?? [],
			greetings: parseJson<Opening[]>(row.greetings) ?? [],
			lorebook: parseJson(row.lorebook),
			scriptData: parseJson(row.script_data),
			displayScripts: parseJson(row.display_scripts),
			imported: row.imported === 1,
			thumbnail,
			fullImage,
			scenes
		},
		style,
		...(opts.includeSessions ? { sessions } : {})
	};

	// zip 스트리밍 — manifest 를 첫 엔트리로(가져오기가 이미지를 버퍼링 없이 바로 저장).
	let written = 0;
	let pendingWrite: Promise<void> = Promise.resolve();
	let zipError: Error | null = null;
	const zip = new Zip((err, chunk, final) => {
		if (err) {
			zipError = err;
			return;
		}
		written += chunk.length;
		pendingWrite = pendingWrite.then(() => sink.write(chunk));
		if (final) pendingWrite = pendingWrite.then(() => sink.close());
	});
	const mf = new ZipDeflate(MANIFEST, { level: 6 });
	zip.add(mf);
	mf.push(new TextEncoder().encode(JSON.stringify(manifest, null, '\t')), true);

	let missing = 0;
	let n = 0;
	for (const a of assets) {
		const blob = await a.load().catch(() => null);
		n++;
		if (n % 10 === 0 || n === assets.length)
			onProgress?.({ phase: '이미지', done: n, total: assets.length });
		if (!blob) {
			missing++;
			continue; // 가져오기 쪽이 파일 없는 참조를 걸러낸다
		}
		const f = new ZipPassThrough(a.path); // 이미지는 이미 압축돼 있음
		zip.add(f);
		f.push(new Uint8Array(await blob.arrayBuffer()), true);
		await pendingWrite; // 백프레셔
		if (zipError) throw zipError;
	}
	zip.end();
	await pendingWrite;
	if (zipError) throw zipError;
	await finalize();
	return { bytes: written, missing };
}

// ── 검증(가져오기) ────────────────────────────────────────────────

/** manifest 를 검증·정규화한다. 손으로 만든 패키지를 위해 관대하게 받는다(누락 필드는 기본값). */
export function normalizeManifest(raw: unknown): HavenxManifest {
	const m = (raw ?? {}) as Record<string, unknown>;
	if (m.format !== HAVENX_FORMAT) throw new Error('havenx 파일이 아니에요(manifest.format).');
	const version = num(m.version) ?? 0;
	if (version < 1 || version > HAVENX_VERSION)
		throw new Error(`지원하지 않는 havenx 버전이에요(v${version}). 앱을 새로고침해 주세요.`);
	const c = (m.character ?? {}) as Record<string, unknown>;
	const name = str(c.name).trim();
	if (!name) throw new Error('캐릭터 이름이 없어요.');

	const greetings: Opening[] = (Array.isArray(c.greetings) ? c.greetings : [])
		.map((g: unknown) =>
			typeof g === 'string'
				? { name: '', content: g }
				: { name: str((g as Opening)?.name), content: str((g as Opening)?.content) }
		)
		.filter((g) => g.content.trim());

	const loreRaw = (c.lorebook as { entries?: unknown } | null)?.entries;
	const loreEntries: LoreEntry[] = (Array.isArray(loreRaw) ? loreRaw : [])
		.map((e: unknown) => {
			const o = (e ?? {}) as Record<string, unknown>;
			return {
				id: SAFE_ID.test(str(o.id)) ? str(o.id) : crypto.randomUUID(),
				keys: (Array.isArray(o.keys) ? o.keys : []).filter(
					(k): k is string => typeof k === 'string' && k.trim() !== ''
				),
				content: str(o.content),
				constant: o.constant === true,
				order: num(o.order) ?? 0
			};
		})
		.filter((e) => e.content.trim() && (e.constant || e.keys.length > 0));

	let scenes: HavenxCharacter['scenes'] = null;
	const sc = (c.scenes ?? null) as Record<string, unknown> | null;
	if (sc && sc.kind === 'named' && Array.isArray(sc.images)) {
		const images = sc.images
			.map((i: unknown) => {
				const o = (i ?? {}) as Record<string, unknown>;
				return {
					id: SAFE_ID.test(str(o.id)) ? str(o.id) : crypto.randomUUID(),
					name: str(o.name).trim(),
					file: str(o.file)
				};
			})
			.filter((i) => i.name && extOf(i.file));
		if (images.length) scenes = { kind: 'named', images };
	} else if (sc && sc.kind === 'grid' && Array.isArray(sc.axes) && Array.isArray(sc.entries)) {
		const axes: ImageAxis[] = sc.axes
			.map((a: unknown) => {
				const o = (a ?? {}) as Record<string, unknown>;
				const values = (Array.isArray(o.values) ? o.values : []).filter(
					(v): v is string => typeof v === 'string'
				);
				const fb = num(o.fallback);
				return {
					label: str(o.label),
					values,
					...(fb !== null && fb >= 0 && fb < values.length ? { fallback: fb } : {})
				};
			})
			.filter((a) => a.label && a.values.length);
		const entries = sc.entries
			.map((e: unknown) => {
				const o = (e ?? {}) as Record<string, unknown>;
				return {
					id: SAFE_ID.test(str(o.id)) ? str(o.id) : crypto.randomUUID(),
					combo: (Array.isArray(o.combo) ? o.combo : []).filter(
						(n): n is number => typeof n === 'number'
					),
					file: str(o.file)
				};
			})
			.filter(
				(e) =>
					extOf(e.file) &&
					e.combo.length === axes.length &&
					e.combo.every((vi, ai) => Number.isInteger(vi) && vi >= 0 && vi < axes[ai].values.length)
			);
		if (axes.length && entries.length) scenes = { kind: 'grid', axes, entries };
	}

	const filePath = (v: unknown) => (extOf(str(v)) ? str(v) : null);

	const character: HavenxCharacter = {
		name: name.slice(0, 80),
		tagline: str(c.tagline),
		intro: str(c.intro),
		description: str(c.description),
		audience: c.audience === 'male' || c.audience === 'female' ? c.audience : 'all',
		contentRating: c.contentRating === 'nsfw' ? 'nsfw' : 'sfw',
		tags: (Array.isArray(c.tags) ? c.tags : []).filter((t): t is string => typeof t === 'string'),
		greetings,
		lorebook: loreEntries.length ? { entries: loreEntries } : null,
		scriptData:
			c.scriptData && typeof c.scriptData === 'object'
				? (c.scriptData as HavenxCharacter['scriptData'])
				: null,
		displayScripts: Array.isArray(c.displayScripts)
			? (c.displayScripts as DisplayScript[]).filter(
					(s) => typeof s?.in === 'string' && typeof s?.out === 'string'
				)
			: null,
		imported: c.imported === true,
		thumbnail: filePath(c.thumbnail),
		fullImage: filePath(c.fullImage),
		scenes
	};

	let style: HavenxStyle | null = null;
	const s = (m.style ?? null) as Record<string, unknown> | null;
	if (s && str(s.prompt).trim() && str(s.title).trim()) {
		style = {
			id: SAFE_ID.test(str(s.id)) ? str(s.id) : crypto.randomUUID(),
			title: str(s.title),
			memo: typeof s.memo === 'string' ? s.memo : null,
			prompt: str(s.prompt),
			model: str(s.model, 'nai-diffusion-4-5-full') || 'nai-diffusion-4-5-full',
			negative: typeof s.negative === 'string' ? s.negative : null,
			quality: typeof s.quality === 'string' ? s.quality : null,
			thumbnail: filePath(s.thumbnail)
		};
	}

	const sessions: HavenxSession[] = (Array.isArray(m.sessions) ? m.sessions : []).map(
		(x: unknown) => {
			const o = (x ?? {}) as Record<string, unknown>;
			const msgs = (Array.isArray(o.messages) ? o.messages : [])
				.map((mm: unknown, i: number) => {
					const q = (mm ?? {}) as Record<string, unknown>;
					const role =
						q.role === 'user' || q.role === 'image_generation' ? q.role : ('assistant' as const);
					return {
						seq: num(q.seq) ?? i + 1,
						role,
						content: str(q.content),
						...(filePath(q.image) ? { image: filePath(q.image)! } : {}),
						inputTokens: num(q.inputTokens),
						cost: num(q.cost),
						model: typeof q.model === 'string' ? q.model : null,
						targetSentences: num(q.targetSentences),
						createdAt: num(q.createdAt) ?? Date.now()
					} as HavenxMessage;
				})
				.filter((q) => (q.role === 'image_generation' ? !!q.image : q.content.trim() !== ''));
			const now = Date.now();
			return {
				model: typeof o.model === 'string' ? o.model : null,
				summary: typeof o.summary === 'string' ? o.summary : null,
				summaryUptoSeq: num(o.summaryUptoSeq) ?? 0,
				memory: typeof o.memory === 'string' ? o.memory : null,
				scriptState:
					o.scriptState && typeof o.scriptState === 'object'
						? (o.scriptState as Record<string, string>)
						: null,
				appearances: o.appearances ?? null,
				outfits: o.outfits ?? null,
				createdAt: num(o.createdAt) ?? now,
				updatedAt: num(o.updatedAt) ?? now,
				lastMessageAt: num(o.lastMessageAt) ?? (msgs.length ? msgs[msgs.length - 1].createdAt : null),
				messages: msgs
			};
		}
	);

	return {
		format: HAVENX_FORMAT,
		version,
		exportedAt: num(m.exportedAt) ?? 0,
		generator: typeof m.generator === 'string' ? m.generator : undefined,
		character,
		style,
		sessions: sessions.filter((s) => s.messages.length > 0)
	};
}

// ── zip 읽기 ─────────────────────────────────────────────────────

/**
 * zip 을 스트리밍으로 읽어 엔트리마다 콜백. manifest 가 먼저 오면 이미지를 즉시 처리하고,
 * 뒤에 오면(손으로 묶은 zip) 그때까지 버퍼링했다가 넘긴다. `stopWhen` 이 true 면 나머지는 읽지 않는다.
 */
async function readZip(
	file: Blob,
	onManifest: (raw: unknown) => void | Promise<void>,
	onFile: (path: string, data: Uint8Array) => Promise<void>,
	opts: { stopWhen?: () => boolean; onRead?: (read: number, total: number) => void } = {}
): Promise<void> {
	let manifestSeen = false;
	const buffered: [string, Uint8Array][] = [];
	let chain: Promise<void> = Promise.resolve();
	let failure: Error | null = null;

	const unzip = new Unzip((entry) => {
		const name = entry.name.replace(/^\.?\//, '');
		if (name.endsWith('/')) return;
		const isManifest = name === MANIFEST;
		if (!isManifest && !extOf(name)) return; // 관심 없는 엔트리
		const parts: Uint8Array[] = [];
		entry.ondata = (err, chunk, final) => {
			if (err) {
				failure ??= err;
				return;
			}
			parts.push(chunk);
			if (!final) return;
			const data = concat(parts);
			chain = chain.then(async () => {
				if (isManifest) {
					let raw: unknown;
					try {
						raw = JSON.parse(new TextDecoder().decode(data));
					} catch {
						throw new Error('manifest.json 을 읽지 못했어요.');
					}
					await onManifest(raw);
					manifestSeen = true;
					for (const [p, d] of buffered.splice(0)) await onFile(p, d);
				} else if (manifestSeen) {
					await onFile(name, data);
				} else {
					buffered.push([name, data]);
				}
			});
			chain.catch((e) => (failure ??= e));
		};
		entry.start();
	});
	unzip.register(UnzipPassThrough);
	unzip.register(UnzipInflate);

	const reader = file.stream().getReader();
	let read = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			unzip.push(value, false);
			read += value.byteLength;
			opts.onRead?.(read, file.size);
			await chain;
			if (failure) throw failure;
			if (opts.stopWhen?.()) return;
		}
		unzip.push(new Uint8Array(0), true);
		await chain;
		if (failure) throw failure;
		if (!manifestSeen) throw new Error('zip 안에 manifest.json 이 없어요. havenx 파일이 맞나요?');
	} finally {
		reader.cancel().catch(() => {});
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0];
	const total = parts.reduce((a, p) => a + p.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out;
}

/** 미리보기 — manifest 와 썸네일만 읽는다(보통 zip 앞부분). */
export async function peekHavenx(
	file: Blob
): Promise<{ manifest: HavenxManifest; thumbnail: Blob | null }> {
	let manifest: HavenxManifest | null = null;
	let thumbnail: Blob | null = null;
	await readZip(
		file,
		(raw) => {
			manifest = normalizeManifest(raw);
		},
		async (path, data) => {
			if (manifest && path === manifest.character.thumbnail)
				thumbnail = new Blob([data as BlobPart], { type: guessType(path) });
		},
		{ stopWhen: () => !!manifest && (!manifest.character.thumbnail || !!thumbnail) }
	);
	if (!manifest) throw new Error('manifest.json 이 없어요.');
	return { manifest, thumbnail };
}

// ── 가져오기 ─────────────────────────────────────────────────────

export interface HavenxImportResult {
	characterId: string;
	name: string;
	images: number;
	missing: number;
	sessions: number;
	styleReused: boolean;
}

/**
 * .havenx 를 가져와 새 캐릭터(+그림체·세션)를 만든다. 이미지는 R2 shim 에 바로 저장되므로
 * OneDrive 모드면 동기화 대기열에 자동으로 오른다(DB 쓰기도 dirty → push).
 */
export async function importHavenx(
	file: Blob,
	opts: { includeSessions: boolean } = { includeSessions: true },
	onProgress?: (p: HavenxProgress) => void
): Promise<HavenxImportResult> {
	const rt = getLocalRuntime();
	const cid = crypto.randomUUID();

	let manifest: HavenxManifest | null = null;
	/** zip 경로 → 저장할 R2 키. 같은 파일을 여러 곳이 가리킬 수 있다. */
	const targets = new Map<string, string[]>();
	const written = new Set<string>(); // 저장에 성공한 R2 키
	const putKeys: string[] = [];
	let styleExists = false;
	const sessionIds: string[] = [];
	const msgIds: string[][] = [];

	const want = (path: string | null | undefined, key: string) => {
		if (!path) return;
		const list = targets.get(path) ?? [];
		list.push(key);
		targets.set(path, list);
	};

	let images = 0;
	try {
		await readZip(
			file,
			async (raw) => {
				const m = normalizeManifest(raw);
				if (!opts.includeSessions) m.sessions = [];
				manifest = m;
				const ch = m.character;
				if (ch.thumbnail) want(ch.thumbnail, `char/${cid}.${extOf(ch.thumbnail)}`);
				if (ch.fullImage) want(ch.fullImage, `charfull/${cid}.${extOf(ch.fullImage)}`);
				if (ch.scenes?.kind === 'grid')
					for (const e of ch.scenes.entries) want(e.file, `charimg/${cid}/${e.id}.${extOf(e.file)}`);
				else if (ch.scenes?.kind === 'named')
					for (const i of ch.scenes.images) want(i.file, `charimg/${cid}/${i.id}.${extOf(i.file)}`);
				if (m.style) {
					const ex = await rt.d1
						.prepare('SELECT id FROM art_styles WHERE id = ?')
						.bind(m.style.id)
						.first<{ id: string }>();
					styleExists = !!ex;
					if (!styleExists && m.style.thumbnail)
						want(m.style.thumbnail, `style/${m.style.id}.${extOf(m.style.thumbnail)}`);
				}
				for (const s of m.sessions ?? []) {
					const sid = crypto.randomUUID();
					sessionIds.push(sid);
					const ids = s.messages.map(() => crypto.randomUUID());
					msgIds.push(ids);
					s.messages.forEach((msg, i) => {
						if (msg.role === 'image_generation' && msg.image)
							want(msg.image, `chatimg/${sid}/${ids[i]}.${extOf(msg.image)}`);
					});
				}
				onProgress?.({ phase: '이미지', done: 0, total: targets.size });
			},
			async (path, data) => {
				const keys = targets.get(path);
				if (!keys) return;
				const contentType = guessType(path);
				for (const key of keys) {
					await rt.r2.put(key, data, { httpMetadata: { contentType } });
					written.add(key);
					putKeys.push(key);
				}
				images++;
				if (images % 10 === 0) onProgress?.({ phase: '이미지', done: images, total: targets.size });
			},
			{ onRead: (read, total) => !manifest && onProgress?.({ phase: '읽는 중', done: read, total }) }
		);
		if (!manifest) throw new Error('manifest.json 이 없어요.');
		const m: HavenxManifest = manifest;
		const ch = m.character;

		onProgress?.({ phase: 'DB 저장', done: 0, total: 0 });
		const ok = (key: string) => written.has(key);
		const thumbKey = ch.thumbnail ? `char/${cid}.${extOf(ch.thumbnail)}` : null;
		const fullKey = ch.fullImage ? `charfull/${cid}.${extOf(ch.fullImage)}` : null;

		// 실제로 저장된 이미지만 세트에 남긴다(깨진 참조 방지).
		let imageSet: unknown = null;
		if (ch.scenes?.kind === 'grid') {
			const entries = ch.scenes.entries
				.map((e) => ({ id: e.id, combo: e.combo, ext: extOf(e.file)! }))
				.filter((e) => ok(`charimg/${cid}/${e.id}.${e.ext}`));
			if (entries.length) imageSet = { kind: 'grid', axes: ch.scenes.axes, entries };
		} else if (ch.scenes?.kind === 'named') {
			const imgs = ch.scenes.images
				.map((i) => ({ id: i.id, name: i.name, ext: extOf(i.file)! }))
				.filter((i) => ok(`charimg/${cid}/${i.id}.${i.ext}`));
			if (imgs.length) imageSet = { kind: 'named', images: imgs };
		}

		const now = Date.now();
		const d1 = rt.d1;
		const userId = rt.userId;
		const stmts = [];

		let styleId: string | null = null;
		if (m.style) {
			styleId = m.style.id;
			if (!styleExists) {
				const sk = m.style.thumbnail ? `style/${m.style.id}.${extOf(m.style.thumbnail)}` : null;
				stmts.push(
					d1
						.prepare(
							`INSERT INTO art_styles (id, creator_id, title, memo, prompt, model, negative, quality, thumbnail_key, shared, created_at, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
						)
						.bind(
							m.style.id,
							userId,
							m.style.title,
							m.style.memo,
							m.style.prompt,
							m.style.model,
							m.style.negative,
							m.style.quality,
							sk && ok(sk) ? sk : null,
							now,
							now
						)
				);
			}
		}

		stmts.push(
			d1
				.prepare(
					`INSERT INTO characters
					   (id, creator_id, name, tagline, intro, description, thumbnail_key, full_image_key, audience, content_rating, visibility, tags, greetings, image_set, lorebook, script_data, display_scripts, imported, recommended_style_id, chats, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
				)
				.bind(
					cid,
					userId,
					ch.name,
					ch.tagline,
					ch.intro,
					ch.description,
					thumbKey && ok(thumbKey) ? thumbKey : null,
					fullKey && ok(fullKey) ? fullKey : null,
					ch.audience,
					ch.contentRating,
					JSON.stringify(ch.tags),
					JSON.stringify(ch.greetings),
					imageSet ? JSON.stringify(imageSet) : null,
					ch.lorebook ? JSON.stringify(ch.lorebook) : null,
					ch.scriptData ? JSON.stringify(ch.scriptData) : null,
					ch.displayScripts?.length ? JSON.stringify(ch.displayScripts) : null,
					ch.imported ? 1 : 0,
					styleId,
					now,
					now
				)
		);

		const sessions = m.sessions ?? [];
		sessions.forEach((s, si) => {
			const sid = sessionIds[si];
			const kept = s.messages
				.map((msg, i) => ({ msg, id: msgIds[si][i] }))
				.filter(
					({ msg, id }) =>
						msg.role !== 'image_generation' || ok(`chatimg/${sid}/${id}.${extOf(msg.image!)}`)
				);
			const maxSeq = kept.reduce((a, { msg }) => Math.max(a, msg.seq), 0);
			stmts.push(
				d1
					.prepare(
						`INSERT INTO chat_sessions
						   (id, user_id, character_id, model, summary, summary_upto_seq, memory, script_state, appearances, outfits, message_count, created_at, updated_at, last_message_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						sid,
						userId,
						cid,
						s.model,
						s.summary,
						s.summaryUptoSeq,
						s.memory,
						s.scriptState ? JSON.stringify(s.scriptState) : null,
						s.appearances ? JSON.stringify(s.appearances) : null,
						s.outfits ? JSON.stringify(s.outfits) : null,
						maxSeq,
						s.createdAt,
						s.updatedAt,
						s.lastMessageAt
					)
			);
			const seen = new Set<number>();
			for (const { msg, id } of kept) {
				if (seen.has(msg.seq)) continue; // unique(session_id, seq)
				seen.add(msg.seq);
				const content =
					msg.role === 'image_generation' ? `chatimg/${sid}/${id}.${extOf(msg.image!)}` : msg.content;
				stmts.push(
					d1
						.prepare(
							`INSERT INTO chat_messages (id, session_id, seq, role, content, token_est, input_tokens, cost, model, target_sentences, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
						)
						.bind(
							id,
							sid,
							msg.seq,
							msg.role,
							content,
							msg.role === 'image_generation' ? 0 : Math.ceil(content.length / 2),
							msg.inputTokens ?? null,
							msg.cost ?? null,
							msg.model ?? null,
							msg.targetSentences ?? null,
							msg.createdAt
						)
				);
			}
		});

		await d1.batch(stmts);
		await rt.flush();

		return {
			characterId: cid,
			name: ch.name,
			images,
			missing: [...targets.values()].flat().filter((k) => !written.has(k)).length,
			sessions: sessions.length,
			styleReused: styleExists
		};
	} catch (e) {
		// 실패 시 이번에 넣은 이미지 정리(DB 는 batch 트랜잭션이라 남지 않음).
		if (putKeys.length) await rt.r2.delete(putKeys).catch(() => {});
		throw e;
	}
}
