// 브라우저 기록 숨김(로컬 옵션). 켜져 있으면 모든 페이지의 브라우저 탭 제목을 "Haven" 으로만 표시.
// DB 미사용 — 이 기기(localStorage)에만 저장. 실제 적용(타이틀 강제)은 +layout.svelte 의 effect 가 담당.
import { browser } from '$app/environment';

const KEY = 'haven:hide-history';

export const privacyMode = $state({ hideHistory: false });

if (browser) {
	privacyMode.hideHistory = localStorage.getItem(KEY) === '1';
}

export function setHideHistory(on: boolean) {
	privacyMode.hideHistory = on;
	if (!browser) return;
	if (on) localStorage.setItem(KEY, '1');
	else localStorage.removeItem(KEY);
}
