/**
 * CBS 엔진은 `$lib/cbs` 로 이전(클라/서버 공용). 이 파일은 import 경로 호환을 위한 재노출.
 */
export { evalCBS, resolveCBS, resolveCBSStatic, hasScripting, makeRng, type CbsContext, type CbsResult } from '$lib/cbs';
