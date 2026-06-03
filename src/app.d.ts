/// <reference types="@cloudflare/workers-types" />

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: {
				id: string;
				email: string;
				name: string | null; // 대화용 이름(display_name)
				persona: string | null;
				preference: 'male' | 'female' | null;
				profileComplete: boolean;
			} | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				AI_GATEWAY_API_KEY?: string;
				DB?: D1Database;
				SESSIONS?: KVNamespace;
			};
			context: { waitUntil(promise: Promise<unknown>): void };
			caches: CacheStorage & { default: Cache };
		}
	}
}

export {};
