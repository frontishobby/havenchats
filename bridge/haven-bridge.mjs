#!/usr/bin/env node
// Haven ↔ Claude Code 구독 브릿지.
//
// homebox 같은 머신에서 `claude -p`(Claude Code CLI, 구독 OAuth) 를 서브프로세스로 띄워
// OpenAI 호환 `/v1/chat/completions`(SSE 스트리밍) 으로 노출한다. Haven 은 @ai-sdk/openai-compatible 로 붙는다.
//
// 세션/캐시 전략
//  - 요청 헤더 `x-haven-session` 이 Haven 세션 id. 브릿지는 세션마다 {cliSid, count, lastAssistant} 를 기억한다.
//  - 직전 턴에서 딱 한 쌍(assistant 응답 + 새 user)만 늘어난 "깨끗한 추가" 면 `--resume cliSid` 로
//    마지막 user 메시지만 보낸다 → Claude Code 가 진짜 멀티턴 이력을 유지하고 프롬프트 캐시가 그대로 먹는다.
//  - 그 외(재생성·삭제·편집·요약으로 window 이동·이어가기 병합) 는 새 CLI 세션을 만들고 전체 이력을 첫 프롬프트에
//    대본으로 넣는다(그 턴만 캐시 미스).
//  - resume 이 "No conversation found" 로 실패하면 자동으로 새 세션 경로로 재시도.
//
// 실행: node haven-bridge.mjs   (env: PORT=8787 HOST=127.0.0.1 BRIDGE_TOKEN= CLAUDE_BIN= BRIDGE_WORKDIR=)
// 노출: tailscale serve --bg --https=443 http://127.0.0.1:8787  (테일넷 안에서만 https 로 접근)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const CLAUDE = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude');
// 세션 파일은 cwd 기준으로 저장되므로 항상 같은 디렉터리에서 실행한다.
const WORKDIR = process.env.BRIDGE_WORKDIR || path.join(os.homedir(), 'haven-bridge');
const STATE_FILE = path.join(WORKDIR, 'sessions.json');
const TMP_DIR = path.join(WORKDIR, 'tmp');
const DEFAULT_MODEL = 'claude-opus-4-6';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const MAX_SESSIONS = 500;

fs.mkdirSync(TMP_DIR, { recursive: true });

// ── 세션 상태 ─────────────────────────────────────────────────────────────
/** @type {Record<string, {cliSid:string,count:number,lastAssistant:string,updatedAt:number}>} */
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }
function saveState() {
	const entries = Object.entries(state).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_SESSIONS);
	state = Object.fromEntries(entries);
	fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
}

