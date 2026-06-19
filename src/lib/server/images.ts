import { env } from '$env/dynamic/private';

/**
 * 원격 R2 클라이언트 — R2Bucket 의 put/delete/list 를 HTTP 프록시 Worker(haven-d1-api)로 미러링.
 *
 * 비-Workers 호스트(Vercel 등)엔 `platform.env.IMAGES` 바인딩이 없으므로, 같은 인터페이스를 구현해
 * 기존 업로드/삭제 코드(imageStore 등)를 무수정 재사용한다.
 * CF Pages/Workers 로 돌아오면 getImages() 가 네이티브 바인딩을 우선 잡으므로 이 경로는 자동 비활성.
 *
 * 읽기(get/서빙)는 구현하지 않는다 — 이미지는 R2 공개 커스텀 도메인으로 직접 서빙한다(egress 무료).
 * D1 프록시와 같은 Worker·시크릿(D1_API_URL/D1_API_SECRET)을 공유한다.
 */

interface R2PutOptions {
	httpMetadata?: { contentType?: string };
}
interface R2ListOptions {
	prefix?: string;
	cursor?: string;
}

class RemoteR2 {
	constructor(
		private readonly baseUrl: string,
		private readonly secret: string
	) {}

	private auth(): Record<string, string> {
		return { authorization: `Bearer ${this.secret}` };
	}

	async put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | ReadableStream | string | Blob,
		options?: R2PutOptions
	): Promise<void> {
		const contentType = options?.httpMetadata?.contentType ?? 'application/octet-stream';
		const res = await fetch(`${this.baseUrl}/r2/object?key=${encodeURIComponent(key)}`, {
			method: 'PUT',
			headers: { ...this.auth(), 'content-type': contentType },
			body: value as BodyInit,
			// ReadableStream 바디 전송에 필요(undici).
			duplex: 'half'
		} as RequestInit);
		if (!res.ok) throw new Error(`R2 proxy put ${key} → ${res.status}: ${await res.text().catch(() => '')}`);
	}

	async delete(keys: string | string[]): Promise<void> {
		const arr = Array.isArray(keys) ? keys : [keys];
		if (arr.length === 0) return;
		const res = await fetch(`${this.baseUrl}/r2/delete`, {
			method: 'POST',
			headers: { ...this.auth(), 'content-type': 'application/json' },
			body: JSON.stringify({ keys: arr })
		});
		if (!res.ok) throw new Error(`R2 proxy delete → ${res.status}: ${await res.text().catch(() => '')}`);
	}

	async list(
		options?: R2ListOptions
	): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }> {
		const p = new URLSearchParams();
		if (options?.prefix) p.set('prefix', options.prefix);
		if (options?.cursor) p.set('cursor', options.cursor);
		const res = await fetch(`${this.baseUrl}/r2/list?${p.toString()}`, { headers: this.auth() });
		if (!res.ok) throw new Error(`R2 proxy list → ${res.status}: ${await res.text().catch(() => '')}`);
		return res.json();
	}
}

/**
 * 요청에서 사용할 R2 핸들을 돌려준다(드롭인: 기존 `platform?.env?.IMAGES` 자리에 `getImages(platform)`).
 *  - CF Pages/Workers: platform.env.IMAGES(네이티브 바인딩) 우선.
 *  - 비-Workers 호스트(Vercel 등): D1_API_URL/D1_API_SECRET 로 원격 프록시 Worker.
 *  - 둘 다 없으면 undefined.
 *
 * D1_FORCE_REMOTE=true 면 네이티브가 있어도 원격을 쓴다(로컬 검증용 — D1 과 같은 플래그).
 */
export function getImages(platform: Readonly<App.Platform> | undefined): R2Bucket | undefined {
	const native = platform?.env?.IMAGES;
	const forceRemote = env.D1_FORCE_REMOTE === 'true';
	if (native && !forceRemote) return native;
	if (env.D1_API_URL && env.D1_API_SECRET) {
		return new RemoteR2(env.D1_API_URL, env.D1_API_SECRET) as unknown as R2Bucket;
	}
	return native;
}
