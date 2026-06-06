/**
 * 어드민 '인프라' 탭 — Cloudflare 지표 조회. (owner@example.com 전용, 게이트는 라우트 layout)
 *
 * 두 경로를 쓴다:
 *  - GraphQL Analytics API(`/client/v4/graphql`) — D1 쿼리수/행수, R2 저장량/작업수 (최근 31일 보존)
 *  - REST API(`/client/v4/...`) — D1 현재 크기, Pages 배포 목록
 *  - D1 binding 직접 쿼리 — 테이블별 행 수(아래 admin load 에서 합류)
 *
 * 인증: `.env`/Pages secret 의 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
 *   토큰엔 Account Analytics:Read, D1:Read, Pages:Read 권한이 필요(wrangler 배포 토큰엔 없을 수 있음).
 * 키 없음·권한 부족·일시 오류는 전부 null 로 graceful degrade — 인프라 페이지를 막지 않는다.
 */

import { env } from '$env/dynamic/private';

// wrangler.jsonc 와 일치하는 고정 식별자.
const D1_DATABASE_ID = 'b8c2b1a3-78e8-4527-aefa-461bcd3486b7';
const R2_BUCKET = 'haven-images';
const PAGES_PROJECT = 'havenchats';

const API = 'https://api.cloudflare.com/client/v4';
const DAY = 86_400_000;

function creds(): { token: string; account: string } | null {
	const token = env.CLOUDFLARE_API_TOKEN;
	const account = env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || !account) return null;
	return { token, account };
}

/** GraphQL Analytics 1회 호출. 실패(네트워크/권한/쿼리오류) 시 null. */
async function cfGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
	const c = creds();
	if (!c) return null;
	try {
		const res = await fetch(`${API}/graphql`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${c.token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ query, variables })
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { data?: { viewer?: { accounts?: T[] } }; errors?: unknown[] };
		if (json.errors?.length) return null;
		const acct = json.data?.viewer?.accounts?.[0];
		return (acct ?? null) as T | null;
	} catch {
		return null;
	}
}

