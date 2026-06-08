/**
 * Cloudflare 사용량 기반 월 청구액 추정. (어드민 인프라 탭)
 *
 * 공개 Workers 유료 플랜 가격표 기준의 *추정치*다 — 정확한 청구는 Cloudflare 대시보드가 출처.
 *  - 저장량(D1 DB 크기 / R2 객체 크기)은 현재 스냅샷을 그대로 GB-month 로 본다.
 *  - 쿼리/행/작업 등 사용량은 **최근 7일** 지표를 ×(30/7) 로 월 환산해 추정한다.
 *  - 무료 허용량(월)을 먼저 차감하고 초과분에만 단가를 적용한다.
 *  - 지표가 없으면(권한/데이터 부족) 해당 항목은 available=false 로 표시(0 으로 오해 방지).
 *
 * 단가/허용량은 공개가 기준(2025): https://developers.cloudflare.com/.../pricing
 */

import type { InfraMetrics } from './cloudflare';

/** 7일 → 30일 환산 계수. */
const TO_MONTH = 30 / 7;
/** 과금 저장량은 10진 GB(10^9 bytes) 기준. */
const GB = 1e9;
const MILLION = 1e6;

/** Workers 유료 플랜 기본료(월, USD) — 구독(plan) 조회 실패 시 폴백 기본값. */
const BASE_FEE_FALLBACK = 5;

const PRICING = {
	workers: {
		requestsFree: 10_000_000, // 1,000만 req/월(기본료 포함)
		requestsRatePerMillion: 0.3,
		cpuMsFree: 30_000_000, // 3,000만 CPU-ms/월(기본료 포함)
		cpuMsRatePerMillion: 0.02
	},
	d1: {
		storageFreeGb: 5,
		storageRatePerGb: 0.75, // GB-month 초과분
		rowsReadFree: 25_000_000_000, // 25B/월
		rowsReadRatePerMillion: 0.001,
		rowsWrittenFree: 50_000_000, // 50M/월
		rowsWrittenRatePerMillion: 1.0
	},
	r2: {
		storageFreeGb: 10,
		storageRatePerGb: 0.015, // GB-month 초과분
		classAFree: 1_000_000, // 1M/월 (쓰기·목록)
		classARatePerMillion: 4.5,
		classBFree: 10_000_000, // 10M/월 (읽기)
		classBRatePerMillion: 0.36
	}
} as const;

export interface BillItem {
	name: string;
	/** 추정 월 사용량(unit 기준). 지표 없으면 null. */
	monthly: number | null;
	unit: 'gb' | 'count' | 'ms';
	/** 무료 허용량(unit 기준). */
	free: number;
	/** 추정 월 비용(USD). */
	cost: number;
	/** 지표 확보 여부(false 면 회색 처리·비용 0). */
	available: boolean;
	/** 사용량 환산 방식: 저장량은 스냅샷, 나머지는 7일→30일 환산. */
	projected: boolean;
}

export interface BillService {
	key: 'workers' | 'd1' | 'r2';
	label: string;
	subtotal: number;
	items: BillItem[];
}

export interface BillingEstimate {
	/** creds 미설정이면 false → 페이지에서 안내만. */
	available: boolean;
	monthlyTotal: number;
	baseFee: number;
	services: BillService[];
}

/** 무료 허용량 차감 후 초과분 단가 적용(백만 단위 단가). */
function meteredCost(monthly: number, free: number, ratePerMillion: number): number {
	return (Math.max(0, monthly - free) / MILLION) * ratePerMillion;
}

/** GB-month 초과분 단가 적용. */
function storageCost(bytes: number, freeGb: number, ratePerGb: number): number {
	return Math.max(0, bytes / GB - freeGb) * ratePerGb;
}

