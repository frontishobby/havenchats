/**
 * NovelAI 생성 PNG 메타데이터 파서 + 그림체 필드 매핑(클라 전용, 순수 함수 + fflate).
 *
 * NAI 는 생성 정보를 두 군데에 넣는다:
 *  1. PNG `tEXt`/`iTXt` 청크 — `Comment`(요청 파라미터 JSON)·`Source`(모델)·`Description`(프롬프트).
 *     트위터·디스코드 등을 거치면 청크가 지워진다.
 *  2. **스텔스 메타**(청크가 지워져도 남음) — 알파 채널(또는 RGB)의 최하위 비트에 열 우선(x 바깥, y 안쪽) 순서로
 *     `stealth_png{info|comp}` 매직(15바이트) + 32비트 길이(비트 단위) + 본문. `comp` 면 본문이 gzip.
 *     본문은 위 청크들과 같은 키를 가진 JSON. RGB 변형은 `stealth_rgb{info|comp}`(픽셀당 R·G·B 3비트).
 *
 * 픽셀은 canvas 대신 직접 디코딩한다(IDAT inflate + 필터 복원) — canvas 는 색 관리·premultiply 로
 * 값이 흔들릴 수 있어 LSB 를 믿을 수 없다. 8비트 RGB/RGBA·비인터레이스만 지원(NAI 출력 형식).
 */
import { gunzipSync, unzlibSync, strFromU8 } from 'fflate';
import { NAI_MODELS, DEFAULT_NAI_MODEL } from '$lib/naiModels';

/** NAI 메타 원본(키는 NAI 그대로). */
export interface NaiRawMeta {
	Comment?: string;
	Source?: string;
	Description?: string;
	Software?: string;
	[k: string]: unknown;
}

/** 그림체 워크숍에 채울 값. */
export interface NaiStyleImport {
	title: string;
	memo: string;
	/** 그림체 프롬프트(base caption 에서 인원수·퀄리티 태그를 뺀 나머지). */
	prompt: string;
	/** base caption 에서 뽑은 퀄리티 태그('' 이면 모델 기본 꼬리 사용). */
	quality: string;
	negative: string;
	/** 테스트 상황(인원수 태그 + 인물 캡션) — 같은 장면을 다시 뽑아 비교용. */
	situation: string;
	model: string;
	width: number;
	height: number;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

interface Png {
	width: number;
	height: number;
	channels: 3 | 4;
	pixels: Uint8Array | null; // 필요할 때만 디코딩
	idat: Uint8Array[];
	text: Record<string, string>;
	interlaced: boolean;
	bitDepth: number;
	colorType: number;
}

function readChunks(buf: Uint8Array): Png {
	for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) throw new Error('PNG 파일이 아니에요.');
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const png: Png = {
		width: 0,
		height: 0,
		channels: 4,
		pixels: null,
		idat: [],
		text: {},
		interlaced: false,
		bitDepth: 8,
		colorType: 6
	};
	let p = 8;
	while (p + 8 <= buf.length) {
		const len = dv.getUint32(p);
		const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
		const body = buf.subarray(p + 8, p + 8 + len);
		if (type === 'IHDR') {
			png.width = dv.getUint32(p + 8);
			png.height = dv.getUint32(p + 12);
			png.bitDepth = body[8];
			png.colorType = body[9];
			png.interlaced = body[12] === 1;
		} else if (type === 'IDAT') {
			png.idat.push(body);
		} else if (type === 'tEXt') {
			const z = body.indexOf(0);
			if (z > 0) png.text[latin1(body.subarray(0, z))] = latin1(body.subarray(z + 1));
		} else if (type === 'iTXt') {
			// keyword\0 compFlag compMethod lang\0 translated\0 text
			const z = body.indexOf(0);
			if (z > 0) {
				const key = latin1(body.subarray(0, z));
				const compressed = body[z + 1] === 1;
				let q = z + 3;
				q = body.indexOf(0, q) + 1; // lang
				q = body.indexOf(0, q) + 1; // translated keyword
				if (q > 0) {
					const raw = body.subarray(q);
					png.text[key] = strFromU8(compressed ? unzlibSync(raw) : raw);
				}
			}
		} else if (type === 'zTXt') {
			const z = body.indexOf(0);
			if (z > 0) png.text[latin1(body.subarray(0, z))] = latin1(unzlibSync(body.subarray(z + 2)));
		} else if (type === 'IEND') {
			break;
		}
		p += 12 + len;
	}
	return png;
}

