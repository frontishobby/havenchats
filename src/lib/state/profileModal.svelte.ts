// 프로필 설정 모달 열림 상태 (네비바 이름 클릭·최초 로그인 시 공유)
export const profileModal = $state({ open: false });

export function openProfile() {
	profileModal.open = true;
}
