/**
 * R2 호환 shim — IndexedDB(`haven-images`) 위에서 `R2Bucket` 의 사용 부분집합(put/get/delete/list/head).
 *
 * 이미지 바이트는 IndexedDB 에 Blob 으로 저장된다. `<img src="/img/<key>">` 는 서비스워커
 * (`static/img-sw.js`)가 같은 스토어에서 읽어 응답하고, `fetch('/img/..')` 는 Hono img 라우트가
 * 이 shim 의 get() 으로 응답한다. Drive 동기화는 `onChange` 콜백으로 통지받는다.
 */
import { objDelete, objGet, objMetaAll, objPut, type StoredObject } from './idb';

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

export interface LocalR2Object {
	key: string;
	size: number;
	etag: string;
	httpEtag: string;
	uploaded: Date;
	httpMetadata: { contentType?: string };
	customMetadata: Record<string, string>;
}

export interface LocalR2ObjectBody extends LocalR2Object {
	body: ReadableStream<Uint8Array>;
	bodyUsed: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
	blob(): Promise<Blob>;
	text(): Promise<string>;
	json<T>(): Promise<T>;
}

function toMeta(o: Omit<StoredObject, 'blob'>): LocalR2Object {
	return {
		key: o.key,
		size: o.size,
		etag: o.etag,
		httpEtag: `"${o.etag}"`,
		uploaded: new Date(o.uploaded),
		httpMetadata: { contentType: o.contentType },
		customMetadata: {}
	};
}

async function toBlob(value: PutValue, contentType: string): Promise<Blob> {
	if (value === null) return new Blob([], { type: contentType });
	if (value instanceof Blob) return value.type ? value : new Blob([value], { type: contentType });
	if (typeof value === 'string') return new Blob([value], { type: contentType });
	if (value instanceof ReadableStream) return new Response(value).blob();
	if (value instanceof ArrayBuffer) return new Blob([value], { type: contentType });
	// ArrayBufferView
	const view = value as ArrayBufferView;
	return new Blob([view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer], {
		type: contentType
	});
}

export type R2ChangeKind = 'put' | 'delete';

export type MissHandler = (key: string) => Promise<StoredObject | null>;

export class LocalR2 {
	private onMiss: MissHandler | null = null;

	constructor(private readonly onChange: (kind: R2ChangeKind, keys: string[]) => void) {}

	/** 로컬에 없는 키를 외부(Drive)에서 가져오는 핸들러(sync 가 등록). 가져온 건 IndexedDB 에 넣어둔다. */
	setMissHandler(fn: MissHandler | null): void {
		this.onMiss = fn;
	}

	private async load(key: string): Promise<StoredObject | undefined> {
		const o = await objGet(key);
		if (o || !this.onMiss) return o;
		try {
			return (await this.onMiss(key)) ?? undefined;
		} catch {
			return undefined;
		}
	}

	async put(
		key: string,
		value: PutValue,
		options?: { httpMetadata?: { contentType?: string } | Headers }
	): Promise<LocalR2Object> {
		const hm = options?.httpMetadata;
		const contentType =
			(hm instanceof Headers ? hm.get('content-type') : hm?.contentType) || 'application/octet-stream';
		const blob = await toBlob(value, contentType);
		const obj: StoredObject = {
			key,
			blob,
			contentType,
			size: blob.size,
			uploaded: Date.now(),
			etag: crypto.randomUUID().replace(/-/g, '')
		};
		await objPut(obj);
		this.onChange('put', [key]);
		return toMeta(obj);
	}

	async get(key: string): Promise<LocalR2ObjectBody | null> {
		const o = await this.load(key);
		if (!o) return null;
		const meta = toMeta(o);
		return {
			...meta,
			body: o.blob.stream() as ReadableStream<Uint8Array>,
			bodyUsed: false,
			arrayBuffer: () => o.blob.arrayBuffer(),
			blob: async () => o.blob,
			text: () => o.blob.text(),
			json: async <T>() => JSON.parse(await o.blob.text()) as T
		};
	}

	async head(key: string): Promise<LocalR2Object | null> {
		const o = await this.load(key);
		return o ? toMeta(o) : null;
	}

	async delete(keys: string | string[]): Promise<void> {
		const list = Array.isArray(keys) ? keys : [keys];
		await objDelete(list);
		this.onChange('delete', list);
	}

	async list(options?: {
		prefix?: string;
		cursor?: string;
		limit?: number;
	}): Promise<{ objects: LocalR2Object[]; truncated: boolean; cursor?: string }> {
		const prefix = options?.prefix ?? '';
		const limit = Math.max(1, Math.min(options?.limit ?? 1000, 1000));
		const all = (await objMetaAll()).filter((o) => o.key.startsWith(prefix));
		const start = options?.cursor ? Number(options.cursor) || 0 : 0;
		const page = all.slice(start, start + limit);
		const truncated = start + limit < all.length;
		return {
			objects: page.map(toMeta),
			truncated,
			...(truncated ? { cursor: String(start + limit) } : {})
		};
	}
}
