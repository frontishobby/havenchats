#!/usr/bin/env node
/**
 * 백업 zip 다이어트 — charx 로 가져온(imported) 캐릭터와 그 세션을 지우고, 최근 N개 세션만 남긴 뒤
 * 남은 DB 가 참조하는 이미지만 담아 새 zip 을 만든다.
 *
 *   node scripts/prune-backup.mjs <in.zip> [--out out.zip] [--keep 10] [--keep-imported] [--drop "이름1,이름2"]
 *
 * zip 형식은 src/lib/local/backup.ts 와 동일(haven.sqlite + images/<key>). Node 22.5+ (node:sqlite).
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';

const args = process.argv.slice(2);
const inPath = args.find((a) => !a.startsWith('--'));
if (!inPath) {
	console.error('usage: node scripts/prune-backup.mjs <in.zip> [--out out.zip] [--keep 10] [--keep-imported]');
	process.exit(1);
}
const opt = (n, d) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const OUT = opt('out', inPath.replace(/\.zip$/, '') + '-pruned.zip');
const KEEP = Number(opt('keep', '10'));
const DROP_IMPORTED = !args.includes('--keep-imported');
const DROP_NAMES = opt('drop', '').split(',').map((x) => x.trim()).filter(Boolean);

console.log(`zip 읽는 중… ${inPath}`);
const entries = unzipSync(new Uint8Array(readFileSync(inPath)));
const dbEntry = entries['haven.sqlite'];
if (!dbEntry) throw new Error('haven.sqlite 없음');

const tmp = join(tmpdir(), `haven-prune-${Date.now()}.sqlite`);
writeFileSync(tmp, dbEntry);
const db = new DatabaseSync(tmp);

const n = (sql) => db.prepare(sql).get().n;
const before = {
	chars: n('SELECT count(*) n FROM characters'),
	sessions: n('SELECT count(*) n FROM chat_sessions'),
	msgs: n('SELECT count(*) n FROM chat_messages')
};

// ── 1. charx 캐릭터 + 그 세션 삭제 ──
if (DROP_IMPORTED) {
	const ids = db.prepare('SELECT id, name FROM characters WHERE imported = 1').all();
	for (const c of ids) {
		db.prepare('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE character_id = ?)').run(c.id);
		db.prepare('DELETE FROM chat_sessions WHERE character_id = ?').run(c.id);
		db.prepare('DELETE FROM characters WHERE id = ?').run(c.id);
	}
	console.log(`charx 캐릭터 ${ids.length}개 삭제: ${ids.map((c) => c.name).join(', ')}`);
}
// 이름/ID 로 지정한 캐릭터 삭제(--drop)
for (const name of DROP_NAMES) {
	const rows = db.prepare('SELECT id, name FROM characters WHERE name = ? OR id = ?').all(name, name);
	if (!rows.length) console.warn(`--drop: '${name}' 캐릭터 없음`);
	for (const c of rows) {
		db.prepare('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE character_id = ?)').run(c.id);
		db.prepare('DELETE FROM chat_sessions WHERE character_id = ?').run(c.id);
		db.prepare('DELETE FROM characters WHERE id = ?').run(c.id);
		console.log(`캐릭터 삭제: ${c.name} (${c.id})`);
	}
}
// 캐릭터가 없는 고아 세션도 정리
db.exec('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE character_id NOT IN (SELECT id FROM characters))');
db.exec('DELETE FROM chat_sessions WHERE character_id NOT IN (SELECT id FROM characters)');

// ── 2. 최근 KEEP 개 세션만 ──
const old = `SELECT id FROM chat_sessions ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT -1 OFFSET ?`;
db.prepare(`DELETE FROM chat_messages WHERE session_id IN (${old})`).run(KEEP);
db.prepare(`DELETE FROM chat_sessions WHERE id IN (${old})`).run(KEEP);
db.exec('VACUUM');

// ── 3. 참조 이미지 수집 ──
const keys = new Set();
const add = (k) => k && keys.add(k);
for (const r of db.prepare('SELECT avatar_url FROM users').all()) add(r.avatar_url);
for (const r of db.prepare('SELECT id, thumbnail_key, image_set FROM characters').all()) {
	add(r.thumbnail_key);
	if (r.image_set) {
		try {
			const set = JSON.parse(r.image_set);
			for (const e of set?.entries ?? []) add(`charimg/${r.id}/${e.id}.${e.ext}`);
			for (const e of set?.images ?? []) add(`charimg/${r.id}/${e.id}.${e.ext}`);
		} catch {
			/* ignore */
		}
	}
}
for (const r of db.prepare('SELECT thumbnail_key FROM art_styles').all()) add(r.thumbnail_key);
for (const r of db.prepare("SELECT content FROM chat_messages WHERE role = 'image_generation'").all()) add(r.content);
const after = {
	chars: n('SELECT count(*) n FROM characters'),
	sessions: n('SELECT count(*) n FROM chat_sessions'),
	msgs: n('SELECT count(*) n FROM chat_messages')
};
db.close();
const dbBytes = new Uint8Array(readFileSync(tmp));
unlinkSync(tmp);

// ── 4. 새 zip ──
const files = { 'haven.sqlite': dbBytes };
let bytes = 0;
let missing = 0;
for (const key of keys) {
	const e = entries[`images/${key}`];
	if (!e) {
		missing++;
		continue;
	}
	files[`images/${key}`] = e;
	bytes += e.length;
}
const zipped = zipSync(files, { level: 0 });
writeFileSync(OUT, zipped);
console.log(`캐릭터 ${before.chars}→${after.chars}, 세션 ${before.sessions}→${after.sessions}, 메시지 ${before.msgs}→${after.msgs}`);
console.log(
	`이미지 ${Object.keys(entries).length - 1}→${keys.size - missing}개 (${(bytes / 1024 / 1024).toFixed(1)} MB)` +
		(missing ? `, 참조는 있지만 zip 에 없던 것 ${missing}개` : '')
);
console.log(`완료: ${OUT} (${(zipped.length / 1024 / 1024).toFixed(1)} MB)`);
