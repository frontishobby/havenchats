import { Hono } from 'hono';
import { updateAvatarKey, updateProfile, type Preference } from '$lib/backend/db/users';
import type { Country } from '$lib/types';
import type { AppEnv } from '$lib/backend/context';
import { requireUser } from '$lib/backend/context';

/**
 * 프로필·아바타 저장(로그인 필수). multipart/form-data.
 * 대화용 이름·페르소나 저장(둘 다 선택). 아바타 필드는 구 UI 호환으로 남아 있음.
 */

/** 허용 이미지 타입 → 확장자. (webp/avif 만) */
const ALLOWED_AVATAR: Record<string, string> = {
	'image/webp': 'webp',
	'image/avif': 'avif'
};
const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3MB

export const profileRouter = new Hono<AppEnv>();

profileRouter.post('/', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	if (!db) {
		return c.json({ error: 'db unavailable' }, 500);
	}

	const form = await c.req.formData();

	// 대화용 이름(선택) — 비면 채팅에서 display_name('나')으로 폴백하므로 NULL 저장.
	const personaName = String(form.get('persona_name') ?? '').trim().slice(0, 40) || null;
	// display_name 은 1인 모드에선 표시용일 뿐(헤더). 대화용 이름이 있으면 그것, 없으면 '나'. 저장되면 profileComplete.
	const name = String(form.get('name') ?? '').trim().slice(0, 40) || personaName || '나';

	const prefRaw = String(form.get('preference') ?? '');
	const preference: Preference | null =
		prefRaw === 'male' || prefRaw === 'female' ? prefRaw : null;
	const persona = String(form.get('persona') ?? '').trim().slice(0, 2000) || null;

	// 국가(=NSFW 게이트). 미전송이면 기존 값 유지. PY(파라과이) 신규 전환은 승인 코드 필요(서버 검증).
	const countryRaw = String(form.get('country') ?? '');
	const country: Country | null =
		countryRaw === 'KR' || countryRaw === 'PY' ? countryRaw : user.country ?? null;

	// ── 프로필 사진(선택) ──
	const avatar = form.get('avatar');
	if (avatar instanceof File && avatar.size > 0) {
		const bucket = c.env.IMAGES;
		if (!bucket) {
			return c.json({ error: 'storage unavailable' }, 500);
		}
		const ext = ALLOWED_AVATAR[avatar.type];
		if (!ext) {
			return c.json({ error: '프로필 사진은 webp 또는 avif 이미지만 가능해요.' }, 400);
		}
		if (avatar.size > MAX_AVATAR_BYTES) {
			return c.json({ error: '이미지 용량이 너무 커요 (최대 3MB).' }, 400);
		}
		const key = `avatar/${user.id}.${ext}`;
		await bucket.put(key, await avatar.arrayBuffer(), {
			httpMetadata: { contentType: avatar.type }
		});
		const prevKey = await updateAvatarKey(db, user.id, key);
		// 확장자가 바뀌어 키가 달라지면 옛 오브젝트 정리(같은 키면 덮어쓰여 정리 불필요).
		if (prevKey && prevKey !== key) await bucket.delete(prevKey).catch(() => {});
	}

	await updateProfile(db, user.id, user.email, {
		name,
		personaName,
		persona,
		preference,
		country
	});
	return c.json({ ok: true });
});
