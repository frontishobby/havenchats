#!/usr/bin/env node
/**
 * 장면 이미지(그리드) 대량 업로드 — 관리자 로컬 스크립트.
 *
 *   HAVEN_COOKIE='haven_session=...' node scripts/scenes-bulk.mjs <characterId> <dir> <axes.json> [--reset] [--base https://havenchats.com] [--batch 40]
 *
 *  - axes.json : [{ label, values[], fallback? }, …] — 세트 축 정의.
 *  - dir       : 이미지 파일. 파일명(확장자 제외)을 `_` 로 나눈 각 조각이 축 순서대로 값 이름과 일치해야 한다.
 *                예) 축 [인물][상황] → `F12_45.webp`, `백솜이_기본.webp`. 하위 디렉터리는 `F12/45.webp` 처럼 `/` 도 조각으로 취급.
 *  - 값 이름은 대소문자 구분. 매칭 안 되는 파일은 건너뛰고 마지막에 목록으로 보고.
 *  - 첫 배치에만 --reset 이 적용된다(기존 엔트리·R2 정리).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
	args.filter((a) => a.startsWith('--')).map((a) => {
		const [k, v] = a.slice(2).split('=');
		return [k, v ?? true];
	})
);
const [characterId, dir, axesPath] = args.filter((a) => !a.startsWith('--'));
if (!characterId || !dir || !axesPath) {
	console.error('usage: scenes-bulk.mjs <characterId> <dir> <axes.json> [--reset] [--base URL] [--batch N]');
	process.exit(1);
}
const cookie = process.env.HAVEN_COOKIE;
if (!cookie) {
	console.error('HAVEN_COOKIE 환경변수(haven_session=...)가 필요합니다.');
	process.exit(1);
}
const base = String(flags.base ?? 'https://havenchats.com');
const batchSize = Number(flags.batch ?? 40);

// axes.json 의 각 축은 { label, values[], keys?[], fallback? }. keys 가 있으면 파일명 매칭엔 keys 를 쓰고
// values 는 모델에 보이는 이름으로만 쓴다(예: keys ["F12"], values ["백솜이"]). keys 는 서버로 보내지 않는다.
const axesFile = JSON.parse(await readFile(axesPath, 'utf8'));
const lookup = axesFile.map((a) => new Map((a.keys ?? a.values).map((v, i) => [String(v), i])));
const axes = axesFile.map(({ keys: _k, ...rest }) => rest);

async function walk(d) {
	const out = [];
	for (const name of await readdir(d)) {
		const p = join(d, name);
		if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
		else out.push(p);
	}
	return out;
}
const MIME = { '.webp': 'image/webp', '.avif': 'image/avif' };
const files = (await walk(dir)).filter((p) => MIME[extname(p).toLowerCase()]);
const items = [];
const skipped = [];
for (const p of files) {
	const rel = relative(dir, p);
	const stem = rel.slice(0, rel.length - extname(rel).length);
	const parts = stem.split(/[/_]/);
	if (parts.length !== axes.length) {
		skipped.push(rel);
		continue;
	}
	const combo = parts.map((s, ai) => lookup[ai].get(s));
	if (combo.some((v) => v == null)) {
		skipped.push(rel);
		continue;
	}
	items.push({ p, combo, mime: MIME[extname(p).toLowerCase()] });
}
console.log(`파일 ${files.length}개 중 매칭 ${items.length}개, 건너뜀 ${skipped.length}개`);

let first = true;
let totals = { added: 0, replaced: 0 };
for (let i = 0; i < items.length; i += batchSize) {
	const batch = items.slice(i, i + batchSize);
	const fd = new FormData();
	fd.set('axes', JSON.stringify(axes));
	if (first && flags.reset) fd.set('reset', '1');
	for (const it of batch) {
		const buf = await readFile(it.p);
		fd.append(`f:${it.combo.join(',')}`, new Blob([buf], { type: it.mime }), 'x' + extname(it.p));
	}
	const res = await fetch(`${base}/api/characters/${characterId}/scenes/bulk`, {
		method: 'POST',
		headers: { cookie },
		body: fd
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		console.error(`배치 ${i / batchSize + 1} 실패:`, res.status, body);
		process.exit(1);
	}
	totals.added += body.added;
	totals.replaced += body.replaced;
	first = false;
	console.log(`배치 ${i / batchSize + 1}/${Math.ceil(items.length / batchSize)} 완료 — 누적 ${body.total}장`);
}
console.log('완료:', totals);
if (skipped.length) console.log('건너뜀:', skipped.slice(0, 30).join(', '), skipped.length > 30 ? '…' : '');
