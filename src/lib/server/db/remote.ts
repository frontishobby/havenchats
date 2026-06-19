import { env } from '$env/dynamic/private';

/**
 * 원격 D1 클라이언트 — D1Database 인터페이스를 HTTP 프록시 Worker(haven-d1-api)로 미러링.
 *
 * 비-Workers 호스트(Vercel 등)엔 `platform.env.DB` 바인딩이 없으므로, 같은 prepare/bind/all/first/run/batch
 * 인터페이스를 그대로 구현해 기존 `lib/server/db/*` 코드를 무수정 재사용한다.
 * CF Pages/Workers 로 돌아오면 getDB() 가 네이티브 바인딩을 우선 잡으므로 이 경로는 자동으로 비활성.
 *
 * 보안: Authorization: Bearer <D1_API_SECRET>. 프록시는 임의 SQL 을 실행하므로 시크릿 유출 금지.
 */

interface RemotePayload {
	sql: string;
	params: unknown[];
}

class RemoteD1PreparedStatement {
	constructor(
		private readonly api: RemoteD1Database,
		private readonly sql: string,
		private readonly params: unknown[] = []
	) {}

	bind(...values: unknown[]): RemoteD1PreparedStatement {
		return new RemoteD1PreparedStatement(this.api, this.sql, values);
	}

	/** 내부: batch 직렬화용 페이로드. */
	payload(): RemotePayload {
		return { sql: this.sql, params: this.params };
	}

	async first<T = unknown>(colName?: string): Promise<T | null> {
		const { result } = await this.api.post<{ result: Record<string, unknown> | null }>(
			'/query/first',
			this.payload()
		);
		if (result == null) return null;
		if (colName != null) return (result[colName] as T) ?? null;
		return result as T;
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return this.api.post('/query/all', this.payload());
	}

	async run<T = unknown>(): Promise<D1Result<T>> {
		return this.api.post('/query/run', this.payload());
	}

	/** D1 .raw() 호환(현재 앱 미사용이지만 인터페이스 완전성 위해 제공). */
	async raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[]> {
		const res = await this.api.post<D1Result<Record<string, unknown>>>('/query/all', this.payload());
		const rows = res.results ?? [];
		const values = rows.map((r) => Object.values(r) as unknown as T);
		if (options?.columnNames && rows.length > 0) {
			return [Object.keys(rows[0]) as unknown as T, ...values];
		}
		return values;
	}
}

export class RemoteD1Database {
	constructor(
		private readonly baseUrl: string,
		private readonly secret: string
	) {}

	prepare(sql: string): RemoteD1PreparedStatement {
		return new RemoteD1PreparedStatement(this, sql);
	}

	async batch<T = unknown>(statements: RemoteD1PreparedStatement[]): Promise<D1Result<T>[]> {
		return this.post('/query/batch', { statements: statements.map((s) => s.payload()) });
	}

	async exec(sql: string): Promise<D1ExecResult> {
		return this.post('/query/exec', { sql });
	}

	dump(): Promise<ArrayBuffer> {
		throw new Error('RemoteD1Database.dump() 미지원');
	}

	withSession(): never {
		throw new Error('RemoteD1Database.withSession() 미지원');
	}

	/** 내부: 프록시 Worker 호출. 4xx/5xx 는 throw. */
	async post<T = unknown>(path: string, body: unknown): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${this.secret}`
			},
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`D1 proxy ${path} → ${res.status}: ${text}`);
		}
		return res.json() as Promise<T>;
	}
}

/**
 * 요청에서 사용할 D1 핸들을 돌려준다(드롭인: 기존 `platform?.env?.DB` 자리에 `getDB(platform)`).
 *  - CF Pages/Workers: platform.env.DB(네이티브 바인딩) 우선 — 오버헤드 0.
 *  - 비-Workers 호스트(Vercel 등): D1_API_URL/D1_API_SECRET 로 원격 프록시 Worker.
 *  - 둘 다 없으면 undefined(기존 graceful 동작 유지).
 *
 * D1_FORCE_REMOTE=true 면 네이티브 바인딩이 있어도 원격을 쓴다(로컬에서 원격 경로 검증용).
 */
export function getDB(platform: Readonly<App.Platform> | undefined): D1Database | undefined {
	const native = platform?.env?.DB;
	const forceRemote = env.D1_FORCE_REMOTE === 'true';
	if (native && !forceRemote) return native;
	if (env.D1_API_URL && env.D1_API_SECRET) {
		return new RemoteD1Database(env.D1_API_URL, env.D1_API_SECRET) as unknown as D1Database;
	}
	return native;
}