// ── 유틸 ─────────────────────────────────────────────────────────────────
function textOf(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('');
	return '';
}
// Haven 은 저장 시 장면 코드 `{AAB}` 를 `{#id}` 로 바꾸므로 중괄호 토큰과 공백을 걷어내고 비교한다.
function norm(s) { return String(s ?? '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim(); }
function similar(a, b) {
	const x = norm(a), y = norm(b);
	if (!x || !y) return false;
	if (x === y) return true;
	const n = Math.min(x.length, y.length, 400);
	return x.slice(0, n) === y.slice(0, n) && Math.abs(x.length - y.length) < Math.max(40, x.length * 0.1);
}
function transcript(convo) {
	const hist = convo.slice(0, -1);
	const last = convo[convo.length - 1];
	const lines = hist.map((m) => `<message role="${m.role}">\n${m.content}\n</message>`).join('\n\n');
	return (
		`[대화 기록] 아래 <history> 는 지금까지의 대화다. role="assistant" 는 너의 이전 응답이다. ` +
		`이 흐름·문체·설정을 그대로 이어서, 마지막 user 메시지에 대한 다음 응답 본문만 출력하라. ` +
		`기록을 요약하거나 다시 쓰지 말 것.\n\n<history>\n${lines}\n</history>\n\n<message role="user">\n${last.content}\n</message>`
	);
}
function json(res, status, obj, extra = {}) {
	res.writeHead(status, { 'content-type': 'application/json', ...cors(), ...extra });
	res.end(JSON.stringify(obj));
}
function cors(req) {
	return {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET,POST,OPTIONS',
		'access-control-allow-headers': req?.headers['access-control-request-headers'] || 'authorization, content-type, x-haven-session',
		'access-control-max-age': '86400'
	};
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

// ── 동시성: 세션별 직렬화 + 전역 상한 ───────────────────────────────────────
const sessionLocks = new Map();
let running = 0;
const waiters = [];
async function withSlot(key, fn) {
	const prev = sessionLocks.get(key) ?? Promise.resolve();
	let release;
	const mine = new Promise((r) => (release = r));
	sessionLocks.set(key, prev.then(() => mine));
	await prev;
	if (running >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
	running++;
	try { return await fn(); } finally {
		running--;
		release();
		if (sessionLocks.get(key) === mine) sessionLocks.delete(key);
		waiters.shift()?.();
	}
}

// ── claude -p 실행 ────────────────────────────────────────────────────────
/**
 * @param {{model:string, system:string, prompt:string, sid:string, resume:boolean, signal:AbortSignal,
 *   onDelta:(t:string)=>void}} o
 * @returns {Promise<{text:string, usage:object, stopReason:string, rateLimit?:object, costUsd?:number, error?:string, notFound?:boolean}>}
 */
function runClaude(o) {
	return new Promise((resolve) => {
		const sysFile = path.join(TMP_DIR, `sys-${randomUUID()}.txt`);
		fs.writeFileSync(sysFile, o.system || ' ');
		const args = [
			'-p',
			'--model', o.model,
			'--system-prompt-file', sysFile,
			'--setting-sources', '',
			'--strict-mcp-config',
			'--disable-slash-commands',
			'--tools', '',
			'--max-turns', '1',
			'--output-format', 'stream-json',
			'--verbose',
			'--include-partial-messages',
			o.resume ? '--resume' : '--session-id', o.sid
		];
		const child = spawn(CLAUDE, args, {
			cwd: WORKDIR,
			env: { ...process.env, MAX_THINKING_TOKENS: '0' },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let text = '';
		let sawDelta = false;
		let usage = {};
		let stopReason = 'end_turn';
		let rateLimit;
		let costUsd;
		let error;
		let notFound = false;
		let stderr = '';
		let buf = '';
		const onAbort = () => child.kill('SIGTERM');
		o.signal.addEventListener('abort', onAbort, { once: true });
		child.stdin.end(o.prompt);
		child.stderr.on('data', (d) => (stderr += d));
		child.stdout.on('data', (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				let ev; try { ev = JSON.parse(line); } catch { continue; }
				handle(ev);
			}
		});
		function handle(ev) {
			if (ev.type === 'stream_event') {
				const e = ev.event;
				if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
					sawDelta = true; text += e.delta.text; o.onDelta(e.delta.text);
				} else if (e?.type === 'message_delta' && e.delta?.stop_reason) stopReason = e.delta.stop_reason;
			} else if (ev.type === 'assistant') {
				const m = ev.message ?? {};
				const t = textOf(m.content);
				if (ev.is_api_error_message || ev.error) {
					error = t || ev.error || 'api error';
					if (/no conversation found/i.test(error)) notFound = true;
				} else if (!sawDelta && t) { text += t; o.onDelta(t); }
			} else if (ev.type === 'rate_limit_event') {
				rateLimit = ev.rate_limit_info;
			} else if (ev.type === 'result') {
				usage = ev.usage ?? {};
				costUsd = ev.total_cost_usd;
				if (ev.is_error && !error) error = textOf(ev.result) || ev.subtype || 'error';
				if (/no conversation found/i.test(error ?? '')) notFound = true;
				if (ev.stop_reason) stopReason = ev.stop_reason;
			}
		}
		child.on('close', (code) => {
			o.signal.removeEventListener('abort', onAbort);
			fs.unlink(sysFile, () => {});
			if (buf.trim()) { try { handle(JSON.parse(buf)); } catch {} }
			if (code !== 0 && !error) error = `claude exited ${code}: ${stderr.trim().slice(-400)}`;
			if (!text && !error) error = 'empty response';
			resolve({ text, usage, stopReason, rateLimit, costUsd, error, notFound });
		});
		child.on('error', (e) => resolve({ text, usage, stopReason, error: String(e) }));
	});
}

// ── /v1/chat/completions ─────────────────────────────────────────────────
async function chat(req, res, body) {
	const model = (typeof body.model === 'string' && body.model.trim()) || DEFAULT_MODEL;
	const msgs = Array.isArray(body.messages) ? body.messages : [];
	const system = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
	const convo = msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content) }));
	if (!convo.length || convo[convo.length - 1].role !== 'user') return json(res, 400, { error: { message: 'last message must be user' } });
	const stream = body.stream === true;
	const havenSid = String(req.headers['x-haven-session'] ?? '').trim() || null;
	const lockKey = havenSid ?? randomUUID();
	const ac = new AbortController();
	req.on('close', () => { if (!res.writableEnded) ac.abort(); });
	const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
	const created = Math.floor(Date.now() / 1000);
	const t0 = Date.now();

	await withSlot(lockKey, async () => {
		if (ac.signal.aborted) return;
		let headersSent = false;
		const send = (obj) => { if (!headersSent) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors(req) }); headersSent = true; } res.write(`data: ${JSON.stringify(obj)}\n\n`); };
		const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

		const st = havenSid ? state[havenSid] : undefined;
		let resume = !!st && convo.length === st.count + 1 && convo.length >= 2 && convo[convo.length - 2].role === 'assistant' && similar(convo[convo.length - 2].content, st.lastAssistant);
		let sid = resume ? st.cliSid : randomUUID();
		let prompt = resume ? convo[convo.length - 1].content : transcript(convo);
		let started = false;
		const onDelta = (t) => { started = true; if (stream) send(chunk({ role: 'assistant', content: t })); };

		let r = await runClaude({ model, system, prompt, sid, resume, signal: ac.signal, onDelta });
		if (r.error && r.notFound && !started && !ac.signal.aborted) {
			console.warn(`[bridge] resume failed for ${havenSid} → new session`);
			resume = false; sid = randomUUID(); prompt = transcript(convo);
			r = await runClaude({ model, system, prompt, sid, resume, signal: ac.signal, onDelta });
		}
		if (ac.signal.aborted) { if (!res.writableEnded) res.end(); return; }

		const u = r.usage ?? {};
		const cached = u.cache_read_input_tokens ?? 0;
		const promptTokens = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
		const usage = { prompt_tokens: promptTokens, completion_tokens: u.output_tokens ?? 0, total_tokens: promptTokens + (u.output_tokens ?? 0), prompt_tokens_details: { cached_tokens: cached } };
		const five = r.rateLimit?.unifiedWindows?.five_hour;
		const week = r.rateLimit?.unifiedWindows?.seven_day;
		const rl = five ? { five_hour: five.utilization, five_hour_resets_at: five.resetsAt, seven_day: week?.utilization } : undefined;
		console.log(`[bridge] ${havenSid ?? '-'} ${resume ? 'resume' : 'new'} model=${model} msgs=${convo.length} in=${promptTokens} cached=${cached} out=${usage.completion_tokens} ${(Date.now() - t0) / 1000}s cost=${r.costUsd ?? '-'} 5h=${five ? Math.round(five.utilization * 100) + '%' : '-'}${r.error ? ' ERROR=' + r.error.slice(0, 200) : ''}`);

		if (r.error && !started) {
			if (stream) { send({ error: { message: r.error, type: 'bridge_error' } }); res.write('data: [DONE]\n\n'); res.end(); }
			else json(res, 502, { error: { message: r.error, type: 'bridge_error' } });
			return;
		}
		if (havenSid && !r.error) {
			state[havenSid] = { cliSid: sid, count: convo.length + 1, lastAssistant: r.text, updatedAt: Date.now() };
			saveState();
		}
		const finish = r.stopReason === 'max_tokens' ? 'length' : r.stopReason === 'refusal' ? 'content_filter' : 'stop';
		if (stream) {
			send(chunk({}, finish, { usage, haven: { rate_limit: rl, cost_usd: r.costUsd ?? null, resumed: resume } }));
			res.write('data: [DONE]\n\n');
			res.end();
		} else {
			json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: finish }], usage, haven: { rate_limit: rl, cost_usd: r.costUsd ?? null, resumed: resume } });
		}
	});
}

// ── 서버 ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
	if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: { message: 'unauthorized' } });
	try {
		if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) return json(res, 200, { ok: true, sessions: Object.keys(state).length, running });
		if (req.method === 'GET' && url.pathname === '/v1/models') {
			const ids = ['claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
			return json(res, 200, { object: 'list', data: ids.map((mid) => ({ id: mid, object: 'model', owned_by: 'anthropic' })) });
		}
		if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
			let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: { message: 'bad json' } }); }
			return await chat(req, res, body);
		}
		json(res, 404, { error: { message: 'not found' } });
	} catch (e) {
		console.error('[bridge] unhandled', e);
		if (!res.headersSent) json(res, 500, { error: { message: String(e) } });
		else res.end();
	}
});
server.listen(PORT, HOST, () => console.log(`[bridge] listening on http://${HOST}:${PORT} claude=${CLAUDE} workdir=${WORKDIR} auth=${TOKEN ? 'token' : 'none'}`));
