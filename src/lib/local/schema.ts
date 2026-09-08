/**
 * 스키마 마이그레이션 — `migrations/*.sql`(구 D1 마이그레이션 파일)을 그대로 브라우저 SQLite 에 적용한다.
 * 적용 이력은 `_migrations(name)` 테이블에 남겨 새 파일만 실행한다(파일명 정렬 순).
 */
import type { Database } from 'sql.js';

const files = import.meta.glob('/migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const ordered = Object.entries(files)
	.map(([path, sql]) => ({ name: path.split('/').pop()!, sql }))
	.sort((a, b) => a.name.localeCompare(b.name));

/** 미적용 마이그레이션을 실행. 적용된 파일 수를 돌려준다. */
export function migrate(db: Database): number {
	db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
	const applied = new Set<string>();
	const res = db.exec('SELECT name FROM _migrations');
	for (const row of res[0]?.values ?? []) applied.add(String(row[0]));

	let n = 0;
	for (const m of ordered) {
		if (applied.has(m.name)) continue;
		db.exec('BEGIN');
		try {
			db.exec(m.sql);
			db.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [m.name, Date.now()]);
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
		}
		n++;
	}
	return n;
}

/**
 * 기존 D1 덤프(`wrangler d1 export`)처럼 `_migrations` 없이 스키마가 이미 들어있는 DB 를 열 때:
 * 테이블이 이미 있으면 전 파일을 적용된 것으로 마킹한다(재실행 시 CREATE TABLE 충돌 방지).
 */
export function markAllApplied(db: Database): void {
	db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
	for (const m of ordered) {
		db.run('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)', [m.name, Date.now()]);
	}
}

export const MIGRATION_NAMES = ordered.map((m) => m.name);
