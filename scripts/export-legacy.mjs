#!/usr/bin/env node
/**
 * 구 Cloudflare(D1 + R2) 데이터 → 정적 1인 모드 백업 zip 변환.
 *
 *   npx wrangler d1 export haven --remote --output haven-d1.sql
 *   node scripts/export-legacy.mjs haven-d1.sql [--out haven-legacy-backup.zip]
 *        [--base https://havenchats.com] [--keep-email owner@example.com]
 *
 * 결과 zip 은 앱의 '저장소 · 백업 › zip 가져오기'(src/lib/local/backup.ts) 형식:
 *   haven.sqlite            — D1 덤프를 SQLite 파일로(다른 유저·OAuth 행 정리, _migrations 표시)
 *   images/<R2 키>          — DB 가 참조하는 이미지 전부를 <base>/img/<key> 에서 내려받아 수록
 *
 * Node 22.5+ (node:sqlite) 필요.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const args = process.argv.slice(2);
const dumpPath = args.find((a) => !a.startsWith('--'));
if (!dumpPath) {
	console.error('usage: node scripts/export-legacy.mjs <d1-dump.sql> [--out file.zip] [--base URL] [--keep-email EMAIL]');
	process.exit(1);
}
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const OUT = opt('out', 'haven-legacy-backup.zip');
const BASE = opt('base', 'https://havenchats.com').replace(/\/+$/, '');
const KEEP_EMAIL = opt('keep-email', 'owner@example.com').toLowerCase();

// ── 1. 덤프 → SQLite 파일 ──
const tmp = join(tmpdir(), `haven-legacy-${Date.now()}.sqlite`);
const db = new DatabaseSync(tmp);
const sql = readFileSync(dumpPath, 'utf8');
db.exec(sql);

// ── 2. 유저 1명만 남기기(1인 모드) ──
const users = db.prepare('SELECT id, email FROM users').all();
const keep = users.find((u) => String(u.email).toLowerCase() === KEEP_EMAIL) ?? users[0];
if (!keep) throw new Error('users 테이블이 비어 있어요.');
const drop = users.filter((u) => u.id !== keep.id).map((u) => u.id);
console.log(`유저 유지: ${keep.email} (${keep.id})` + (drop.length ? `, 제거: ${drop.length}명` : ''));
for (const uid of drop) {
	db.prepare('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = ?)').run(uid);
	db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(uid);
	for (const t of ['user_keys', 'art_style_favorites', 'prompt_module_favorites']) {
		try {
			db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
		} catch {
			/* 테이블 없을 수 있음 */
		}
	}
	// 다른 유저가 만든 캐릭터/그림체/모듈은 내 소유로 옮긴다(1인 모드에선 전부 '내 것').
	for (const t of ['characters', 'art_styles', 'prompt_modules']) {
		db.prepare(`UPDATE ${t} SET creator_id = ? WHERE creator_id = ?`).run(keep.id, uid);
	}
	db.prepare('DELETE FROM oauth_accounts WHERE user_id = ?').run(uid);
	db.prepare('DELETE FROM users WHERE id = ?').run(uid);
}
db.exec('DELETE FROM oauth_accounts');
// 구 Worker 는 API 키를 AES-GCM(KEY_SECRET)으로 암호화해 저장했다 — 브라우저에선 복호화 불가 → 비우고 앱에서 다시 등록.
db.exec('DELETE FROM user_keys');
db.exec('DROP TABLE IF EXISTS d1_migrations');

// _migrations: 레포의 migrations/*.sql 전부 적용됨으로 표시
db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
const migDir = join(process.cwd(), 'migrations');
if (existsSync(migDir)) {
	const ins = db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)');
	for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) ins.run(f, Date.now());
}
db.exec('VACUUM');

// ── 3. 이미지 키 수집 ──
const keys = new Set();
const add = (k) => k && typeof k === 'string' && keys.add(k);
for (const r of db.prepare('SELECT avatar_url FROM users').all()) add(r.avatar_url);
for (const r of db.prepare('SELECT id, thumbnail_key, image_set FROM characters').all()) {
	add(r.thumbnail_key);
	if (r.image_set) {
		try {
			const set = JSON.parse(r.image_set);
			if (set?.kind === 'grid') for (const e of set.entries ?? []) add(`charimg/${r.id}/${e.id}.${e.ext}`);
			if (set?.kind === 'named') for (const e of set.images ?? []) add(`charimg/${r.id}/${e.id}.${e.ext}`);
		} catch {
			/* ignore */
		}
	}
}
for (const r of db.prepare('SELECT thumbnail_key FROM art_styles').all()) add(r.thumbnail_key);
for (const r of db.prepare("SELECT content FROM chat_messages WHERE role = 'image_generation'").all()) add(r.content);
db.close();

const dbBytes = new Uint8Array(readFileSync(tmp));
unlinkSync(tmp);
console.log(`DB ${(dbBytes.length / 1024 / 1024).toFixed(2)} MB, 이미지 ${keys.size}개 내려받는 중… (${BASE}/img/…)`);

// ── 4. 이미지 다운로드(동시 6) ──
const files = { 'haven.sqlite': dbBytes };
const list = [...keys];
let done = 0;
let missing = 0;
let bytes = 0;
async function worker() {
	while (list.length) {
		const key = list.shift();
		try {
			const res = await fetch(`${BASE}/img/${key}`);
			if (!res.ok) {
				missing++;
				console.warn(`  누락 ${res.status}: ${key}`);
			} else {
				const buf = new Uint8Array(await res.arrayBuffer());
				files[`images/${key}`] = buf;
				bytes += buf.length;
			}
		} catch (e) {
			missing++;
			console.warn(`  실패: ${key} (${e.message})`);
		}
		done++;
		if (done % 25 === 0) process.stdout.write(`  ${done}/${keys.size}\n`);
	}
}
await Promise.all(Array.from({ length: 6 }, worker));

// ── 5. zip ──
const zipped = zipSync(files, { level: 0 });
writeFileSync(OUT, zipped);
console.log(
	`완료: ${OUT} (${(zipped.length / 1024 / 1024).toFixed(1)} MB, 이미지 ${keys.size - missing}개 ${(bytes / 1024 / 1024).toFixed(1)} MB` +
		(missing ? `, 누락 ${missing}개` : '') +
		')'
);
console.log('앱에서 프로필 메뉴 › 저장소 · 백업 › zip 가져오기로 불러온 뒤, API 키(Gateway·NovelAI)를 다시 등록하세요.');
