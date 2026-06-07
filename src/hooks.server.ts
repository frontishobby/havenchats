import type { Handle, HandleServerError } from '@sveltejs/kit';
import { SESSION_COOKIE, verifySessionToken } from '$lib/server/auth';
import { getUserProfile } from '$lib/server/db/users';
import { notifyServerError } from '$lib/server/notify';

const CANONICAL_HOST = 'havenchats.com';

export const handle: Handle = async ({ event, resolve }) => {
	// 프로덕션 pages.dev 도메인 → 커스텀 도메인으로 301 리디렉트.
	// (프리뷰 배포 <hash>.havenchats.pages.dev 는 그대로 둠)
	if (event.url.hostname === 'havenchats.pages.dev') {
		const target = new URL(event.url);
		target.hostname = CANONICAL_HOST;
		target.protocol = 'https:';
		target.port = '';
		return new Response(null, { status: 301, headers: { location: target.toString() } });
	}

	const token = event.cookies.get(SESSION_COOKIE);
	const identity = token ? await verifySessionToken(token) : null;

	if (!identity) {
		event.locals.user = null;
		return resolve(event);
	}

	const db = event.platform?.env?.DB;
	const profile = db ? await getUserProfile(db, identity.id) : null;

	event.locals.user = profile ?? {
		id: identity.id,
		email: identity.email,
		name: null,
		personaName: null,
		avatarUrl: null,
		persona: null,
		preference: null,
		country: null,
		profileComplete: false,
		blockedReason: null
	};

	// 차단된 유저는 변이성 API(POST/PUT/PATCH/DELETE) 호출을 서버에서 막는다.
	// (UI 는 차단 모달로 가리지만, 직접 요청까지 차단해 어떤 동작도 못하게.)
	// 차단 해제(관리자 /api/admin) 자체는 관리자 게이트가 따로 막으므로 무관.
	if (
		event.locals.user.blockedReason &&
		event.request.method !== 'GET' &&
		event.request.method !== 'HEAD'
	) {
		return new Response(JSON.stringify({ error: '차단된 계정입니다.' }), {
			status: 403,
			headers: { 'content-type': 'application/json' }
		});
	}

	return resolve(event);
};

/**
 * load/action/엔드포인트에서 throw 된(처리 안 된) 서버 에러를 Discord 로 알린다.
 * 4xx(404 등 예상된 에러)는 status 가 없거나 500 이상일 때만 전송.
 * (스트리밍 응답처럼 throw 하지 않는 경로는 각자 notifyServerError 를 직접 호출)
 */
export const handleError: HandleServerError = ({ error, event, status }) => {
	if (status >= 500) {
		notifyServerError({
			context: `${event.request.method} ${event.url.pathname}`,
			error,
			extra: { status, userId: event.locals.user?.id ?? 'anon' },
			waitUntil: event.platform?.context?.waitUntil?.bind(event.platform.context)
		});
	}
	return { message: '서버 오류가 발생했습니다.' };
};
