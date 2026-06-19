/// <reference types="@cloudflare/workers-types" />

/**
 * haven-d1-api — D1(`haven`) + R2(`haven-images`) 를 HTTP 로 노출하는 얇은 프록시 Worker.
 *
 * 비-Workers 호스트(Vercel 등)에 올린 앱이 `platform.env.{DB,IMAGES}` 바인딩을 못 쓰므로,
 * D1 의 prepare/bind 인터페이스와 R2 의 put/delete/list 를 HTTP 로 미러링한다.
 * 앱 쪽은 이 엔드포인트를 호출하는 "원격 클라이언트" shim(getDB/getImages)으로 기존 코드를 재사용.
 *
 * 보안: /health 외 모든 요청은 Authorization: Bearer <APP_SECRET> 필요(공유 시크릿).
 *   이 시크릿이 곧 DB·버킷 전체 권한이므로 강한 랜덤값을 쓰고 절대 노출 금지.
 *
 * 라우트
 *   GET    /health                      헬스체크(인증 불필요)
 *   POST   /query/{all,first,run,batch,exec}   D1
 *   PUT    /r2/object?key=<key>          R2 put (바디=오브젝트 바이트, Content-Type=오브젝트 타입)
 *   POST   /r2/delete                    R2 delete  바디 { keys: string[] }
 *   GET    /r2/list?prefix=&cursor=       R2 list → { objects:[{key}], truncated, cursor }
 *
 * R2 읽기(서빙)는 여기 없음 — 공개 커스텀 도메인으로 직접 서빙한다(egress 무료 + CF 변환).
 */

export interface Env {
	DB: D1Database;
	IMAGES: R2Bucket;
	APP_SECRET: string;
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

/** params 를 D1 bind 인자 배열로 정규화. */
function toParams(params: unknown): unknown[] {
	return Array.isArray(params) ? params : [];
}

async function handleD1(path: string, body: Record<string, unknown>, env: Env): Promise<Response> {
	switch (path) {
		case '/query/all': {
			if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
			return json(await env.DB.prepare(body.sql).bind(...toParams(body.params)).all());
		}
		case '/query/first': {
			if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
			const row = await env.DB.prepare(body.sql).bind(...toParams(body.params)).first();
			return json({ result: row ?? null });
		}
		case '/query/run': {
			if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
			return json(await env.DB.prepare(body.sql).bind(...toParams(body.params)).run());
		}
		case '/query/batch': {
			if (!Array.isArray(body.statements)) return json({ error: 'statements_required' }, 400);
			const prepared = (body.statements as { sql?: unknown; params?: unknown }[]).map((s) => {
				if (typeof s?.sql !== 'string') throw new Error('each statement needs sql');
				return env.DB.prepare(s.sql).bind(...toParams(s.params));
			});
			return json(await env.DB.batch(prepared));
		}
		case '/query/exec': {
			if (typeof body.sql !== 'string') return json({ error: 'sql_required' }, 400);
			return json(await env.DB.exec(body.sql));
		}
		default:
			return json({ error: 'not_found' }, 404);
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;

		// 인증 불필요 — 헬스체크.
		if (req.method === 'GET' && path === '/health') {
			return json({ ok: true, service: 'haven-d1-api' });
		}

		if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);

		try {
			// ── D1 ──
			if (path.startsWith('/query/')) {
				if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
				let body: Record<string, unknown>;
				try {
					body = await req.json();
				} catch {
					return json({ error: 'invalid_json' }, 400);
				}
				return await handleD1(path, body, env);
			}

			// ── R2 ──
			// put: 바디=오브젝트 바이트, Content-Type=오브젝트 타입, key=쿼리.
			if (path === '/r2/object' && req.method === 'PUT') {
				const key = url.searchParams.get('key');
				if (!key) return json({ error: 'key_required' }, 400);
				const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
				const bytes = await req.arrayBuffer();
				await env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
				return json({ ok: true, key });
			}

			// delete: 바디 { keys: string[] } (배열 일괄 삭제 — 라운드트립 1회).
			if (path === '/r2/delete' && req.method === 'POST') {
				let body: { keys?: unknown };
				try {
					body = await req.json();
				} catch {
					return json({ error: 'invalid_json' }, 400);
				}
				const keys = Array.isArray(body.keys)
					? body.keys.filter((k): k is string => typeof k === 'string')
					: [];
				if (keys.length) await env.IMAGES.delete(keys);
				return json({ ok: true, deleted: keys.length });
			}

			// list: prefix·cursor 로 페이지. key 만 추려 반환.
			if (path === '/r2/list' && req.method === 'GET') {
				const prefix = url.searchParams.get('prefix') ?? undefined;
				const cursor = url.searchParams.get('cursor') ?? undefined;
				const listed = await env.IMAGES.list({ prefix, cursor });
				return json({
					objects: listed.objects.map((o) => ({ key: o.key })),
					truncated: listed.truncated,
					cursor: listed.truncated ? listed.cursor : undefined
				});
			}

			return json({ error: 'not_found' }, 404);
		} catch (err) {
			return json({ error: 'proxy_failed', message: (err as Error).message }, 500);
		}
	}
} satisfies ExportedHandler<Env>;