/** tEXt 는 규격상 latin1 이지만 NAI 는 UTF-8 JSON 을 넣는다 — UTF-8 로 해석 가능하면 그쪽. */
function latin1(b: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(b);
	} catch {
		let s = '';
		for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return s;
	}
}

/** IDAT → 필터 복원된 픽셀(8비트 RGB/RGBA). */
function decodePixels(png: Png): Uint8Array {
	if (png.pixels) return png.pixels;
	if (png.bitDepth !== 8 || (png.colorType !== 6 && png.colorType !== 2) || png.interlaced) {
		throw new Error('지원하지 않는 PNG 형식이에요(8비트 RGB/RGBA 만).');
	}
	png.channels = png.colorType === 6 ? 4 : 3;
	let total = 0;
	for (const c of png.idat) total += c.length;
	const joined = new Uint8Array(total);
	let o = 0;
	for (const c of png.idat) {
		joined.set(c, o);
		o += c.length;
	}
	const raw = unzlibSync(joined);
	const bpp = png.channels;
	const stride = png.width * bpp;
	const out = new Uint8Array(stride * png.height);
	let rp = 0;
	for (let y = 0; y < png.height; y++) {
		const f = raw[rp++];
		const row = y * stride;
		const prev = row - stride;
		for (let x = 0; x < stride; x++) {
			const v = raw[rp++];
			const a = x >= bpp ? out[row + x - bpp] : 0;
			const b = y > 0 ? out[prev + x] : 0;
			let r: number;
			switch (f) {
				case 0:
					r = v;
					break;
				case 1:
					r = v + a;
					break;
				case 2:
					r = v + b;
					break;
				case 3:
					r = v + ((a + b) >> 1);
					break;
				case 4: {
					const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
					const pp = a + b - c;
					const pa = Math.abs(pp - a);
					const pb = Math.abs(pp - b);
					const pc = Math.abs(pp - c);
					r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default:
					throw new Error('PNG 필터 오류');
			}
			out[row + x] = r & 255;
		}
	}
	png.pixels = out;
	return out;
}

/** 스텔스 LSB 비트 읽기(열 우선). mode 'alpha' = 픽셀당 1비트, 'rgb' = 픽셀당 3비트. */
class BitReader {
	private i = 0;
	constructor(
		private png: Png,
		private px: Uint8Array,
		private mode: 'alpha' | 'rgb'
	) {}
	get total(): number {
		return this.png.width * this.png.height * (this.mode === 'alpha' ? 1 : 3);
	}
	bit(): number {
		const { width, height, channels } = this.png;
		const per = this.mode === 'alpha' ? 1 : 3;
		const pix = Math.floor(this.i / per);
		const ch = this.mode === 'alpha' ? 3 : this.i % per;
		const x = Math.floor(pix / height);
		const y = pix % height;
		this.i++;
		if (x >= width) throw new Error('eof');
		return this.px[(y * width + x) * channels + ch] & 1;
	}
	bytes(n: number): Uint8Array {
		const out = new Uint8Array(n);
		for (let k = 0; k < n; k++) {
			let v = 0;
			for (let b = 0; b < 8; b++) v = (v << 1) | this.bit();
			out[k] = v;
		}
		return out;
	}
	uint32(): number {
		let v = 0;
		for (let b = 0; b < 32; b++) v = v * 2 + this.bit();
		return v;
	}
}

function readStealth(png: Png): NaiRawMeta | null {
	let px: Uint8Array;
	try {
		px = decodePixels(png);
	} catch {
		return null;
	}
	const modes: ('alpha' | 'rgb')[] = png.channels === 4 ? ['alpha', 'rgb'] : ['rgb'];
	for (const mode of modes) {
		try {
			const r = new BitReader(png, px, mode);
			const magic = String.fromCharCode(...r.bytes(15));
			const m = /^stealth_(png|rgb)(info|comp)$/.exec(magic);
			if (!m) continue;
			const bits = r.uint32();
			if (bits <= 0 || bits % 8 !== 0 || bits > r.total) continue;
			let data = r.bytes(bits / 8);
			if (m[2] === 'comp') data = gunzipSync(data);
			return JSON.parse(strFromU8(data)) as NaiRawMeta;
		} catch {
			/* 다음 모드 */
		}
	}
	return null;
}

/** PNG 바이트에서 NAI 메타 추출. 없으면 null. */
export function readNaiMeta(buf: Uint8Array): { meta: NaiRawMeta; width: number; height: number } | null {
	const png = readChunks(buf);
	const size = { width: png.width, height: png.height };
	if (png.text.Comment) return { meta: { ...png.text } as NaiRawMeta, ...size };
	const s = readStealth(png);
	return s ? { meta: s, ...size } : null;
}

// ─────────────────────────────────────────────────────────────
// 프롬프트 → 그림체 필드
// ─────────────────────────────────────────────────────────────

interface Seg {
	text: string; // 앞뒤 공백 제거한 세그먼트
	lead: string; // 앞 공백(줄바꿈 유지용)
}

/**
 * 최상위 콤마로 분리. `1.5::a, b::` 가중치 그룹과 `{}`/`[]`/`()` 괄호 안의 콤마는 나누지 않는다.
 */
export function splitSegments(s: string): Seg[] {
	const segs: Seg[] = [];
	let cur = '';
	let depth = 0;
	let inGroup = false;
	const push = () => {
		const m = /^\s*/.exec(cur)!;
		segs.push({ lead: m[0], text: cur.trim() });
		cur = '';
	};
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (!inGroup && depth === 0 && !cur.trim()) {
			const w = /^-?\d+(?:\.\d+)?::/.exec(s.slice(i));
			if (w) {
				inGroup = true;
				cur += w[0];
				i += w[0].length - 1;
				continue;
			}
		}
		if (s.startsWith('::', i)) {
			inGroup = false;
			cur += '::';
			i++;
			continue;
		}
		if (ch === '{' || ch === '[' || ch === '(') depth++;
		else if ((ch === '}' || ch === ']' || ch === ')') && depth > 0) depth--;
		if (ch === ',' && depth === 0 && !inGroup) {
			push();
			continue;
		}
		cur += ch;
	}
	push();
	return segs.filter((x) => x.text);
}

