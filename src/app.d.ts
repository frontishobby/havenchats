/// <reference types="@cloudflare/workers-types" />

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: {
				id: string;
				email: string;
				name: string | null; // 남에게 노출되는 이름(display_name)
				personaName: string | null; // 채팅에서 AI 가 부르는 이름(선택). 비면 name 으로 폴백
				avatarUrl: string | null; // 프로필 사진(servable URL) — 없으면 null
				persona: string | null;
				preference: 'male' | 'female' | null;
				profileComplete: boolean;
				blockedReason: string | null; // null 이 아니면 차단된 유저
			} | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				AI_GATEWAY_API_KEY?: string;
				DB?: D1Database;
				IMAGES?: R2Bucket;
				SESSIONS?: KVNamespace;
			};
			context: { waitUntil(promise: Promise<unknown>): void };
			caches: CacheStorage & { default: Cache };
		}
	}
}

export {};
