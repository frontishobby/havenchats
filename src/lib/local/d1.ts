/**
 * D1 호환 shim — sql.js(SQLite WASM, 인메모리) 위에서 `D1Database` 의 사용 부분집합을 구현한다.
 *
 * 기존 `$lib/backend/db/*` 코드는 raw D1 prepared statement(`prepare().bind().first/all/run`, `batch`)만
 * 쓰므로 그 표면만 맞추면 무수정 재사용된다. 실제 영속화(스냅샷 export → IndexedDB/Drive)는
 * `runtime.ts` 가 `onWrite` 콜백으로 스케줄한다.
 *
 * 값 정규화: boolean → 0/1, undefined → null, ArrayBuffer → Uint8Array (sql.js 는 이 넷만 바인딩 가능).
 */
import type { Database, SqlValue } from 'sql.js';

type BindValue = SqlValue | boolean | undefined | ArrayBuffer;

function normalize(v: BindValue): SqlValue {
	if (v === undefined) return null;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (v instanceof ArrayBuffer) return new Uint8Array(v);
	if (typeof v === 'bigint') return Number(v);
	return v as SqlValue;
}

const READ_ONLY = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i;

export class LocalD1 {
	constructor(
		private readonly db: Database,
		private readonly onWrite: () => void
	) {}

	/** 원본 sql.js 핸들(export 등 런타임 내부용). */
	get raw(): Database {
		return this.db;
	}

	prepare(sql: string): LocalStatement {
		return new LocalStatement(this, sql, []);
	}

	/** 여러 문장을 하나의 트랜잭션으로 순차 실행(D1 batch 와 동일한 원자성). */
	async batch<T = unknown>(stmts: LocalStatement[]): Promise<D1Result<T>[]> {
		this.db.exec('BEGIN');
		try {
			const out: D1Result<T>[] = [];
			for (const s of stmts) out.push(this._exec<T>(s.sql, s.params));
			this.db.exec('COMMIT');
			return out;
		} catch (e) {
			this.db.exec('ROLLBACK');
			throw e;
		}
	}

	/** 세미콜론으로 이어진 여러 문장 실행(마이그레이션용). */
	async exec(sql: string): Promise<D1ExecResult> {
		this.db.exec(sql);
		this.onWrite();
		return { count: 0, duration: 0 };
	}

	/** 내부: 한 문장 실행 → D1Result 형태. SELECT 면 rows, 아니면 changes/last_row_id. */
	_exec<T>(sql: string, params: SqlValue[]): D1Result<T> {
		const stmt = this.db.prepare(sql);
		try {
			if (params.length) stmt.bind(params);
			const results: T[] = [];
			while (stmt.step()) results.push(stmt.getAsObject() as T);
			const readOnly = READ_ONLY.test(sql);
			const changes = readOnly ? 0 : this.db.getRowsModified();
			if (!readOnly) this.onWrite();
			return {
				results,
				success: true,
				meta: {
					duration: 0,
					size_after: 0,
					rows_read: results.length,
					rows_written: changes,
					last_row_id: readOnly ? 0 : this.lastRowId(),
					changed_db: changes > 0,
					changes
				}
			} as D1Result<T>;
		} finally {
			stmt.free();
		}
	}

	private lastRowId(): number {
		const r = this.db.exec('SELECT last_insert_rowid()');
		return Number(r[0]?.values[0]?.[0] ?? 0);
	}
}

export class LocalStatement {
	constructor(
		private readonly d1: LocalD1,
		readonly sql: string,
		readonly params: SqlValue[]
	) {}

	bind(...values: BindValue[]): LocalStatement {
		return new LocalStatement(this.d1, this.sql, values.map(normalize));
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const r = this.d1._exec<Record<string, unknown>>(this.sql, this.params);
		const row = r.results[0];
		if (!row) return null;
		if (column !== undefined) return (row[column] as T) ?? null;
		return row as T;
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.d1._exec<T>(this.sql, this.params);
	}

	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.d1._exec<T>(this.sql, this.params);
	}

	async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
		const r = this.d1._exec<Record<string, unknown>>(this.sql, this.params);
		const rows = r.results.map((row) => Object.values(row) as unknown as T);
		if (opts?.columnNames && r.results[0]) {
			return [Object.keys(r.results[0]) as unknown as T, ...rows];
		}
		return rows;
	}
}