function joinSegments(segs: (Seg & { keep: boolean })[]): string {
	let out = '';
	let pendingBreak = '';
	for (const s of segs) {
		if (!s.keep) {
			if (!pendingBreak && s.lead.includes('\n')) pendingBreak = s.lead;
			continue;
		}
		if (out) {
			const brk = s.lead.includes('\n') ? s.lead : pendingBreak;
			out += ',' + (brk ? brk.replace(/^[ \t]+/, '') : ' ');
		}
		out += s.text;
		pendingBreak = '';
	}
	return out;
}

/** 세그먼트 안의 태그들(가중치·괄호 제거, 소문자). */
function innerTags(seg: string): { weight: number | null; tags: string[] } {
	let t = seg;
	let weight: number | null = null;
	const w = /^(-?\d+(?:\.\d+)?)::/.exec(t);
	if (w) {
		weight = Number(w[1]);
		t = t.slice(w[0].length);
	}
	t = t.replace(/::\s*$/, '');
	const tags = t
		.replace(/[{}[\]()]/g, '')
		.split(',')
		.map((x) => x.trim().toLowerCase().replace(/_/g, ' '))
		.filter(Boolean);
	return { weight, tags };
}

const COUNT_TAG_RE = /^(?:solo|\d+\+?\s?(?:girls?|boys?|others?)|multiple (?:girls|boys|others))$/i;

/** 퀄리티 태그로 볼 것(퀄리티 필드로 옮김). 연도·newest·complexity 는 그림체 쪽에 남긴다(앱 자동 주입과 중복 방지 판정이 그림체를 본다). */
const QUALITY_TAGS = new Set([
	'masterpiece',
	'best quality',
	'amazing quality',
	'great quality',
	'good quality',
	'high quality',
	'very aesthetic',
	'aesthetic',
	'highres',
	'absurdres',
	'incredibly absurdres',
	'best illustration',
	'very detailed',
	'ultra detailed',
	'ultra-detailed',
	'intricate detail',
	'intricate details',
	'no text'
]);

function modelFromSource(source: string | undefined): string {
	const s = (source ?? '').toLowerCase();
	if (/\bv5\b/.test(s)) return s.includes('curated') ? 'nai-diffusion-5-curated' : 'nai-diffusion-5-full';
	if (/\bv4\.5\b/.test(s)) return 'nai-diffusion-4-5-full';
	return DEFAULT_NAI_MODEL;
}