/** 인프라 지표 → 서비스별/총 월 청구 추정. */
export function estimateBilling(infra: InfraMetrics): BillingEstimate {
	if (!infra.configured) {
		return { available: false, monthlyTotal: 0, baseFee: BASE_FEE_FALLBACK, services: [] };
	}

	const p = PRICING;
	// 기본료·플랜명은 구독 조회(infra.plan)에서 동적으로. 권한 없음/오류면 공개가 기준으로 폴백.
	const baseFee = infra.plan?.baseFee ?? BASE_FEE_FALLBACK;
	const workersLabel = infra.plan
		? infra.plan.paid
			? `Workers 유료 플랜 (${infra.plan.name})`
			: `Workers 무료 플랜 (${infra.plan.name})`
		: 'Workers 유료 플랜';

	// ── Workers / Pages Functions ──
	const w = infra.workers.last7d;
	const reqMonthly = w ? w.requests * TO_MONTH : null;
	const cpuMonthly = w ? w.cpuMsEst * TO_MONTH : null;
	const wReqCost = reqMonthly != null ? meteredCost(reqMonthly, p.workers.requestsFree, p.workers.requestsRatePerMillion) : 0;
	const wCpuCost = cpuMonthly != null ? meteredCost(cpuMonthly, p.workers.cpuMsFree, p.workers.cpuMsRatePerMillion) : 0;

	const workersItems: BillItem[] = [
		{ name: '기본료', monthly: null, unit: 'count', free: 0, cost: baseFee, available: true, projected: false },
		{
			name: '요청',
			monthly: reqMonthly,
			unit: 'count',
			free: p.workers.requestsFree,
			cost: wReqCost,
			available: reqMonthly != null,
			projected: true
		},
		{
			name: 'CPU 시간',
			monthly: cpuMonthly,
			unit: 'ms',
			free: p.workers.cpuMsFree,
			cost: wCpuCost,
			available: cpuMonthly != null,
			projected: true
		}
	];
	const workersSubtotal = baseFee + wReqCost + wCpuCost;

	// ── D1 ──
	const d1 = infra.d1;
	const d1Size = d1.sizeBytes;
	const d1q = d1.last7d;
	const d1StorageCost = d1Size != null ? storageCost(d1Size, p.d1.storageFreeGb, p.d1.storageRatePerGb) : 0;
	const rowsReadMonthly = d1q ? d1q.rowsRead * TO_MONTH : null;
	const rowsWrittenMonthly = d1q ? d1q.rowsWritten * TO_MONTH : null;
	const d1ReadCost = rowsReadMonthly != null ? meteredCost(rowsReadMonthly, p.d1.rowsReadFree, p.d1.rowsReadRatePerMillion) : 0;
	const d1WriteCost = rowsWrittenMonthly != null ? meteredCost(rowsWrittenMonthly, p.d1.rowsWrittenFree, p.d1.rowsWrittenRatePerMillion) : 0;

	const d1Items: BillItem[] = [
		{
			name: '저장 용량',
			monthly: d1Size != null ? d1Size / GB : null,
			unit: 'gb',
			free: p.d1.storageFreeGb,
			cost: d1StorageCost,
			available: d1Size != null,
			projected: false
		},
		{
			name: '읽은 행',
			monthly: rowsReadMonthly,
			unit: 'count',
			free: p.d1.rowsReadFree,
			cost: d1ReadCost,
			available: rowsReadMonthly != null,
			projected: true
		},
		{
			name: '쓴 행',
			monthly: rowsWrittenMonthly,
			unit: 'count',
			free: p.d1.rowsWrittenFree,
			cost: d1WriteCost,
			available: rowsWrittenMonthly != null,
			projected: true
		}
	];

	// ── R2 ──
	const r2 = infra.r2;
	const r2Bytes = r2.storage ? r2.storage.payloadSize + r2.storage.metadataSize : null;
	const r2StorageCost = r2Bytes != null ? storageCost(r2Bytes, p.r2.storageFreeGb, p.r2.storageRatePerGb) : 0;
	const classAMonthly = r2.ops ? r2.classA * TO_MONTH : null;
	const classBMonthly = r2.ops ? r2.classB * TO_MONTH : null;
	const r2ACost = classAMonthly != null ? meteredCost(classAMonthly, p.r2.classAFree, p.r2.classARatePerMillion) : 0;
	const r2BCost = classBMonthly != null ? meteredCost(classBMonthly, p.r2.classBFree, p.r2.classBRatePerMillion) : 0;

	const r2Items: BillItem[] = [
		{
			name: '저장 용량',
			monthly: r2Bytes != null ? r2Bytes / GB : null,
			unit: 'gb',
			free: p.r2.storageFreeGb,
			cost: r2StorageCost,
			available: r2Bytes != null,
			projected: false
		},
		{
			name: 'Class A (쓰기·목록)',
			monthly: classAMonthly,
			unit: 'count',
			free: p.r2.classAFree,
			cost: r2ACost,
			available: classAMonthly != null,
			projected: true
		},
		{
			name: 'Class B (읽기)',
			monthly: classBMonthly,
			unit: 'count',
			free: p.r2.classBFree,
			cost: r2BCost,
			available: classBMonthly != null,
			projected: true
		}
	];

	const d1Subtotal = d1StorageCost + d1ReadCost + d1WriteCost;
	const r2Subtotal = r2StorageCost + r2ACost + r2BCost;

	const services: BillService[] = [
		{ key: 'workers', label: workersLabel, subtotal: workersSubtotal, items: workersItems },
		{ key: 'd1', label: 'D1', subtotal: d1Subtotal, items: d1Items },
		{ key: 'r2', label: 'R2', subtotal: r2Subtotal, items: r2Items }
	];

	return {
		available: true,
		monthlyTotal: workersSubtotal + d1Subtotal + r2Subtotal,
		baseFee,
		services
	};
}
