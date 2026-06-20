import type {
	AdminUserRow,
	AdminSummary,
	AdminUserDetail,
	UserStats,
	AdminCharacter,
	ModelStat,
	CharacterStat,
	DailyCost
} from '$lib/server/db/admin';
import type { InfraMetrics } from '$lib/server/cloudflare';
import type { BillingEstimate } from '$lib/server/cfPricing';

/**
 * 관리자 대시보드 API 의 공용(응답) 타입.
 * 워커 라우터(`worker/src/routes/api/admin.ts`)와 SPA 프론트가 같이 import 한다.
 * 단일 엔티티 타입은 `$lib/server/db/admin` 등에서 재사용하고, 여기엔 **합성(composite) 응답 형태만** 정의한다.
 */

/** GET /api/admin/overview — 관리자 메인(유저 목록 + 전체 요약). */
export interface AdminOverviewData {
	users: AdminUserRow[];
	summary: AdminSummary;
}

/** D1 binding 으로 직접 센 테이블별 행 수 1행. */
export interface AdminTableRow {
	table: string;
	rows: number;
}

/** GET /api/admin/infra — 인프라/과금 추정. */
export interface AdminInfraData {
	infra: InfraMetrics;
	rows: AdminTableRow[];
	billing: BillingEstimate;
}

/** GET /api/admin/stats — 사용 통계(모델/캐릭터/일별 비용). */
export interface AdminStatsData {
	models: ModelStat[];
	characters: CharacterStat[];
	daily: DailyCost[];
	trendDays: number;
	period: string;
	totalSpend: number;
}

/** GET /api/admin/users/:id — 유저 상세(프로필 + 사용량 + 제작 캐릭터). */
export interface AdminUserDetailData {
	detail: AdminUserDetail;
	stats: UserStats;
	characters: AdminCharacter[];
}

/** POST /api/admin/users/:id/block — 차단/해제 응답. */
export interface AdminBlockResult {
	blockedReason: string | null;
}
