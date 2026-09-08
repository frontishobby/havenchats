/**
 * 모달·바텀시트가 떠 있는 동안 바깥(body) 스크롤 잠금. Svelte 액션 — 백드롭 루트에 `use:scrollLock`.
 * 여러 개가 겹쳐도 카운트로 관리해 마지막이 닫힐 때만 푼다.
 * iOS 사파리는 `overflow:hidden` 만으론 안 막혀서 body 를 `position:fixed` 로 고정하고 스크롤 위치를 보존·복원한다.
 * PC 는 스크롤바가 사라지며 생기는 폭 변화를 padding-right 로 메운다.
 */
let count = 0;
let savedY = 0;
let saved: { position: string; top: string; left: string; right: string; width: string; overflow: string; paddingRight: string } | null = null;

function lock(): void {
	if (count++ > 0) return;
	const body = document.body;
	const html = document.documentElement;
	savedY = window.scrollY;
	const scrollbar = window.innerWidth - html.clientWidth;
	const s = body.style;
	saved = { position: s.position, top: s.top, left: s.left, right: s.right, width: s.width, overflow: s.overflow, paddingRight: s.paddingRight };
	s.position = 'fixed';
	s.top = `${-savedY}px`;
	s.left = '0';
	s.right = '0';
	s.width = '100%';
	s.overflow = 'hidden';
	if (scrollbar > 0) s.paddingRight = `${scrollbar}px`;
}

function unlock(): void {
	if (count === 0 || --count > 0) return;
	const s = document.body.style;
	if (saved) {
		s.position = saved.position;
		s.top = saved.top;
		s.left = saved.left;
		s.right = saved.right;
		s.width = saved.width;
		s.overflow = saved.overflow;
		s.paddingRight = saved.paddingRight;
		saved = null;
	}
	window.scrollTo(0, savedY);
}

export function scrollLock(_node: HTMLElement): { destroy(): void } {
	lock();
	return { destroy: unlock };
}
