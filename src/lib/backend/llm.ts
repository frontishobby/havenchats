import { createGateway } from '@ai-sdk/gateway';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { getDecryptedKey } from './db/userKeys';
import { isBridgeModel, bridgeModelName } from '$lib/data/models';

export type ResolvedChatModel =
	| { ok: true; model: LanguageModel; headers?: Record<string, string> }
	| { ok: false; error: string; message: string };

/**
 * 채팅 모델 id → AI SDK LanguageModel.
 *  - `bridge/…` : homebox 구독 브릿지(OpenAI 호환, API 키 관리의 브릿지 URL). Haven 세션 id 를 `x-haven-session`
 *    헤더로 보내면 브릿지가 CLI 세션을 --resume 으로 이어 프롬프트 캐시를 유지한다(chat 호출부가 헤더에 넣음).
 *  - 그 외 : 유저 본인 Vercel AI Gateway 키(BYO). 키 없으면 차단.
 */
export async function resolveChatModel(
	db: D1Database,
	userId: string,
	modelId: string
): Promise<ResolvedChatModel> {
	if (isBridgeModel(modelId)) {
		const url = await getDecryptedKey(db, userId, 'bridge');
		if (!url) {
			return {
				ok: false,
				error: 'no_bridge_url',
				message: 'API 키 관리에서 Claude 구독 브릿지 주소를 먼저 등록해 주세요.'
			};
		}
		const provider = createOpenAICompatible({ name: 'bridge', baseURL: `${url}/v1`, apiKey: 'haven' });
		return { ok: true, model: provider.chatModel(bridgeModelName(modelId)) };
	}
	const gatewayKey = await getDecryptedKey(db, userId, 'gateway');
	if (!gatewayKey) {
		return {
			ok: false,
			error: 'no_gateway_key',
			message: 'API 키 관리에서 Vercel AI Gateway 키를 먼저 등록해 주세요.'
		};
	}
	return { ok: true, model: createGateway({ apiKey: gatewayKey })(modelId) };
}
