import { Hono } from 'hono';
import type { AppEnv } from '../../context';
import { requireUser } from '../../context';
import { requireAdmin } from '$lib/server/auth';
import { createCharacter, getCharacterOwnership, updateImageSet } from '$lib/server/db/characters';
import { parseImportMeta, assignImageIds, IMPORT_IMAGE_MAX_BYTES } from '$lib/server/importCharx';
import { IMPORT_IMAGE_EXT } from '$lib/import/cardToCharacter';
import { NAMED_LIMITS } from '$lib/imageCodes';
import { getDecryptedKey } from '$lib/server/db/userKeys';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import type { NamedImage } from '$lib/types';

export const importRouter = new Hono<AppEnv>();

// ── charx import — ① 생성 단계 ─────────────────────────────────
/**
 * 클라가 zip 을 풀어 매핑한 메타 + 썸네일 + 이미지 manifest(name/ext) 를 받는다.
 * 캐릭터 행을 **비공개·image_set=null** 로 만들고, 각 이미지에 불변 id 를 할당해 돌려준다.
 * 이후 클라는 /assets 로 배치 업로드 → /finalize 로 image_set 확정.
 */
importRouter.post('/charx', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email); // charx import 는 관리자 전용

	const db = c.env.DB;
	const bucket = c.env.IMAGES;
	if (!db || !bucket) return c.json({ error: 'storage unavailable' }, 500);

	const form = await c.req.formData();

	let metaRaw: unknown;
	let manifestRaw: unknown;
	try {
		metaRaw = JSON.parse(String(form.get('meta') ?? '{}'));
		manifestRaw = JSON.parse(String(form.get('manifest') ?? '[]'));
	} catch {
		return c.json({ error: '요청 형식이 올바르지 않아요.' }, 400);
	}

	const meta = parseImportMeta(metaRaw);
	if (!meta.ok) return c.json({ error: meta.error }, 400);

	const images = assignImageIds(manifestRaw);

	// 썸네일(필수).
	const thumb = form.get('thumbnail');
	if (!(thumb instanceof File) || thumb.size === 0)
		return c.json({ error: '썸네일 이미지가 필요해요.' }, 400);
	const thumbExt =
		IMPORT_IMAGE_EXT[(thumb.type.split('/')[1] ?? '').toLowerCase()] ??
		IMPORT_IMAGE_EXT[(thumb.name.split('.').pop() ?? '').toLowerCase()];
	if (!thumbExt) return c.json({ error: '지원하지 않는 썸네일 형식이에요.' }, 400);

	const id = crypto.randomUUID();
	const thumbKey = `char/${id}.${thumbExt}`;
	await bucket.put(thumbKey, await thumb.arrayBuffer(), {
		httpMetadata: { contentType: thumb.type || `image/${thumbExt}` }
	});

	try {
		await createCharacter(db, {
			id,
			creatorId: user.id,
			name: meta.data.name,
			tagline: meta.data.tagline,
			intro: meta.data.intro,
			description: meta.data.description,
			thumbnailKey: thumbKey,
			audience: meta.data.audience,
			contentRating: meta.data.contentRating,
			visibility: 'private', // charx 캐릭터는 영구 비공개(공개 불가)
			tags: meta.data.tags,
			greetings: meta.data.greetings,
			imageSet: null, // 이미지 업로드 후 /finalize 에서 확정
			lorebook: meta.data.lorebook,
			scriptData: meta.data.scriptData,
			displayScripts: meta.data.displayScripts,
			imported: true // 프롬프트 숨김·비공개·수정 불가
		});
	} catch (e) {
		await bucket.delete(thumbKey).catch(() => {});
		console.error('[import] create failed:', e);
		return c.json({ error: '캐릭터 생성에 실패했어요.' }, 500);
	}

	return c.json({ id, images });
});

// ── charx import — ② 장면 이미지 배치 업로드 ───────────────────
/**
 * `img:<imageId>.<ext>` 폼 필드를 charimg/<cid>/<imageId>.<ext> 로 적재.
 * '기기간 공유'(promote)에서 로컬(IndexedDB) 이미지를 R2 로 올릴 때 사용한다.
 * (charx 최초 import 는 더 이상 R2 에 올리지 않고 IndexedDB 에 저장한다.)
 * 클라가 메모리/서브리퀘스트 한계를 고려해 배치(수십 장)로 나눠 여러 번 호출한다.
 * 배치 안의 put 은 병렬로 처리한다. 소유자(creator) 본인만 가능.
 */
