/// <reference types="@cloudflare/workers-types" />

/**
 * haven-d1-api — D1(`haven`) 를 HTTP 로 노출하는 얇은 프록시 Worker.
 *
 * 비-Workers 호스트(Vercel 등)에 올린 앱이 `platform.env.DB` 바인딩을 못 쓰므로,
 * D1Database 의 prepare/bind 인터페이스를 HTTP 로 미러링한다.
 * 앱 쪽에선 이 엔드포인트들을 호출하는 "원격 D1 클라이언트" shim 으로 기존 db 레이어를 그대로 재사용.
 *
 * 보안: 모든 /query/* 는 Authorization: Bearer <APP_SECRET> 필요(공유 시크릿).
 *   이 시크릿을 아는 클라이언트만(우리 앱) 임의 SQL 을 실행할 수 있다 → 시크릿 유출 금지.
 *   엔드포인트는 인터넷에 공개되므로 강한 랜덤 시크릿(openssl rand -base64 32)을 쓴다.
 */

export interface Env {
	DB: D1Database;
	APP_SECRET: string;
}

interface QueryBody {
	sql?: unknown;
	params?: unknown;
}

interface BatchBody {
	statements?: unknown;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** 길이·내용 모두 비교(타이밍 누출 완화). */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

function authorized(req: Request, env: Env): boolean {
	if (!env.APP_SECRET) return false;
	const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
	return m ? safeEqual(m[1], env.APP_SECRET) : false;
}

/** params 를 D1 bind 인자 배열로 정규화. 미지정/비배열이면 빈 배열. */
function toParams(params: unknown): unknown[] {
	return Array.isArray(params) ? params : [];
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		// 인증 불필요 — 헬스체크.
		if (req.method === 'GET' && url.pathname === '/health') {
			return json({ ok: true, service: 'haven-d1-api' });
		}

		if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);

		let body: QueryBody & BatchBody;
		try {
			body = await req.json();
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}

		try {
			switch (url.pathname) {
				// db.prepare(sql).bind(...params).all() → { results, meta, success }
				case '/query/all': {
					if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
					const res = await env.DB.prepare(body.sql)
						.bind(...toParams(body.params))
						.all();
					return json(res);
				}

				// db.prepare(sql).bind(...params).first() → { result: row|null }
				case '/query/first': {
					if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
					const row = await env.DB.prepare(body.sql)
						.bind(...toParams(body.params))
						.first();
					return json({ result: row ?? null });
				}

				// db.prepare(sql).bind(...params).run() → { meta, success }
				case '/query/run': {
					if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
					const res = await env.DB.prepare(body.sql)
						.bind(...toParams(body.params))
						.run();
					return json(res);
				}

				// db.batch([prepare(sql).bind(...params), ...]) → 결과 배열
				case '/query/batch': {
					if (!Array.isArray(body.statements)) return json({ error: 'statements_required' }, 400);
					const prepared = (body.statements as { sql?: unknown; params?: unknown }[]).map((s) => {
						if (typeof s?.sql !== 'string') throw new Error('each statement needs sql');
						return env.DB.prepare(s.sql).bind(...toParams(s.params));
					});
					const res = await env.DB.batch(prepared);
					return json(res);
				}

				// db.exec(sql) — 멀티 스테이트먼트, 바인딩 없음(마이그레이션/DDL 용)
				case '/query/exec': {
					if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
					const res = await env.DB.exec(body.sql);
					return json(res);
				}

				default:
					return json({ error: 'not_found' }, 404);
			}
		} catch (err) {
			return json({ error: 'query_failed', message: (err as Error).message }, 500);
		}
	}
} satisfies ExportedHandler<Env>;
