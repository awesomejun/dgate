/**
 * `src/decision/stats.ts` — Phase B PB-2A: 비용 인식 동적 라우팅(θ_sharp)과
 * 구간 합집합 기반 실행/대기 시간 통계 (loopforge-arch-hydrogen.md §3.2 + plan-phase-b §2·§3).
 *
 * 목적:
 * - B2: `θ_sharp = clamp((C_eff(explore)+C_switch)/(C_eff(lead)+C_switch), 0.70, 0.90)`
 *   — 상수 0.70 대신 탐색/리드 상대비용과 쿼터 희소도 승수(κ_quota)로 임계치를 산출한다.
 * - B2: `decision_events.cost_status` 집계 — 'unknown' 이벤트를 $0으로 위장 합산하지 않는다.
 * - B3: `fork_intervals`의 exec/wait/human 구간을 합집합으로 측정해 병렬 중복을 제거한다.
 *
 * 외부 연결:
 * - `scripts/dispatch.ts`가 `computeDynamicSharpThreshold`로 θ를 산출해 `engine.evaluateRoute`에 전달한다.
 * - 읽기 전용 — `settleOrphans` 등 쓰기 경로를 절대 호출하지 않는다(v1 DB readOnly 안전).
 *
 * 주의:
 * - v1 DB 호환: `cost_status` 컬럼/`fork_intervals` 테이블 부재 시 예외 없이 안전 반환한다.
 * - `θ` 하한은 `SHARP_P_THRESHOLD`(0.70) — 어떤 비용 설정에서도 하향하지 않는다(표본 정직성).
 * - `erasableSyntaxOnly` — enum·파라미터 프로퍼티 금지.
 */
import type { DatabaseSync } from 'node:sqlite';
import { hasColumn, hasTable } from './db.ts';
import { SHARP_P_THRESHOLD } from './engine.ts';
import {
  effectiveQuotaBucket,
  type RoleSlot,
  type RoleWorkerSpec,
  type RosterProfile,
} from './roster.ts';

// ---------- B2: 비용 인식 동적 sharp 임계치 (arch §3.2) ----------

/** θ_sharp 하한 — 현행 상수와 동일(0.70). 표본 정직성 보호를 위해 하향 금지 */
export const SHARP_FLOOR = SHARP_P_THRESHOLD;
/** θ_sharp 상한 — 탐색이 리드보다 비싼 프로필의 실패 비용 폭등 방지 */
export const SHARP_CEIL = 0.9;
/** 전환 오버헤드 상대비용 C_switch (arch §3.2) */
export const C_SWITCH_REL = 1.5;

/** `pricing.relativeCost` 미지정 시 슬롯 기본 상대비용 (1.0 = deepseek-flash 기준) */
export const SLOT_DEFAULT_RELATIVE_COST: Record<RoleSlot, number> = {
  lead: 5.0,
  explore: 1.0,
  coder: 3.0,
  verifier: 1.5,
  advisor: 8.0,
};

/**
 * 쿼터 희소도 승수 κ_quota(b) = 1 + 4·max(0, turnsUsed/budget − 0.5)².
 * 예산 미정의·0이면 1.0(중립). 50% 이하 → 1.0, 100% → 2.0.
 */
export function computeQuotaMultiplier(turnsUsed: number, dailyBudget: number): number {
  if (!(dailyBudget > 0)) return 1;
  const over = turnsUsed / dailyBudget - 0.5;
  return 1 + 4 * Math.pow(Math.max(0, over), 2);
}

/** 슬롯의 유효 상대비용 — 명시 `pricing.relativeCost`(유효 숫자·비음수) 우선, 아니면 슬롯 기본값 */
function relativeCostOf(slot: RoleSlot, spec: RoleWorkerSpec | undefined): number {
  const rel = spec?.pricing?.relativeCost;
  if (typeof rel === 'number' && Number.isFinite(rel) && rel >= 0) return rel;
  return SLOT_DEFAULT_RELATIVE_COST[slot];
}