/** REST GET → result. 실패 시 null. */
async function cfRest<T>(path: string): Promise<T | null> {
	const c = creds();
	if (!c) return null;
	try {
		const res = await fetch(`${API}${path}`, {
			headers: { Authorization: `Bearer ${c.token}` }
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { result?: T; success?: boolean };
		if (!json.success) return null;
		return json.result ?? null;
	} catch {
		return null;
	}
}

// ── D1 ──────────────────────────────────────────────────────────────────────

export interface D1Metrics {
	/** 현재 DB 파일 크기(bytes). REST. */
	sizeBytes: number | null;
	tableCount: number | null;
	/** 최근 7일 합계(Analytics). 권한/조회 실패 시 null. */
	last7d: {
		readQueries: number;
		writeQueries: number;
		rowsRead: number;
		rowsWritten: number;
	} | null;
}

const D1_QUERY = `
query D1Infra($acct: String!, $db: String!, $start: Date!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, databaseId: $db }
      ) {
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
    }
  }
}`;

async function fetchD1(): Promise<D1Metrics> {
	const start = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
	const acct = creds()?.account ?? '';

	const [rest, gql] = await Promise.all([
		cfRest<{ file_size?: number; num_tables?: number }>(`/accounts/${acct}/d1/database/${D1_DATABASE_ID}`),
		cfGraphql<{
			d1AnalyticsAdaptiveGroups: {
				sum: { readQueries: number; writeQueries: number; rowsRead: number; rowsWritten: number };
			}[];
		}>(D1_QUERY, { acct, db: D1_DATABASE_ID, start })
	]);

	let last7d: D1Metrics['last7d'] = null;
	if (gql) {
		const acc = { readQueries: 0, writeQueries: 0, rowsRead: 0, rowsWritten: 0 };
		for (const g of gql.d1AnalyticsAdaptiveGroups ?? []) {
			acc.readQueries += g.sum.readQueries ?? 0;
			acc.writeQueries += g.sum.writeQueries ?? 0;
			acc.rowsRead += g.sum.rowsRead ?? 0;
			acc.rowsWritten += g.sum.rowsWritten ?? 0;
		}
		last7d = acc;
	}

	return {
		sizeBytes: rest?.file_size ?? null,
		tableCount: rest?.num_tables ?? null,
		last7d
	};
}

// ── R2 ──────────────────────────────────────────────────────────────────────

export interface R2Op {
	action: string;
	requests: number;
	class: 'A' | 'B' | 'free';
}

export interface R2Metrics {
	/** 최신 저장 스냅샷. */
	storage: { objectCount: number; payloadSize: number; metadataSize: number } | null;
	/** 최근 7일 작업(actionType별, 요청수 내림차순). */
	ops: R2Op[] | null;
	/** 7일 클래스별 합계(R2 과금 구분). */
	classA: number;
	classB: number;
}

/** R2 actionType → 과금 클래스. 쓰기·목록=A, 읽기=B, 삭제 등=무료. prefix 휴리스틱. */
function r2Class(action: string): 'A' | 'B' | 'free' {
	if (/^Delete/.test(action)) return 'free';
	if (/^(Get|Head)/.test(action)) return 'B';
	if (/^(Put|Post|Copy|Create|Complete|List|Upload)/.test(action)) return 'A';
	return 'free';
}

const R2_STORAGE_QUERY = `
query R2Storage($acct: String!, $bucket: String!, $start: Time!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      r2StorageAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $start, bucketName: $bucket }
        orderBy: [datetime_DESC]
      ) {
        max { objectCount payloadSize metadataSize }
      }
    }
  }
}`;

const R2_OPS_QUERY = `
query R2Ops($acct: String!, $bucket: String!, $start: Time!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      r2OperationsAdaptiveGroups(
        limit: 100
        filter: { datetime_geq: $start, bucketName: $bucket }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

async function fetchR2(): Promise<R2Metrics> {
	const acct = creds()?.account ?? '';
	const opsStart = new Date(Date.now() - 7 * DAY).toISOString();
	const storageStart = new Date(Date.now() - 2 * DAY).toISOString(); // 스냅샷 주기 고려해 여유.

	const [storageRes, opsRes] = await Promise.all([
		cfGraphql<{
			r2StorageAdaptiveGroups: { max: { objectCount: number; payloadSize: number; metadataSize: number } }[];
		}>(R2_STORAGE_QUERY, { acct, bucket: R2_BUCKET, start: storageStart }),
		cfGraphql<{
			r2OperationsAdaptiveGroups: { sum: { requests: number }; dimensions: { actionType: string } }[];
		}>(R2_OPS_QUERY, { acct, bucket: R2_BUCKET, start: opsStart })
	]);

	const snap = storageRes?.r2StorageAdaptiveGroups?.[0]?.max ?? null;

	let ops: R2Op[] | null = null;
	let classA = 0;
	let classB = 0;
	if (opsRes) {
		ops = (opsRes.r2OperationsAdaptiveGroups ?? [])
			.map((g) => {
				const action = g.dimensions.actionType;
				const cls = r2Class(action);
				if (cls === 'A') classA += g.sum.requests;
				else if (cls === 'B') classB += g.sum.requests;
				return { action, requests: g.sum.requests, class: cls };
			})
			.sort((a, b) => b.requests - a.requests);
	}

	return { storage: snap, ops, classA, classB };
}

// ── Workers / Pages Functions ─────────────────────────────────────────────────

export interface WorkersMetrics {
	/** 최근 7일 합계(Analytics). 권한/조회 실패 시 null. */
	last7d: {
		requests: number;
		errors: number;
		/**
		 * 추정 총 CPU 시간(ms). 데이터셋에 CPU 합계가 없어서
		 * 일별 `requests × cpuTimeP50(µs, 중앙값)` 합을 ms 로 환산한 근사치다.
		 * 분포가 우측으로 치우쳐(꼬리 김) 실제보다 과소추정될 수 있음.
		 */
		cpuMsEst: number;
	} | null;
}

const WORKERS_QUERY = `
query Workers($acct: String!, $start: Date!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      pagesFunctionsInvocationsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start }
      ) {
        sum { requests errors }
        quantiles { cpuTimeP50 }
        dimensions { date }
      }
    }
  }
}`;

async function fetchWorkers(): Promise<WorkersMetrics> {
	const start = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
	const acct = creds()?.account ?? '';

	const gql = await cfGraphql<{
		pagesFunctionsInvocationsAdaptiveGroups: {
			sum: { requests: number; errors: number };
			quantiles: { cpuTimeP50: number };
			dimensions: { date: string };
		}[];
	}>(WORKERS_QUERY, { acct, start });

	if (!gql) return { last7d: null };

	let requests = 0;
	let errors = 0;
	let cpuUs = 0; // 마이크로초 누적.
	for (const g of gql.pagesFunctionsInvocationsAdaptiveGroups ?? []) {
		const r = g.sum.requests ?? 0;
		requests += r;
		errors += g.sum.errors ?? 0;
		cpuUs += r * (g.quantiles?.cpuTimeP50 ?? 0); // 요청수 × 그날 중앙 CPU(µs).
	}
	return { last7d: { requests, errors, cpuMsEst: cpuUs / 1000 } };
}

// ── Pages ────────────────────────────────────────────────────────────────────

export interface PagesDeployment {
	shortId: string;
	environment: 'production' | 'preview';
	status: string; // latest_stage.status: success/failure/active...
	stage: string; // latest_stage.name: deploy/build/...
	createdAt: number; // epoch ms
	branch: string | null;
	url: string | null;
}

interface RawDeployment {
	short_id?: string;
	id?: string;
	environment?: string;
	created_on?: string;
	url?: string;
	latest_stage?: { name?: string; status?: string };
	deployment_trigger?: { metadata?: { branch?: string } };
}

async function fetchPages(): Promise<PagesDeployment[] | null> {
	const acct = creds()?.account ?? '';
	const list = await cfRest<RawDeployment[]>(
		`/accounts/${acct}/pages/projects/${PAGES_PROJECT}/deployments?per_page=10`
	);
	if (!list) return null;
	return list.map((d) => ({
		shortId: d.short_id ?? d.id?.slice(0, 8) ?? '—',
		environment: d.environment === 'production' ? 'production' : 'preview',
		status: d.latest_stage?.status ?? 'unknown',
		stage: d.latest_stage?.name ?? '—',
		createdAt: d.created_on ? new Date(d.created_on).getTime() : 0,
		branch: d.deployment_trigger?.metadata?.branch ?? null,
		url: d.url ?? null
	}));
}

// ── orchestration ─────────────────────────────────────────────────────────────

export interface InfraMetrics {
	/** 토큰/계정 미설정 시 true — 페이지에 안내만 표시. */
	configured: boolean;
	workers: WorkersMetrics;
	d1: D1Metrics;
	r2: R2Metrics;
	pages: PagesDeployment[] | null;
}

/** 인프라 탭 전체 지표(Workers·D1·R2·Pages)를 병렬로 조회. */
export async function fetchInfraMetrics(): Promise<InfraMetrics> {
	if (!creds()) {
		return {
			configured: false,
			workers: { last7d: null },
			d1: { sizeBytes: null, tableCount: null, last7d: null },
			r2: { storage: null, ops: null, classA: 0, classB: 0 },
			pages: null
		};
	}
	const [workers, d1, r2, pages] = await Promise.all([
		fetchWorkers(),
		fetchD1(),
		fetchR2(),
		fetchPages()
	]);
	return { configured: true, workers, d1, r2, pages };
}