/** 작가 태그 → 제목 후보(가중치 높은 순 2명). */
function titleFromArtists(base: string): string {
	const found: { name: string; w: number; order: number }[] = [];
	for (const seg of splitSegments(base)) {
		const { weight, tags } = innerTags(seg.text);
		const w = weight ?? 1;
		if (w <= 0) continue;
		for (const t of tags) {
			const m = /^artist:\s*(.+)$/.exec(t);
			if (m && !found.some((f) => f.name === m[1])) found.push({ name: m[1].trim(), w, order: found.length });
		}
	}
	if (!found.length) return '';
	const top = [...found].sort((a, b) => b.w - a.w || a.order - b.order);
	const names = top.slice(0, 2).map((f) => f.name);
	const rest = found.length - names.length;
	return (names.join(' · ') + (rest > 0 ? ` 외 ${rest}` : '')).slice(0, 60);
}

interface NaiComment {
	prompt?: string;
	uc?: string;
	steps?: number;
	scale?: number;
	cfg_rescale?: number;
	seed?: number;
	sampler?: string;
	noise_schedule?: string;
	width?: number;
	height?: number;
	v4_prompt?: { caption?: { base_caption?: string; char_captions?: { char_caption?: string }[] } };
	v4_negative_prompt?: { caption?: { base_caption?: string } };
}

/** NAI 메타 → 그림체 워크숍 값. */
export function metaToStyle(meta: NaiRawMeta, size: { width: number; height: number }, fileName = ''): NaiStyleImport {
	let c: NaiComment = {};
	try {
		c = typeof meta.Comment === 'string' ? (JSON.parse(meta.Comment) as NaiComment) : {};
	} catch {
		/* Comment 없음/깨짐 → Description 만 사용 */
	}
	const base = (c.v4_prompt?.caption?.base_caption ?? c.prompt ?? meta.Description ?? '').trim();
	if (!base) throw new Error('프롬프트 정보가 없어요.');

	const segs = splitSegments(base).map((s) => {
		const { weight, tags } = innerTags(s.text);
		const isCount = weight === null && tags.length === 1 && COUNT_TAG_RE.test(tags[0]);
		const isQuality = (weight === null || weight > 0) && tags.length > 0 && tags.every((t) => QUALITY_TAGS.has(t));
		return { ...s, isCount, isQuality, keep: !isCount && !isQuality };
	});
	let prompt = joinSegments(segs);
	let quality = segs
		.filter((s) => s.isQuality)
		.map((s) => s.text)
		.join(', ');
	if (!prompt.trim()) {
		// 전부 퀄리티/인원수였으면 원문 그대로(인원수만 제외).
		prompt = joinSegments(segs.map((s) => ({ ...s, keep: !s.isCount })));
		quality = '';
	}

	const counts = segs.filter((s) => s.isCount).map((s) => s.text);
	const chars = (c.v4_prompt?.caption?.char_captions ?? [])
		.map((x) => (x.char_caption ?? '').trim().replace(/,\s*$/, ''))
		.filter(Boolean);
	const situation = [...counts, ...chars].join(', ');

	const negative = (c.v4_negative_prompt?.caption?.base_caption ?? c.uc ?? '').trim().replace(/,\s*$/, '');
	const model = modelFromSource(meta.Source);
	const width = c.width ?? size.width;
	const height = c.height ?? size.height;

	const label = NAI_MODELS.find((m) => m.id === model)?.label ?? model;
	const memoParts = [
		`NovelAI ${label}`,
		`${width}×${height}`,
		c.steps != null ? `steps ${c.steps}` : '',
		c.scale != null ? `CFG ${c.scale}` : '',
		c.cfg_rescale != null ? `rescale ${c.cfg_rescale}` : '',
		c.sampler ?? '',
		c.seed != null ? `seed ${c.seed}` : ''
	].filter(Boolean);
	const memo = `PNG 에서 가져옴 — ${memoParts.join(' · ')}`.slice(0, 500);

	const stem = fileName.replace(/\.[^.]+$/, '');
	const title =
		titleFromArtists(base) ||
		(stem && !/^[0-9a-f]{16,}$/i.test(stem) ? stem.slice(0, 60) : '') ||
		'가져온 그림체';

	return { title, memo, prompt, quality, negative, situation, model, width, height };
}

/** File → 그림체 값. NAI 메타가 없으면 throw. */
export async function importNaiPng(file: File): Promise<NaiStyleImport> {
	const buf = new Uint8Array(await file.arrayBuffer());
	const r = readNaiMeta(buf);
	if (!r) throw new Error('NovelAI 생성 정보가 없는 이미지예요. (메타데이터가 지워졌을 수 있어요)');
	return metaToStyle(r.meta, r, file.name);
}