importRouter.post('/charx/:id/assets', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email); // charx import 는 관리자 전용

	const db = c.env.DB;
	const bucket = c.env.IMAGES;
	if (!db || !bucket) return c.json({ error: 'storage unavailable' }, 500);

	const cid = c.req.param('id');
	const own = await getCharacterOwnership(db, cid);
	if (!own) return c.json({ error: 'not found' }, 404);
	if (own.creatorId !== user.id) return c.json({ error: 'forbidden' }, 403);

	const form = await c.req.formData();
	const uploaded: string[] = [];
	const failed: string[] = [];

	// 배치 안의 put 을 병렬로(직렬 await 제거 → 업로드 체감 속도 개선).
	const tasks: Promise<void>[] = [];
	for (const [field, value] of form.entries()) {
		if (!field.startsWith('img:') || !(value instanceof File)) continue;
		// field = "img:<id>.<ext>"
		const spec = field.slice(4);
		const dot = spec.lastIndexOf('.');
		const id = dot >= 0 ? spec.slice(0, dot) : spec;
		const ext = IMPORT_IMAGE_EXT[(dot >= 0 ? spec.slice(dot + 1) : '').toLowerCase()];
		if (!id || !ext) {
			failed.push(id || spec);
			continue;
		}
		if (value.size === 0 || value.size > IMPORT_IMAGE_MAX_BYTES) {
			failed.push(id);
			continue;
		}
		tasks.push(
			(async () => {
				try {
					await bucket.put(`charimg/${cid}/${id}.${ext}`, await value.arrayBuffer(), {
						httpMetadata: { contentType: value.type || `image/${ext}` }
					});
					uploaded.push(id);
				} catch {
					failed.push(id);
				}
			})()
		);
	}
	await Promise.all(tasks);

	return c.json({ uploaded, failed });
});

// ── charx import — ③ 마무리 ────────────────────────────────────
/**
 * 실제로 저장(로컬 IndexedDB)에 성공한 이미지 목록만 받아 image_set(kind:'named') 으로 확정한다.
 * (실패분은 제외 → 깨진 참조 방지.) storage:'local' 이면 바이트가 브라우저에만 있다는 표시.
 * 소유자 본인만.
 */
importRouter.post('/charx/:id/finalize', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email); // charx import 는 관리자 전용

	const db = c.env.DB;
	if (!db) return c.json({ error: 'storage unavailable' }, 500);

	const cid = c.req.param('id');
	const own = await getCharacterOwnership(db, cid);
	if (!own) return c.json({ error: 'not found' }, 404);
	if (own.creatorId !== user.id) return c.json({ error: 'forbidden' }, 403);

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: '요청 형식이 올바르지 않아요.' }, 400);
	}
	const rawImages = (body as { images?: unknown })?.images;
	const arr = Array.isArray(rawImages) ? rawImages : [];
	// 바이트가 브라우저 IndexedDB 에만 있는 경우(charx import) storage:'local'.
	const storage = (body as { storage?: unknown })?.storage === 'local' ? 'local' : undefined;

	const images: NamedImage[] = [];
	const seen = new Set<string>();
	for (const item of arr) {
		const x = (item ?? {}) as { id?: unknown; name?: unknown; ext?: unknown };
		const id = String(x.id ?? '').trim();
		const name = String(x.name ?? '').trim();
		const ext = IMPORT_IMAGE_EXT[String(x.ext ?? '').toLowerCase()];
		if (!id || !name || !ext || seen.has(id)) continue;
		seen.add(id);
		images.push({ id, name, ext });
		if (images.length >= NAMED_LIMITS.MAX_IMAGES) break;
	}

	await updateImageSet(
		db,
		cid,
		images.length > 0 ? { kind: 'named', images, ...(storage ? { storage } : {}) } : null
	);

	return c.json({ ok: true, count: images.length });
});

// ── 실험적: charx 스크립트 분석 ────────────────────────────────
/**
 * Haven 엔 트리거/스크립트 엔진이 없어 그냥 누락된다. 사용자가 "이 카드가 뭘 하려던 거지?"를
 * 알 수 있게, 원본(트리거 JSON·Lua/JS 코드·정규식)을 LLM(Gemini)에게 보내 사람이 읽는 설명으로 바꾼다.
 * 실행이 아니라 **읽고 설명만** 한다(코드는 모델에 텍스트로만 전달).
 */

/** 분석 모델 — 빠르고 저렴한 Gemini Flash 고정(사용자 선택 아님). */
const ANALYZE_MODEL = 'google/gemini-3.5-flash';

/** 입력 가드: 스크립트 1개당·전체 문자 상한(과금·지연·컨텍스트 보호). */
const PER_SCRIPT_CHARS = 12_000;
const TOTAL_CHARS = 60_000;
const MAX_SCRIPTS = 40;

