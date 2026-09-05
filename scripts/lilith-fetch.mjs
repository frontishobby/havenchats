#!/usr/bin/env node
/**
 * 리리스 아카데미 이미지 에셋(mwaic.org/LAC/<인물코드>/<상황코드>.webp) 전수 확인 + 다운로드.
 * CDN 이 Referer 없는 요청을 403 으로 막으므로 babechat.ai Referer 를 붙여 받는다. (개인 사용)
 *
 *   node scripts/lilith-fetch.mjs index  <outDir>     # 존재하는 조합 전수 확인 → <outDir>/index.json
 *   node scripts/lilith-fetch.mjs fetch  <outDir>     # index.json 기준 다운로드 → <outDir>/<코드>_<상황>.webp
 *
 * 결과 파일명은 scenes-bulk.mjs 가 그대로 읽는 `<인물코드>_<상황번호>.webp` 형식.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const [mode, outDir] = process.argv.slice(2);
if (!mode || !outDir) {
	console.error('usage: lilith-fetch.mjs index|fetch <outDir>');
	process.exit(1);
}
const CODES = [
	'U1',
	...Array.from({ length: 32 }, (_, i) => 'F' + (i + 1)),
	'FM31',
	...Array.from({ length: 5 }, (_, i) => 'M' + (i + 1))
];
const MAX_SIT = 112;
const HEADERS = {
	referer: 'https://babechat.ai/',
	accept: 'image/webp,image/*,*/*',
	'user-agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
};
const url = (c, n) => `https://mwaic.org/LAC/${c}/${n}.webp`;
await mkdir(outDir, { recursive: true });
const indexPath = join(outDir, 'index.json');

async function pool(tasks, n, fn) {
	let i = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (i < tasks.length) await fn(tasks[i++]);
		})
	);
}

if (mode === 'index') {
	const tasks = [];
	for (const c of CODES) for (let n = 1; n <= MAX_SIT; n++) tasks.push([c, n]);
	const found = [];
	const errors = [];
	let done = 0;
	await pool(tasks, 12, async ([c, n]) => {
		try {
			const r = await fetch(url(c, n), { method: 'HEAD', headers: HEADERS });
			if (r.status === 200) found.push([c, n, Number(r.headers.get('content-length') || 0)]);
			else if (r.status !== 404) errors.push([c, n, r.status]);
		} catch (e) {
			errors.push([c, n, String(e.message).slice(0, 40)]);
		}
		if (++done % 400 === 0) console.log(`${done}/${tasks.length} 확인, 존재 ${found.length}`);
	});
	await writeFile(indexPath, JSON.stringify({ found, errors }, null, 0));
	const per = {};
	for (const [c] of found) per[c] = (per[c] || 0) + 1;
	const mb = Math.round(found.reduce((a, [, , b]) => a + b, 0) / 1048576);
	console.log(`존재 ${found.length}장 (~${mb}MB), 오류 ${errors.length}`, errors.slice(0, 5));
	console.log(per);
} else if (mode === 'fetch') {
	const { found } = JSON.parse(await readFile(indexPath, 'utf8'));
	let ok = 0;
	let skip = 0;
	const fail = [];
	await pool(found, 8, async ([c, n]) => {
		const dest = join(outDir, `${c}_${n}.webp`);
		try {
			await access(dest);
			skip++;
			return;
		} catch {}
		try {
			const r = await fetch(url(c, n), { headers: HEADERS });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			await writeFile(dest, Buffer.from(await r.arrayBuffer()));
			ok++;
			if (ok % 200 === 0) console.log(`${ok}/${found.length} 저장`);
		} catch (e) {
			fail.push([c, n, String(e.message).slice(0, 40)]);
		}
	});
	console.log(`저장 ${ok}, 이미 있음 ${skip}, 실패 ${fail.length}`, fail.slice(0, 10));
} else {
	console.error('mode 는 index 또는 fetch');
	process.exit(1);
}
