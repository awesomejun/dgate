/**
 * Sublead 제안 엔진 (`dg suggest-sublead`, docs/sublead-design.md).
 *
 * decision.db(`forks`·`decision_events`·fork 메타데이터)에서 3축 신호를 읽어
 * LLM 호출 0회로 sublead 도입 여부·추천 수·영역 배치·예상 상한을 산출한다.
 * Rust `crates/dgate-core/src/suggest_sublead.rs`와 규칙·점수·출력 키가 대칭이다.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface SubleadSuggestSignals {
  activeForks: number;
  reworkOrBackpropCount: number;
  avgVerdictLatencyMs: number;
  activeWrapWorkers: number;
  /** 활성 fork들의 repo_scope(또는 작업 영역 경로) 목록 */
  activeScopes: string[];
  multiEditOrSwarmCount: number;
  maxGenerationOrAttempt: number;
  largeBlastCount: number;
  /** 설정 상한(2~4, 기본 2) */
  maxSubleadsCap?: number;
}

export interface SubleadSuggestResult {
  recommended: boolean;
  loadScore: number;
  separationScore: number;
  taskScopeScore: number;
  overallScore: number;
  disjointGroups: string[];
  suggestedSubleads: number;
  maxSubleadsCap: number;
  summary: string;
  signals: SubleadSuggestSignals;
}

function clampCap(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 2;
  return Math.min(4, Math.max(2, Math.floor(raw)));
}