export interface DynamicSharpThresholdInput {
  profile: RosterProfile;
  /** 버킷별 오늘 사용 턴 수 (예: `{ agy: 15 }`). 미지정 버킷은 사용량 0 → κ=1.0 */
  bucketUsage?: Record<string, number>;
  /** 전환 오버헤드 — 기본 C_SWITCH_REL = 1.5 */
  switchCost?: number;
  /** 하한 — 기본 SHARP_FLOOR = 0.70 */
  floor?: number;
  /** 상한 — 기본 SHARP_CEIL = 0.90 */
  ceil?: number;
}

export interface DynamicSharpThresholdResult {
  /** clamp((exploreCost + switch) / (leadCost + switch), floor, ceil) */
  threshold: number;
  /** κ 반영 후 탐색 슬롯 유효 비용 C_eff(explore) */
  exploreCost: number;
  /** κ 반영 후 리드 슬롯 유효 비용 C_eff(lead) */
  leadCost: number;
  exploreMultiplier: number;
  leadMultiplier: number;
}

/**
 * 프로필 기반 동적 sharp 임계치 (arch §3.2).
 * 기본 `quota-saver`(explore=1.0, lead=5.0, switch=1.5) → 2.5/6.5 = 0.3846 → 0.70
 * (기존 상수와 정확히 일치). `C_eff(lead)+switch <= 0`이면 보수 최대 ceil 반환.
 */
export function computeDynamicSharpThreshold(
  input: DynamicSharpThresholdInput
): DynamicSharpThresholdResult {
  const switchCost = input.switchCost ?? C_SWITCH_REL;
  const floor = input.floor ?? SHARP_FLOOR;
  const ceil = input.ceil ?? SHARP_CEIL;
  const usage = input.bucketUsage ?? {};
  const budgets = input.profile.dailyTurnBudgets ?? {};

  const slotMultiplier = (slot: RoleSlot): { spec: RoleWorkerSpec | undefined; m: number } => {
    const spec = input.profile.roles?.[slot];
    const bucket = spec ? effectiveQuotaBucket(spec) : undefined;
    const used = bucket ? (usage[bucket] ?? 0) : 0;
    const budget = bucket ? (budgets[bucket] ?? 0) : 0;
    return { spec, m: computeQuotaMultiplier(used, budget) };
  };

  const ex = slotMultiplier('explore');
  const ld = slotMultiplier('lead');
  const exploreCost = relativeCostOf('explore', ex.spec) * ex.m;
  const leadCost = relativeCostOf('lead', ld.spec) * ld.m;
  const denom = leadCost + switchCost;
  // 분모 0 방어: 비용 정보가 붕괴한 경우 보수 최대치로 고정
  const ratio = denom > 0 ? (exploreCost + switchCost) / denom : Number.POSITIVE_INFINITY;
  const threshold = Math.min(ceil, Math.max(floor, ratio));
  return {
    threshold,
    exploreCost,
    leadCost,
    exploreMultiplier: ex.m,
    leadMultiplier: ld.m,
  };
}

// ---------- B2: 비용 통계 (decision_events cost_status 집계) ----------

export interface CostStatsOptions {
  projectId?: string;
  days?: number;
  nowMs?: number;
}

export interface CostStatusBucket {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
}

export interface CostStatsResult {
  /** v1 DB(cost_status 컬럼 부재) — 집계 불가를 명시한다 */
  schema_v1: boolean;
  total_events: number;
  /** cost_status별 이벤트 건수 */
  by_status: { reported: number; estimated: number; unknown: number };
  /** cost_status별 건수·토큰·금액 상세 */
  per_status: Record<'reported' | 'estimated' | 'unknown', CostStatusBucket>;
  reported_usd: number;
  estimated_usd: number;
  /** reported + estimated — 실제 알려진 금액만의 합 */
  known_usd: number;
  unknown_events: number;
  /** 불변식 C-1: unknown_events > 0이면 반드시 null ($0 위장 합산 금지) */
  total_usd_display: number | null;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
}

