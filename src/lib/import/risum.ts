/**
 * risum(RisuModule 바이너리) 디코더 — **탐지 전용**(메인 메타 JSON만 파싱, 에셋은 건너뜀).
 *
 * charx export 시 RisuAI 는 캐릭터의 트리거/정규식을 card.json 에서 빼서 `module.risum` 으로
 * 옮긴다(원본 characterCards.ts:1481-1495). 따라서 이 동적 기능들을 탐지하려면 risum 을 풀어야 한다.
 *
 * 포맷(원본 modules.ts:98-227):
 *   매직(111) · 버전(0) · UInt32LE 길이 · RPack(JSON {module,type}) · [에셋 루프…] · EOF(0)
 * RPack(원본 rpack/rpack_js.js): 256바이트 치환표로 1:1 바이트 매핑. **압축 없음**.
 * 우리는 메인 JSON 만 필요 → 길이만큼 잘라 디코드 후 파싱하고, 에셋 루프는 읽지 않는다.
 */

// RisuAI rpack_map.bin 의 디코드맵(바이트 256..511). 인코딩된 바이트 → 원본 바이트 역변환표.
// prettier-ignore
const DECODE_MAP = new Uint8Array([
	44, 247, 132, 139, 201, 101, 251, 182, 159, 174, 179, 3, 45, 1, 105, 116,
	31, 228, 163, 236, 238, 92, 52, 33, 147, 74, 15, 106, 226, 98, 2, 158,
	34, 156, 253, 60, 252, 113, 199, 198, 173, 89, 103, 5, 112, 109, 138, 68,
	18, 250, 36, 134, 95, 175, 209, 122, 71, 206, 254, 80, 99, 221, 81, 6,
	111, 24, 224, 82, 168, 9, 157, 86, 115, 76, 184, 83, 108, 195, 160, 14,
	25, 207, 62, 13, 126, 7, 50, 104, 70, 234, 72, 249, 153, 46, 171, 164,
	73, 32, 94, 85, 53, 56, 12, 188, 211, 177, 88, 22, 121, 40, 10, 26,
	225, 242, 205, 196, 57, 219, 162, 186, 96, 114, 118, 125, 149, 239, 127, 200,
	192, 222, 55, 148, 191, 181, 20, 129, 146, 37, 69, 172, 231, 245, 102, 167,
	43, 54, 90, 193, 19, 227, 75, 58, 232, 141, 131, 27, 124, 39, 176, 154,
	66, 235, 135, 170, 220, 84, 142, 120, 38, 210, 87, 41, 212, 183, 248, 47,
	143, 137, 117, 240, 65, 119, 194, 30, 255, 216, 21, 17, 229, 4, 151, 23,
	243, 49, 208, 155, 0, 215, 202, 180, 79, 42, 59, 217, 178, 107, 218, 93,
	161, 63, 48, 97, 189, 145, 61, 78, 230, 223, 190, 77, 130, 140, 29, 35,
	16, 152, 100, 244, 133, 51, 123, 144, 67, 187, 169, 136, 241, 214, 165, 28,
	246, 204, 110, 185, 91, 11, 150, 237, 213, 233, 197, 203, 8, 166, 128, 64
]);

function decodeRPack(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) out[i] = DECODE_MAP[data[i]];
	return out;
}

/** 탐지에 필요한 RisuModule 필드만(느슨한 타입). */
export interface RisuModuleMeta {
	name?: string;
	trigger?: unknown[];
	regex?: unknown[];
	cjs?: string;
	lorebook?: { constant?: boolean; content?: string }[];
	lowLevelAccess?: boolean;
}

/** risum 바이너리에서 module 메타(JSON)만 추출. 형식 불일치/손상 시 null. */
export function readModuleMeta(buf: Uint8Array): RisuModuleMeta | null {
	try {
		if (buf.length < 6) return null;
		if (buf[0] !== 111 || buf[1] !== 0) return null; // 매직 · 버전
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const len = view.getUint32(2, true); // UInt32LE
		const start = 6;
		if (start + len > buf.length) return null;
		const json = new TextDecoder().decode(decodeRPack(buf.subarray(start, start + len)));
		const parsed = JSON.parse(json) as { type?: string; module?: RisuModuleMeta };
		if (parsed?.type !== 'risuModule' || !parsed.module) return null;
		return parsed.module;
	} catch {
		return null;
	}
}