function normalizeScope(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function scopesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 활성 `repo_scope` 목록을 겹치지 않는(disjoint) 대표 영역 그룹으로 묶는다.
 * 한 경로가 다른 경로의 접두사이면 같은 영역 그룹으로 합친다.
 */
export function groupDisjointScopes(rawScopes: readonly string[]): string[] {
  const unique = Array.from(
    new Set(rawScopes.map(normalizeScope).filter((s) => s.length > 0))
  ).sort((a, b) => a.length - b.length || a.localeCompare(b));

  const groups: string[] = [];
  for (const scope of unique) {
    if (!groups.some((g) => scopesOverlap(g, scope))) {
      groups.push(scope);
    }
  }
  return groups;
}

/** 3축 신호로부터 sublead 추천 점수와 문구를 계산한다(순수 함수 — LLM 호출 0). */
export function evaluateSubleadSuggestion(signals: SubleadSuggestSignals): SubleadSuggestResult {
  // 축 1: 리드 세션 부하 (0..100)
  let loadScore = 0;
  if (signals.activeForks >= 4) loadScore += 40;
  else if (signals.activeForks >= 2) loadScore += 20;
  if (signals.reworkOrBackpropCount >= 2) loadScore += 30;
  else if (signals.reworkOrBackpropCount >= 1) loadScore += 15;
  if (signals.avgVerdictLatencyMs >= 300_000) loadScore += 15;
  else if (signals.avgVerdictLatencyMs >= 120_000) loadScore += 8;
  if (signals.activeWrapWorkers >= 3) loadScore += 15;
  else if (signals.activeWrapWorkers >= 2) loadScore += 8;
  loadScore = Math.min(100, loadScore);

  // 축 2: 영역 분리 가능성 (0..100) — 겹침 없는 그룹 ≥2개여야 sublead 분리 이득
  const disjointGroups = groupDisjointScopes(signals.activeScopes);
  let separationScore = 0;
  if (disjointGroups.length >= 3) separationScore = 100;
  else if (disjointGroups.length === 2) separationScore = 75;
  else if (disjointGroups.length === 1) separationScore = 20;

  // 축 3: task 범위 (0..100)
  let taskScopeScore = 0;
  if (signals.multiEditOrSwarmCount >= 3) taskScopeScore += 40;
  else if (signals.multiEditOrSwarmCount >= 2) taskScopeScore += 25;
  else if (signals.multiEditOrSwarmCount >= 1) taskScopeScore += 10;
  if (signals.maxGenerationOrAttempt >= 3) taskScopeScore += 30;
  else if (signals.maxGenerationOrAttempt >= 2) taskScopeScore += 15;
  if (signals.largeBlastCount >= 1) taskScopeScore += 30;
  taskScopeScore = Math.min(100, taskScopeScore);

  const overallScore = Math.round((loadScore + separationScore + taskScopeScore) / 3);
  const maxSubleadsCap = clampCap(signals.maxSubleadsCap);
  const recommended =
    disjointGroups.length >= 2 &&
    (loadScore >= 40 || taskScopeScore >= 50) &&
    overallScore >= 50;
  const suggestedSubleads = recommended
    ? Math.min(maxSubleadsCap, Math.max(2, disjointGroups.length))
    : 0;

  const summary = recommended
    ? `sublead ${suggestedSubleads}개 분리 권장 (상한 ${maxSubleadsCap}, 3축 점수: 부하 ${loadScore} · 분리 ${separationScore} · 범위 ${taskScopeScore}) — 비겹침 영역: ${disjointGroups.join(', ')}`
    : `단일 리드 유지 권장 (3축 점수: 부하 ${loadScore} · 분리 ${separationScore} · 범위 ${taskScopeScore}, 비겹침 영역 ${disjointGroups.length}개)`;

  return {
    recommended,
    loadScore,
    separationScore,
    taskScopeScore,
    overallScore,
    disjointGroups,
    suggestedSubleads,
    maxSubleadsCap,
    summary,
    signals,
  };
}

/** decision.db에서 3축 신호를 읽기전용 집계한다. */
export function collectSubleadSignalsFromDb(
  db: DatabaseSync,
  opts: { projectId?: string | null; activeWorkersOverride?: number; maxSubleadsCap?: number; nowMs?: number } = {}
): SubleadSuggestSignals {
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  const recentWrapStart = nowMs - 30 * 60 * 1000;
  const projClause = opts.projectId ? 'AND project_id = ?' : '';
  const projParams = opts.projectId ? [opts.projectId] : [];

  type ForkRowLite = {
    status: string;
    route: string;
    tool_class: string;
    created_at_ms: number;
    closed_at_ms: number | null;
    generation: number | null;
    attempt: number | null;
    metadata_json: string | null;
  };

  const rows = db
    .prepare(
      `SELECT status, route, tool_class, created_at_ms, closed_at_ms, generation, attempt, metadata_json
       FROM forks
       WHERE created_at_ms >= ? ${projClause}`
    )
    .all(windowStart, ...projParams) as ForkRowLite[];

  let activeForks = 0;
  let reworkOrBackpropCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const activeScopes: string[] = [];
  let multiEditOrSwarmCount = 0;
  let maxGenerationOrAttempt = 1;
  let largeBlastCount = 0;

  for (const r of rows) {
    const isLive = r.status === 'open' || r.status === 'rework';
    if (isLive) activeForks += 1;
    if (r.status === 'rework' || r.status === 'backprop_fail' || (r.attempt ?? 1) > 1) {
      reworkOrBackpropCount += 1;
    }
    const dur = (r.closed_at_ms ?? nowMs) - r.created_at_ms;
    if (dur >= 0) {
      latencySum += dur;
      latencyCount += 1;
    }
    if (isLive && (r.route === 'delegate_swarm' || r.tool_class === 'file_edit')) {
      multiEditOrSwarmCount += 1;
    }
    const genAtt = Math.max(r.generation ?? 1, r.attempt ?? 1);
    if (genAtt > maxGenerationOrAttempt) maxGenerationOrAttempt = genAtt;

    let meta: Record<string, unknown> | null = null;
    if (r.metadata_json) {
      try {
        meta = JSON.parse(r.metadata_json) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    if (isLive) {
      const scope =
        (typeof meta?.repo_scope === 'string' && meta.repo_scope.trim()) ||
        (typeof meta?.title === 'string' && meta.title.trim()) ||
        '';
      if (scope) activeScopes.push(scope);
    }
    const blast = typeof meta?.blast_radius === 'string' ? meta.blast_radius : '';
    const door = typeof meta?.door === 'string' ? meta.door : '';
    if (blast.length >= 80 || door === 'one-way') {
      largeBlastCount += 1;
    }
  }

  let activeWrapWorkers = opts.activeWorkersOverride ?? 0;
  if (opts.activeWorkersOverride === undefined) {
    try {
      const wrow = db
        .prepare(
          `SELECT COUNT(DISTINCT fork_id) AS n FROM decision_events
           WHERE source = 'wrap' AND ts_ms >= ? AND fork_id IS NOT NULL ${projClause}`
        )
        .get(recentWrapStart, ...projParams) as { n?: number } | undefined;
      activeWrapWorkers = Number(wrow?.n ?? 0);
    } catch {
      activeWrapWorkers = 0;
    }
  }

  return {
    activeForks,
    reworkOrBackpropCount,
    avgVerdictLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
    activeWrapWorkers,
    activeScopes,
    multiEditOrSwarmCount,
    maxGenerationOrAttempt,
    largeBlastCount,
    maxSubleadsCap: opts.maxSubleadsCap,
  };
}
