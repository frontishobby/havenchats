// API 키 관리 모달 열림 상태 (네비바 드롭다운 'API 키 관리' 에서 공유)
export const apiKeyModal = $state({ open: false });

export function openApiKeyModal() {
	apiKeyModal.open = true;
}
