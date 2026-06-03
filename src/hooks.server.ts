import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, verifySessionToken } from '$lib/server/auth';
import { getUserProfile } from '$lib/server/db/users';

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
		avatarUrl: null,
		persona: null,
		preference: null,
		profileComplete: false
	};

	return resolve(event);
};
