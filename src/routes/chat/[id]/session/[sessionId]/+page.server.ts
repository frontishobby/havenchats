import { loadChatPage } from '$lib/server/chatPageLoad';
import type { PageServerLoad } from './$types';

// 세션 이어가기. 로더는 메인(/chat/[id])·디버그와 공유한다. (src/lib/server/chatPageLoad.ts)
export const load: PageServerLoad = (event) => loadChatPage(event);