function emptyCostBucket(): CostStatusBucket {
  return { events: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0 };
}

/**
 * `decision_events` 비용 집계 (읽기 전용).
 * v1 DB(cost_status 부재)는 전 건을 unknown으로 안전 반환한다.
 */
export function computeCostStats(db: DatabaseSync, opts: CostStatsOptions = {}): CostStatsResult {
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.days !== undefined ? nowMs - opts.days * 86_400_000 : null;

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.projectId) {
    where.push('project_id = ?');
    params.push(opts.projectId);
  }
  if (sinceMs !== null) {
    where.push('created_at_ms >= ?');
    params.push(sinceMs);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  const base: CostStatsResult = {
    schema_v1: true,
    total_events: 0,
    by_status: { reported: 0, estimated: 0, unknown: 0 },
    per_status: { reported: emptyCostBucket(), estimated: emptyCostBucket(), unknown: emptyCostBucket() },
    reported_usd: 0,
    estimated_usd: 0,
    known_usd: 0,
    unknown_events: 0,
    total_usd_display: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };

  if (!hasTable(db, 'decision_events')) return base;

  if (!hasColumn(db, 'decision_events', 'cost_status')) {
    // v1 안전 반환 — 비용 메타가 없으므로 전 건을 unknown으로 보고한다
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM decision_events${whereSql}`)
      .get(...params) as { n: number } | undefined;
    const n = row?.n ?? 0;
    base.total_events = n;
    base.unknown_events = n;
    base.by_status.unknown = n;
    base.per_status.unknown.events = n;
    return base;
  }

  const rows = db
    .prepare(
      `SELECT cost_status AS st, COUNT(*) AS n,
              COALESCE(SUM(input_tokens), 0)       AS ti,
              COALESCE(SUM(output_tokens), 0)      AS to_,
              COALESCE(SUM(cache_read_tokens), 0)  AS tcr,
              COALESCE(SUM(cache_write_tokens), 0) AS tcw,
              COALESCE(SUM(cost_usd), 0)           AS usd
         FROM decision_events${whereSql}
        GROUP BY cost_status`
    )
    .all(...params) as {
    st: string;
    n: number;
    ti: number;
    to_: number;
    tcr: number;
    tcw: number;
    usd: number;
  }[];

  let total = 0;
  for (const r of rows) {
    const st = r.st === 'reported' || r.st === 'estimated' ? r.st : 'unknown';
    const bucket = base.per_status[st];
    bucket.events += r.n;
    bucket.input_tokens += r.ti;
    bucket.output_tokens += r.to_;
    bucket.cache_read_tokens += r.tcr;
    bucket.cache_write_tokens += r.tcw;
    bucket.usd += r.usd;
    total += r.n;
    if (st === 'reported') base.reported_usd += r.usd;
    else if (st === 'estimated') base.estimated_usd += r.usd;
    else base.unknown_events += r.n;
  }
  base.schema_v1 = false;
  base.total_events = total;
  base.by_status = {
    reported: base.per_status.reported.events,
    estimated: base.per_status.estimated.events,
    unknown: base.per_status.unknown.events,
  };
  base.known_usd = base.reported_usd + base.estimated_usd;
  base.tokens = {
    input: base.per_status.reported.input_tokens + base.per_status.estimated.input_tokens + base.per_status.unknown.input_tokens,
    output: base.per_status.reported.output_tokens + base.per_status.estimated.output_tokens + base.per_status.unknown.output_tokens,
    cache_read: base.per_status.reported.cache_read_tokens + base.per_status.estimated.cache_read_tokens + base.per_status.unknown.cache_read_tokens,
    cache_write: base.per_status.reported.cache_write_tokens + base.per_status.estimated.cache_write_tokens + base.per_status.unknown.cache_write_tokens,
  };
  // 불변식 C-1: unknown이 1건이라도 있으면 총액 표시 자체를 거부한다
  base.total_usd_display = base.unknown_events > 0 ? null : base.known_usd;
  return base;
}

// ---------- B3: 구간 합집합 타이밍 통계 (fork_intervals) ----------

export interface UnionInterval {
  start: number;
  end: number;
}

export interface UnionResult {
  /** 겹침·인접 병합 후 실측 길이 합 (ms) */
  unionMs: number;
  /** 병합 없는 단순 합 (ms) — 병렬 처리량 지표 */
  sumMs: number;
  /** 유효하지 않아 버린 구간 수 (end < start, 비유한 값) */
  dropped: number;
}

/**
 * 구간 합집합 길이 측정 — 시작 시각 정렬 후 겹치거나 인접한(s <= curE) 구간을 병합한다.
 * 인접 병합([0,100]+[100,200] → 200)이 빈틈을 만들지 않는다.
 */
export function unionIntervalsMs(intervals: ReadonlyArray<UnionInterval>): UnionResult {
  const segs: Array<[number, number]> = [];
  let dropped = 0;
  let sumMs = 0;
  for (const it of intervals) {
    const s = it.start;
    const e = it.end;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
      dropped += 1;
      continue;
    }
    segs.push([s, e]);
    sumMs += e - s;
  }
  segs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let unionMs = 0;
  let curS = -1;
  let curE = -1;
  for (const [s, e] of segs) {
    if (curS < 0) {
      curS = s;
      curE = e;
      continue;
    }
    if (s <= curE) {
      if (e > curE) curE = e;
    } else {
      unionMs += curE - curS;
      curS = s;
      curE = e;
    }
  }
  if (curS >= 0) unionMs += curE - curS;
  return { unionMs, sumMs, dropped };
}

export interface TimingStatsOptions {
  projectId?: string;
  forkId?: string;
  days?: number;
  nowMs?: number;
}

export interface TimingStatsResult {
  /** v1 DB(fork_intervals 테이블 부재) — 구간 데이터 없음을 명시한다 */
  intervals_unavailable: boolean;
  /** 구간 보유 fork / 전체 fork */
  coverage_ratio: number;
  /** exec 구간 합집합 — 병렬 중복 제거된 실제 실행 시간 */
  execution_ms: number;
  /** exec 단순 합 — 병렬 포함 처리량 */
  sum_execution_ms: number;
  /** max(0, sum_execution_ms - execution_ms) — 병렬화로 절약한 시간 */
  parallel_gain_ms: number;
  /** wait 구간 합집합 — 발행~실행 개시·종료~종결 대기 */
  wait_ms: number;
  /** human 구간 합집합 — 사람 승인/파킹 */
  human_wait_ms: number;
  /** 전체 구간 최소 start ~ 최대 end */
  wall_ms: number;
  /** 버린 비정상 구간 수 */
  dropped: number;
  forks_total: number;
  forks_with_intervals: number;
  intervals: number;
}

const TIMING_V1_FALLBACK: TimingStatsResult = {
  intervals_unavailable: true,
  coverage_ratio: 0,
  execution_ms: 0,
  sum_execution_ms: 0,
  parallel_gain_ms: 0,
  wait_ms: 0,
  human_wait_ms: 0,
  wall_ms: 0,
  dropped: 0,
  forks_total: 0,
  forks_with_intervals: 0,
  intervals: 0,
};

/**
 * `fork_intervals` 기반 실행/대기 통계 (읽기 전용).
 * v1 DB(테이블 부재)는 `intervals_unavailable: true` + 전부 0으로 안전 반환한다.
 * 열린 구간(end NULL)은 nowMs로 절단해 미래로 새어 나가지 않게 한다.
 */
export function computeTimingStats(db: DatabaseSync, opts: TimingStatsOptions = {}): TimingStatsResult {
  if (!hasTable(db, 'fork_intervals') || !hasTable(db, 'forks')) {
    return { ...TIMING_V1_FALLBACK };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.days !== undefined ? nowMs - opts.days * 86_400_000 : null;

  // fork 스코프 총수 (coverage 분모)
  const forkWhere: string[] = [];
  const forkParams: Array<string | number> = [];
  if (opts.forkId) {
    forkWhere.push('fork_id = ?');
    forkParams.push(opts.forkId);
  }
  if (opts.projectId) {
    forkWhere.push('project_id = ?');
    forkParams.push(opts.projectId);
  }
  if (sinceMs !== null) {
    forkWhere.push('created_at_ms >= ?');
    forkParams.push(sinceMs);
  }
  const forkSql = `SELECT COUNT(*) AS n FROM forks${forkWhere.length ? ` WHERE ${forkWhere.join(' AND ')}` : ''}`;
  const forksTotal =
    (db.prepare(forkSql).get(...forkParams) as { n: number } | undefined)?.n ?? 0;

  // 구간 수집: fork 스코프에 JOIN, 윈도 겹침(end >= since 또는 미종결)만
  const ivWhere: string[] = [];
  const ivParams: Array<string | number> = [];
  if (opts.forkId) {
    ivWhere.push('fi.fork_id = ?');
    ivParams.push(opts.forkId);
  }
  if (opts.projectId) {
    ivWhere.push('f.project_id = ?');
    ivParams.push(opts.projectId);
  }
  if (sinceMs !== null) {
    ivWhere.push('(fi.ended_at_ms IS NULL OR fi.ended_at_ms >= ?)');
    ivParams.push(sinceMs);
  }
  const rows = db
    .prepare(
      `SELECT fi.fork_id, fi.phase, fi.started_at_ms, fi.ended_at_ms
         FROM fork_intervals fi JOIN forks f ON f.fork_id = fi.fork_id
        ${ivWhere.length ? `WHERE ${ivWhere.join(' AND ')}` : ''}`
    )
    .all(...ivParams) as {
    fork_id: string;
    phase: string;
    started_at_ms: number;
    ended_at_ms: number | null;
  }[];

  // 윈도 클램프 + phase별 구간 분류
  const clipLo = sinceMs ?? Number.NEGATIVE_INFINITY;
  const clipHi = nowMs;
  const byPhase: Record<'exec' | 'wait' | 'human', UnionInterval[]> = { exec: [], wait: [], human: [] };
  const coveredForks = new Set<string>();
  let dropped = 0;
  for (const r of rows) {
    const s = Math.max(r.started_at_ms, clipLo);
    const e = Math.min(r.ended_at_ms ?? clipHi, clipHi);
    if (e < s) {
      dropped += 1;
      continue;
    }
    const phase = r.phase === 'exec' || r.phase === 'wait' || r.phase === 'human' ? r.phase : 'wait';
    byPhase[phase].push({ start: s, end: e });
    coveredForks.add(r.fork_id);
  }

  const execRes = unionIntervalsMs(byPhase.exec);
  const waitRes = unionIntervalsMs(byPhase.wait);
  const humanRes = unionIntervalsMs(byPhase.human);

  let wallMs = 0;
  const allSegs = [...byPhase.exec, ...byPhase.wait, ...byPhase.human];
  if (allSegs.length > 0) {
    let minS = Number.POSITIVE_INFINITY;
    let maxE = Number.NEGATIVE_INFINITY;
    for (const seg of allSegs) {
      if (seg.start < minS) minS = seg.start;
      if (seg.end > maxE) maxE = seg.end;
    }
    wallMs = maxE - minS;
  }

  return {
    intervals_unavailable: false,
    coverage_ratio: forksTotal > 0 ? coveredForks.size / forksTotal : 0,
    execution_ms: execRes.unionMs,
    sum_execution_ms: execRes.sumMs,
    parallel_gain_ms: Math.max(0, execRes.sumMs - execRes.unionMs),
    wait_ms: waitRes.unionMs,
    human_wait_ms: humanRes.unionMs,
    wall_ms: wallMs,
    dropped: dropped + execRes.dropped + waitRes.dropped + humanRes.dropped,
    forks_total: forksTotal,
    forks_with_intervals: coveredForks.size,
    intervals: rows.length,
  };
}