const SYSTEM = [
	`너는 RisuAI 캐릭터 카드의 스크립트·트리거를 분석하는 사람이다.`,
	`주어진 항목(트리거 정의 JSON, Lua/JS 코드, 정규식 치환)을 읽고 "실제로 무엇을 하는지" 한국어로 설명하라.`,
	`독자는 비개발자다. 전문 용어는 최소화하고 쉽게 풀어 써라.`,
	``,
	`형식은 마크다운(제목·불릿·굵게·표) 쓰지 말고, 그냥 읽기 편한 줄글(문단)로 쓴다.`,
	`항목이 여러 개면 각 항목을 짧은 문단으로 나눠 자연스럽게 설명하라. 기호·머리표 없이 문장으로.`,
	`각 항목에서 그 스크립트가 하려는 일과 구체적인 동작을 풀어 쓰고, 위험·부작용이 있으면 문장 안에서 짚어줘라`,
	`(특히 AI 모델을 추가로 호출해 비용이 드는지, 외부 네트워크로 요청을 보내는지, 저장소·로어북에 접근하는지, 무한 반복 위험이 있는지).`,
	``,
	`이 스크립트들은 Haven 에서 실행되지 않는다(엔진 없음). 그래서 가장 중요한 건, 이 기능이 안 돌아도 챗봇을 즐기는 데`,
	`무리가 없는지 판단하는 것이다. 핵심 기믹(스탯·호감도·게임 진행·분기처럼 카드의 정체성)이면 빠지면 껍데기가 되고,`,
	`곁다리(자동 이미지·부가 연출·사소한 서식 정리)면 빠져도 일반 롤플레이로 즐기는 데 문제없다.`,
	``,
	`마지막 문단은 종합 판정으로, "무리 없음" / "일부 아쉬움" / "핵심 기능 손실" 중 하나를 먼저 밝히고,`,
	`이 카드가 어떤 기믹을 노린 것인지, 스크립트가 빠지면 구체적으로 무엇이 달라지는지(예: 호감도 수치가 안 변함, 자동 이미지가 안 뜸)를 줄글로 정리하라.`,
	`코드에 근거해 설명하고, 확신 못 하는 부분은 "추정"이라고 밝혀라. 코드 원문을 그대로 길게 옮기지 마라.`
].join('\n');

importRouter.post('/analyze-script', async (c) => {
	const user = requireUser(c);
	requireAdmin(user.email); // charx import(스크립트 분석)는 관리자 전용

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: '요청 형식이 올바르지 않아요.' }, 400);
	}

	const raw = (body as { scripts?: unknown })?.scripts;
	if (!Array.isArray(raw) || raw.length === 0) {
		return c.json({ error: '분석할 스크립트가 없어요.' }, 400);
	}

	// 정규화 + 입력 가드(라벨/소스만, 길이 제한).
	let total = 0;
	const items: { label: string; source: string }[] = [];
	for (const s of raw.slice(0, MAX_SCRIPTS)) {
		const label = String((s as { label?: unknown })?.label ?? '').slice(0, 120);
		let source = String((s as { source?: unknown })?.source ?? '');
		if (!source.trim()) continue;
		if (source.length > PER_SCRIPT_CHARS) {
			source = source.slice(0, PER_SCRIPT_CHARS) + '\n…(생략됨)';
		}
		if (total + source.length > TOTAL_CHARS) break;
		total += source.length;
		items.push({ label, source });
	}
	if (items.length === 0) {
		return c.json({ error: '분석할 내용이 비어있어요.' }, 400);
	}

	const db = c.env.DB;
	if (!db) return c.json({ error: 'db unavailable' }, 500);
	const apiKey = await getDecryptedKey(db, user.id, 'gateway');
	if (!apiKey) {
		return c.json(
			{ error: 'no_gateway_key', message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.' },
			400
		);
	}

	const prompt = items
		.map((it, i) => `### [${i + 1}] ${it.label}\n\`\`\`\n${it.source}\n\`\`\``)
		.join('\n\n');

	try {
		const { text } = await generateText({
			model: createGateway({ apiKey })(ANALYZE_MODEL),
			system: SYSTEM,
			prompt: `다음 ${items.length}개 항목을 분석해줘.\n\n${prompt}`,
			temperature: 0.3,
			// Gemini 는 추론이 출력 예산을 먹으므로 thinking 을 작게 제한.
			maxOutputTokens: 4000,
			providerOptions: {
				gateway: { caching: 'auto' },
				google: { thinkingConfig: { thinkingBudget: 256, includeThoughts: false } }
			}
		});

		const analysis = text.trim();
		if (!analysis) {
			return c.json({ error: '분석 결과가 비어있어요. 다시 시도해 주세요.' }, 502);
		}
		return c.json({ analysis, model: ANALYZE_MODEL, analyzed: items.length });
	} catch (err) {
		console.error('[analyze-script] error:', err);
		return c.json({ error: '분석 중 오류가 났어요. 잠시 후 다시 시도해 주세요.' }, 502);
	}
});
