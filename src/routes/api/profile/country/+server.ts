import { json, type RequestHandler } from '@sveltejs/kit';
import { updateCountry } from '$lib/server/db/users';
import { isValidUnlockCode } from '$lib/server/nsfwUnlock';
import type { Country } from '$lib/types';

/**
 * 프로필 국가(=NSFW 노출 게이트) 전환. 드롭다운 SFW/NSFW 토글에서 호출.
 * - 'KR'(대한민국, SFW): 코드 없이 즉시 전환.
 * - 'PY'(파라과이, NSFW): 이미 PY 가 아니면 승인 코드('arca') 필요 → 틀리면 403.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const db = platform?.env?.DB;
	if (!db) return json({ error: 'db unavailable' }, { status: 500 });

	const body = (await request.json().catch(() => null)) as {
		country?: string;
		code?: string;
	} | null;
	const country = body?.country;
	if (country !== 'KR' && country !== 'PY') {
		return json({ error: 'invalid country' }, { status: 400 });
	}

	// 파라과이(NSFW) 전환은 코드 검증. 이미 PY 면 재검증 없이 통과(멱등).
	if (country === 'PY' && locals.user.country !== 'PY' && !isValidUnlockCode(body?.code)) {
		return json(
			{ error: 'bad_code', message: '대한민국에서는 NSFW 를 켤 수 없어요. 승인 코드가 올바르지 않습니다.' },
			{ status: 403 }
		);
	}

	await updateCountry(db, locals.user.id, country as Country);
	return json({ ok: true, country });
};
