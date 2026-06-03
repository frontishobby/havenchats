import { json, type RequestHandler } from '@sveltejs/kit';
import { updateProfile, type Preference } from '$lib/server/db/users';

interface ProfileBody {
	name?: string;
	persona?: string;
	preference?: string;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	const db = platform?.env?.DB;
	if (!db) {
		return json({ error: 'db unavailable' }, { status: 500 });
	}

	const body = (await request.json()) as ProfileBody;
	const name = String(body.name ?? '').trim().slice(0, 40);
	if (!name) {
		return json({ error: '이름을 입력해 주세요.' }, { status: 400 });
	}

	const preference: Preference | null =
		body.preference === 'male' || body.preference === 'female' ? body.preference : null;
	const persona = String(body.persona ?? '').trim().slice(0, 2000) || null;

	await updateProfile(db, locals.user.id, { name, persona, preference });
	return json({ ok: true });
};
