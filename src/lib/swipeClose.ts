/**
 * use:swipeClose — 터치 스와이프로 드로어·바텀시트 닫기.
 *
 *  - dir 'left': 왼쪽 드로어(사이드바). 왼쪽으로 70px 이상, 세로 이동보다 뚜렷하면 닫는다.
 *  - dir 'down': 바텀시트. 아래로 70px 이상. 시트 안 스크롤이 맨 위(scrollTop 0)에서 시작한 터치만
 *    인식해 본문 스크롤과 충돌하지 않게 한다.
 *
 * 마우스·포인터 기기엔 아무 영향 없음(touch 이벤트만). 핸들 없이 시트 전체가 대상이지만
 * 입력창(textarea·input·select·range) 위에서 시작한 터치는 무시한다.
 */
export function swipeClose(
	node: HTMLElement,
	opts: { dir: 'left' | 'down'; onClose: () => void; threshold?: number }
) {
	let current = opts;
	let startX = 0;
	let startY = 0;
	let tracking = false;

	function isEditable(t: EventTarget | null): boolean {
		return t instanceof Element && !!t.closest('textarea, input, select, [contenteditable]');
	}

	function onStart(e: TouchEvent) {
		if (e.touches.length !== 1 || isEditable(e.target)) return;
		if (current.dir === 'down') {
			// 스크롤 가능한 조상이 맨 위가 아니면 스크롤 제스처로 둔다.
			let el = e.target as HTMLElement | null;
			while (el && el !== node) {
				if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) return;
				el = el.parentElement;
			}
			if (node.scrollTop > 0) return;
		}
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		tracking = true;
	}
	function onEnd(e: TouchEvent) {
		if (!tracking) return;
		tracking = false;
		const t = e.changedTouches[0];
		if (!t) return;
		const dx = t.clientX - startX;
		const dy = t.clientY - startY;
		const th = current.threshold ?? 70;
		if (current.dir === 'left' && dx < -th && Math.abs(dx) > Math.abs(dy) * 1.5) current.onClose();
		else if (current.dir === 'down' && dy > th && dy > Math.abs(dx) * 1.5) current.onClose();
	}
	function onCancel() {
		tracking = false;
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchend', onEnd, { passive: true });
	node.addEventListener('touchcancel', onCancel, { passive: true });
	return {
		update(next: typeof opts) {
			current = next;
		},
		destroy() {
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchend', onEnd);
			node.removeEventListener('touchcancel', onCancel);
		}
	};
}
