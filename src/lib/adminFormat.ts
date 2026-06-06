/** 관리자 대시보드 표시용 순수 포맷 함수(클라이언트). */

/** USD 비용. 비용이 작아(보통 $0.000x) 기본 소수 4자리, 정밀 표시는 digits 로 조정. */
export function usd(n: number | null | undefined, digits = 4): string {
	return '$' + (n ?? 0).toFixed(digits);
}

/** 정수 천단위 구분. */
export function num(n: number | null | undefined): string {
	return (n ?? 0).toLocaleString('en-US');
}

/** epoch ms → 'YYYY-MM-DD'. */
export function date(ms: number | null | undefined): string {
	if (!ms) return '—';
	return new Date(ms).toLocaleDateString('ko-KR', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
}

/** epoch ms → 'YYYY-MM-DD HH:MM'. */
export function dateTime(ms: number | null | undefined): string {
	if (!ms) return '—';
	return new Date(ms).toLocaleString('ko-KR', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	});
}

/** epoch ms → '3일 전' 같은 상대 표현(최근 활동 표시용). */
export function ago(ms: number | null | undefined): string {
	if (!ms) return '—';
	const diff = Date.now() - ms;
	const day = 86_400_000;
	if (diff < 60_000) return '방금';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
	if (diff < day) return `${Math.floor(diff / 3_600_000)}시간 전`;
	if (diff < day * 30) return `${Math.floor(diff / day)}일 전`;
	return date(ms);
}
