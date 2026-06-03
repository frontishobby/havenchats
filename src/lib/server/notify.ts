import { env } from '$env/dynamic/private';

/**
 * 서버 에러를 Discord 웹훅으로 전송한다(Workers 호환 — fetch만 사용).
 * 웹훅 URL은 `DISCORD_WEBHOOK_URL`(env)로 오버라이드 가능, 없으면 기본값 사용.
 * 전송 실패가 본래 요청을 깨지 않도록 항상 swallow 한다.
 */
const DEFAULT_WEBHOOK_URL =
	'https://discord.com/api/webhooks/1511777501159096331/RPGGnBWuPij-IiFhQCQSu5-eK9IyFhtpyn6nH-eyjXQx-WFitOvGPugzpQ3CEiM9u7r1';

/** Discord embed description 상한(4096) 보다 넉넉히 잘라 안전 마진 확보. */
const MAX_FIELD = 1000;

function truncate(s: string, max = MAX_FIELD): string {
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function describe(error: unknown): { title: string; detail: string } {
	if (error instanceof Error) {
		return {
			title: `${error.name}: ${error.message}`,
			detail: error.stack ?? error.message
		};
	}
	const s = typeof error === 'string' ? error : safeStringify(error);
	return { title: truncate(s, 200), detail: s };
}

function safeStringify(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export interface NotifyOptions {
	/** 어디서 난 에러인지(예: 'POST /api/chat', 'model=...'). */
	context: string;
	error: unknown;
	/** 추가 필드(userId, model 등). */
	extra?: Record<string, unknown>;
	/** Workers 에서 응답 종료 후에도 전송을 끝까지 보장(없으면 fire-and-forget). */
	waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * 에러를 Discord 로 비동기 전송. 반환 프로미스는 항상 resolve(실패 swallow).
 * waitUntil 이 주어지면 워커 생존을 보장한다.
 */
export function notifyServerError(opts: NotifyOptions): Promise<void> {
	const url = env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
	if (!url) return Promise.resolve();

	const { title, detail } = describe(opts.error);
	const fields = [
		{ name: 'Context', value: truncate(opts.context, 200), inline: false },
		...Object.entries(opts.extra ?? {}).map(([name, value]) => ({
			name: truncate(name, 200),
			value: truncate(value == null ? '—' : String(value), 200),
			inline: true
		}))
	];

	const payload = {
		username: 'Haven 서버 에러',
		embeds: [
			{
				title: truncate(`🚨 ${title}`, 256),
				description: '```\n' + truncate(detail, 1800) + '\n```',
				color: 0xed4245,
				fields,
				timestamp: new Date().toISOString()
			}
		]
	};

	const p = fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	})
		.then(() => undefined)
		.catch((e) => {
			console.error('[notify] discord webhook failed:', e);
		});

	if (opts.waitUntil) opts.waitUntil(p);
	return p;
}
