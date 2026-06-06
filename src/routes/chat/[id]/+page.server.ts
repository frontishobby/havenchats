import { loadChatPage } from '$lib/server/chatPageLoad';
import type { PageServerLoad } from './$types';

// 로더는 디버그·세션 라우트와 공유한다. (src/lib/server/chatPageLoad.ts)
export const load: PageServerLoad = (event) => loadChatPage(event);
