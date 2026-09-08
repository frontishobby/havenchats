// 저장소(Drive 연결·백업) 모달 열림 상태 — 레이아웃 메뉴·헤더 칩에서 연다.
export const storageModal = $state({ open: false });

export function openStorageModal() {
	storageModal.open = true;
}
