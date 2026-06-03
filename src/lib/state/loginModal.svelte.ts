// 로그인 모달 열림 상태 (헤더·채팅 등 여러 곳에서 공유)
export const loginModal = $state({ open: false });

export function openLogin() {
	loginModal.open = true;
}
