/**
 * Decision 통계 엔진 코어 (plan-r2.1 §2.0·§4).
 *
 * 목적: 감쇠 Beta(EWMA) 사후평균, 계층적 Shrinkage, 급성 회귀 강제 split(N7 카운터 분리),
 * 재시도 1회 실행=1행 불변식(B7), Fork 생명주기(발행→touch→닫힘→고아 TTL 정산→Neon backprop),
 * 자기 호출 제외(B6)까지 `dg` CLI·훅·매퍼·TUI가 공유하는 단일 구현을 제공한다.
 *
 * 외부 연결:
 * - `dg.ts`가 모든 명령의 판정·기록 경로로 호출한다.
 * - `telemetry.ts`가 `getPosterior`로 읽기전용 변환에 재사용한다.
 *
 * 주의:
 * - 상수(γ=0.92, M0=6, N_min=5, λ_max=0.25)와 p0 테이블은 §4.2~§4.3 확정값 그대로다.
 *   테스트(§7.2)가 이 값들의 기대치를 고정하므로 임의 변경 금지.
 * - 모든 갱신은 `BEGIN IMMEDIATE ... COMMIT` 단일 트랜잭션으로 실행한다(§3.2).
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { GLOBAL_PROJECT_ID } from './db.ts';

export type RouteId = 'file_select' | 'tool_select' | 'retry_or_abort' | 'delegate_swarm';
export type DecisionBasis = 'prior' | 'measured';
export type TaskKind =
  | 'explore_read'
  | 'code_search'
  | 'static_check'
  | 'single_edit'
  | 'multi_edit'
  | 'test_or_deploy'
  | 'swarm_fanout';
export type RiskLevel = 'low' | 'medium' | 'high';

export const ROUTE_IDS: readonly RouteId[] = ['file_select', 'tool_select', 'retry_or_abort', 'delegate_swarm'];
export const TASK_KINDS: readonly TaskKind[] = [
  'explore_read',
  'code_search',
  'static_check',
  'single_edit',
  'multi_edit',
  'test_or_deploy',
  'swarm_fanout',
];
export const EVENT_SOURCES = [
  'hook',
  'agy_stream',
  'transcript',
  'rest_api',
  'cli',
  'wrap',
  'ttl_orphan',
  'neon_backprop',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** EWMA 감쇠율 γ=0.92 (유효 윈도우 12.5건, 반감기 ≈ 8.3건) */
export const GAMMA = 0.92;
/** 가상 사전표본 크기 M0=6 (§4.3) */
export const M0 = 6.0;
/** 신뢰도 표지 전환 임계 (n_raw >= 5 → measured) */
export const N_MIN = 5;
/** 전역 풀 가중치 상한 λ_max=0.25 (타 프로젝트 오염 차단 — §4.2) */
export const LAMBDA_MAX = 0.25;
/** sharp 패스트패스 확신 기준 (§2.0 4조건 중 p 조건) */
export const SHARP_P_THRESHOLD = 0.7;
/** 연속 오류 강제 split 임계 (§4.4) */
export const FORCED_SPLIT_ERRORS = 2;
/** 역할별 TTL(ms): 탐색 600,000 / 코딩 3,600,000 (§4.6) */
export const TTL_EXPLORE_MS = 600_000;
export const TTL_CODING_MS = 3_600_000;
/** 재시도 판정: 직전 실패 이후 스텝 거리 (§4.5) */
export const RETRY_STEP_WINDOW = 3;

export function isRouteId(v: string): v is RouteId {
  return (ROUTE_IDS as readonly string[]).includes(v);
}

export function isEventSource(v: string): v is EventSource {
  return (EVENT_SOURCES as readonly string[]).includes(v);
}

/**
 * 사전확률 p0 테이블 (§4.3). 저사전 확신 키(shell_exec·delegate_swarm)는 콜드스타트
 * 1회 실패만으로 split 아래로 하강한다 — 의도된 보수 동작(N2).
 */
export function priorP0(route: RouteId, toolClass: string): number {
  const key = `${route}|${toolClass}`;
  switch (key) {
    case 'file_select|file_read':
      return 0.94;
    case 'file_select|file_edit':
      return 0.85;
    case 'tool_select|code_search':
      return 0.92;
    case 'tool_select|shell_exec':
      return 0.74;
    default:
      if (route === 'tool_select') return 0.88;
      if (route === 'retry_or_abort') return 0.85;
      if (route === 'delegate_swarm') return 0.8;
      return 0.88; // file_select 기타 — 미지 조합의 보수 기본값
  }
}

/**
 * 도구명 → (route, tool_class) 결정론적 분류 (§4.1 — 실측 `agy` 도구명 기준).
 * `isRetryContext === true`면 `route='retry_or_abort'`로 정규화한다(단일 행 귀속 — §4.5).
 */
export function classifyTool(
  toolName: string,
  args?: Record<string, unknown>,
  isRetryContext = false
): { route: RouteId; toolClass: string } {
  const name = toolName.trim();
  const fileRead = ['read_file', 'view_file', 'read', 'list_dir', 'find_by_name', 'find', 'ls'];
  const fileEdit = [
    'edit_file',
    'write_file',
    'edit',
    'write',
    // 타 CLI 호환 별칭(실측 미존재 — 주석 표기, §4.1)
    'replace_file_content',
    'multi_replace_file_content',
  ];
  const codeSearch = ['grep_search', 'grep', 'search_web'];
  const shellExec = ['run_command', 'bash', 'powershell', 'exec'];
  const swarm = ['invoke_subagent', 'hc_run', 'pi_explore', 'devin_worker', 'manage_subagents', 'swarm'];
  const otherTools = ['schedule', 'manage_task', 'ask_question', 'enter_plan_mode', 'exit_plan_mode'];

  let route: RouteId;
  let toolClass: string;
  if (fileRead.includes(name)) {
    route = 'file_select';
    toolClass = 'file_read';
  } else if (fileEdit.includes(name)) {
    route = 'file_select';
    toolClass = 'file_edit';
  } else if (codeSearch.includes(name)) {
    route = 'tool_select';
    toolClass = 'code_search';
  } else if (shellExec.includes(name)) {
    route = 'tool_select';
    toolClass = 'shell_exec';
  } else if (swarm.includes(name)) {
    route = 'delegate_swarm';
    toolClass = 'swarm_dispatch';
  } else {
    // schedule·manage_task·ask_question·enter/exit_plan_mode 및 기타 전부 (§4.1)
    route = 'tool_select';
    toolClass = 'other';
  }
  void args;
  if (isRetryContext) {
    return { route: 'retry_or_abort', toolClass };
  }
  return { route, toolClass };
}

/**
 * §2.0 task_kind 7종 결정표.
 * 주의: `static_check`은 읽기전용 pi(--tools read,grep,find,ls, bash 없음)가 수행할 수
 * 없으므로 sharpEligible=false다(verify-plan-r2.1 추가 관찰 반영). sharp 자격은
 * `explore_read`, `code_search` 2종뿐이다.
 */
export interface TaskKindSpec {
  taskKind: TaskKind;
  route: RouteId;
  toolClass: string;
  requiresWrite: boolean;
  defaultRisk: RiskLevel;
  sharpEligible: boolean;
}

const TASK_KIND_TABLE: Record<TaskKind, TaskKindSpec> = {
  explore_read: { taskKind: 'explore_read', route: 'file_select', toolClass: 'file_read', requiresWrite: false, defaultRisk: 'low', sharpEligible: true },
  code_search: { taskKind: 'code_search', route: 'tool_select', toolClass: 'code_search', requiresWrite: false, defaultRisk: 'low', sharpEligible: true },
  static_check: { taskKind: 'static_check', route: 'tool_select', toolClass: 'shell_exec', requiresWrite: false, defaultRisk: 'low', sharpEligible: false },
  single_edit: { taskKind: 'single_edit', route: 'file_select', toolClass: 'file_edit', requiresWrite: true, defaultRisk: 'medium', sharpEligible: false },
  multi_edit: { taskKind: 'multi_edit', route: 'file_select', toolClass: 'file_edit', requiresWrite: true, defaultRisk: 'high', sharpEligible: false },
  test_or_deploy: { taskKind: 'test_or_deploy', route: 'tool_select', toolClass: 'shell_exec', requiresWrite: true, defaultRisk: 'high', sharpEligible: false },
  swarm_fanout: { taskKind: 'swarm_fanout', route: 'delegate_swarm', toolClass: 'swarm_dispatch', requiresWrite: false, defaultRisk: 'medium', sharpEligible: false },
};

export function taskKindSpec(kind: string): TaskKindSpec | null {
  return (TASK_KINDS as readonly string[]).includes(kind)
    ? TASK_KIND_TABLE[kind as TaskKind]
    : null;
}

/** risk_level 상향만 허용 (low < medium < high — §2.0) */
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export function escalateRisk(base: RiskLevel, override?: RiskLevel): RiskLevel {
  if (!override) return base;
  return RISK_RANK[override] > RISK_RANK[base] ? override : base;
}

/**
 * 자기 호출 제외(B6): 게이트 활동(dg·dg-hook 호출)이 shell_exec 통계를 재먹이는
 * 피드백 루프를 차단한다. 명령문에서 토큰을 찾는다.
 */
export function isSelfInvocation(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes('src/decision/dg.ts') || text.includes('dg-hook.ts');
}

export interface PosteriorResult {
  p: number;
  basis: DecisionBasis;
  samples: number;
  consecutiveErrors: number;
  lambda: number;
  pHier: number;
  ewmaSuccess: number;
  ewmaFail: number;
}

interface StatsRow {
  ewma_success: number;
  ewma_fail: number;
  raw_samples: number;
  consecutive_errors: number;
}

function readStatsRow(db: DatabaseSync, projectId: string, route: RouteId, toolClass: string): StatsRow | null {
  const row = db
    .prepare(
      `SELECT ewma_success, ewma_fail, raw_samples, consecutive_errors
       FROM stats_summary WHERE project_id = ? AND route = ? AND tool_class = ?`
    )
    .get(projectId, route, toolClass) as StatsRow | undefined;
  return row ?? null;
}

/**
 * 계층적 Shrinkage + 감쇠 Beta 사후평균 (§4.2~§4.3).
 * p_glob는 전역 풀(__GLOBAL__) EWMA 합성에 M0·p0 사전을 결합하고,
 * p_hier = (1-λ)p0 + λ·p_glob (λ ≤ 0.25) 후 α_prior = M0·p_hier를 사전으로 같은
 * Beta 사후평균 식을 n<5 구간에도 연속 적용한다(점프 0 — basis 표지로만 구분).
 */
export function getPosterior(
  db: DatabaseSync,
  projectId: string,
  route: RouteId,
  toolClass: string
): PosteriorResult {
  const p0 = priorP0(route, toolClass);
  const local = readStatsRow(db, projectId, route, toolClass);
  const glob = readStatsRow(db, GLOBAL_PROJECT_ID, route, toolClass);
  const S = local?.ewma_success ?? 0;
  const F = local?.ewma_fail ?? 0;
  const samples = local?.raw_samples ?? 0;
  const Sg = glob?.ewma_success ?? 0;
  const Fg = glob?.ewma_fail ?? 0;

  const lambda = Math.min(LAMBDA_MAX, (Sg + Fg) / (Sg + Fg + 20));
  const alpha0 = M0 * p0;
  const beta0 = M0 - alpha0;
  const pGlob = (alpha0 + Sg) / (alpha0 + beta0 + Sg + Fg);
  const pHier = (1 - lambda) * p0 + lambda * pGlob;
  const alphaPrior = M0 * pHier;
  const betaPrior = M0 - alphaPrior;
  const p = (alphaPrior + S) / (alphaPrior + betaPrior + S + F);
  return {
    p,
    basis: samples >= N_MIN ? 'measured' : 'prior',
    samples,
    consecutiveErrors: local?.consecutive_errors ?? 0,
    lambda,
    pHier,
    ewmaSuccess: S,
    ewmaFail: F,
  };
}

export function getSessionConsecErr(db: DatabaseSync, conversationId: string | null | undefined): number {
  if (!conversationId) return 0;
  const row = db
    .prepare('SELECT session_consec_err FROM session_cursor WHERE conversation_id = ?')
    .get(conversationId) as { session_consec_err: number } | undefined;
  return row?.session_consec_err ?? 0;
}

export function hasHookCoverage(db: DatabaseSync, conversationId: string): boolean {
  const row = db
    .prepare('SELECT has_hook_coverage FROM session_cursor WHERE conversation_id = ?')
    .get(conversationId) as { has_hook_coverage: number } | undefined;
  return row?.has_hook_coverage === 1;
}

export interface RecordInput {
  projectId: string;
  projectLabel: string;
  route: RouteId;
  toolClass: string;
  toolName: string;
  ok: boolean;
  weight?: number;
  isRetry?: boolean;
  conversationId?: string | null;
  step?: number | null;
  targetHash?: string | null;
  errorSnippet?: string | null;
  source?: EventSource;
  dedupeKey?: string | null;
  forkId?: string | null;
  commandLine?: string | null;
  nowMs?: number;
}

export interface RecordResult {
  recorded: boolean;
  reason?: 'duplicate' | 'self-invocation';
  isRetry: boolean;
  route: RouteId;
  pAfter: number;
  consecutiveErrors: number;
  sessionConsecErr: number;
}

function updateStatsInTx(
  db: DatabaseSync,
  projectId: string,
  projectLabel: string,
  route: RouteId,
  toolClass: string,
  ok: boolean,
  weight: number,
  targetHash: string | null,
  nowMs: number
): void {
  for (const [pid, label] of [
    [projectId, projectLabel],
    [GLOBAL_PROJECT_ID, 'global-pool'],
  ] as const) {
    db.prepare(
      `INSERT INTO stats_summary
         (project_id, project_label, route, tool_class, ewma_success, ewma_fail,
          raw_samples, consecutive_errors, last_target_hash, last_outcome, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(project_id, route, tool_class) DO UPDATE SET
         ewma_success = ewma_success * ? + ?,
         ewma_fail = ewma_fail * ? + ?,
         raw_samples = raw_samples + 1,
         consecutive_errors = CASE WHEN ? = 1 THEN 0 ELSE consecutive_errors + 1 END,
         last_target_hash = ?,
         last_outcome = ?,
         updated_at_ms = ?`
    ).run(
      pid,
      label,
      route,
      toolClass,
      ok ? weight : 0,
      ok ? 0 : weight,
      ok ? 0 : 1,
      targetHash,
      ok ? 1 : 0,
      nowMs,
      GAMMA,
      ok ? weight : 0,
      GAMMA,
      ok ? 0 : weight,
      ok ? 1 : 0,
      targetHash,
      ok ? 1 : 0,
      nowMs
    );
  }
}

function insertEventInTx(db: DatabaseSync, input: RecordInput, route: RouteId, isRetry: boolean, nowMs: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO decision_events
       (dedupe_key, fork_id, project_id, conversation_id, source, route, tool_name, tool_class,
        ok, weight, is_retry, target_hash, error_snippet, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.dedupeKey ?? null,
    input.forkId ?? null,
    input.projectId,
    input.conversationId ?? null,
    input.source ?? 'cli',
    route,
    input.toolName,
    input.toolClass,
    input.ok ? 1 : 0,
    input.weight ?? 1,
    isRetry ? 1 : 0,
    input.targetHash ?? null,
    input.errorSnippet ?? null,
    nowMs
  );
}

function updateCursorInTx(db: DatabaseSync, input: RecordInput, isRetry: boolean, nowMs: number): void {
  if (!input.conversationId) return;
  if (input.ok) {
    // N7: 대화 스코프 카운터는 동일 대화의 ok=1로만 리셋, 직전 실패 문맥도 해제
    db.prepare(
      `INSERT INTO session_cursor
         (conversation_id, project_id, has_hook_coverage, last_failed_tool, last_failed_target,
          last_failed_step, session_consec_err, updated_at_ms)
       VALUES (?, ?, 0, NULL, NULL, NULL, 0, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_failed_tool = NULL,
         last_failed_target = NULL,
         last_failed_step = NULL,
         session_consec_err = 0,
         updated_at_ms = ?`
    ).run(input.conversationId, input.projectId, nowMs, nowMs);
  } else {
    db.prepare(
      `INSERT INTO session_cursor
         (conversation_id, project_id, has_hook_coverage, last_failed_tool, last_failed_target,
          last_failed_step, session_consec_err, updated_at_ms)
       VALUES (?, ?, 0, ?, ?, ?, 1, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_failed_tool = ?,
         last_failed_target = ?,
         last_failed_step = COALESCE(?, last_failed_step),
         session_consec_err = session_consec_err + 1,
         updated_at_ms = ?`
    ).run(
      input.conversationId,
      input.projectId,
      input.toolClass,
      input.targetHash ?? null,
      input.step ?? null,
      nowMs,
      input.toolClass,
      input.targetHash ?? null,
      input.step ?? null,
      nowMs
    );
  }
}

/**
 * 표본 1건 기록 (B7 불변식 적용).
 * - 자기 호출(dg.ts/dg-hook.ts 포함 명령)은 표본 0건 skip(B6).
 * - 재시도 판정(§4.5): 명시 `isRetry` 또는 직전 실패 이후 RETRY_STEP_WINDOW 스텝 이내
 *   동일 tool_class/target_hash 재호출 → `route='retry_or_abort'` 단일 행(is_retry=1),
 *   원 라우트에는 기록하지 않는다.
 */
export function recordToolOutcome(db: DatabaseSync, input: RecordInput): RecordResult {
  const nowMs = input.nowMs ?? Date.now();
  const selfText = `${input.toolName ?? ''} ${input.commandLine ?? ''}`;
  if (isSelfInvocation(selfText)) {
    const post = getPosterior(db, input.projectId, input.route, input.toolClass);
    return {
      recorded: false,
      reason: 'self-invocation',
      isRetry: false,
      route: input.route,
      pAfter: post.p,
      consecutiveErrors: post.consecutiveErrors,
      sessionConsecErr: getSessionConsecErr(db, input.conversationId),
    };
  }

  let isRetry = input.isRetry === true;
  if (!isRetry && input.conversationId && input.step != null) {
    const cur = db
      .prepare(
        'SELECT last_failed_tool, last_failed_target, last_failed_step FROM session_cursor WHERE conversation_id = ?'
      )
      .get(input.conversationId) as
      | { last_failed_tool: string | null; last_failed_target: string | null; last_failed_step: number | null }
      | undefined;
    if (cur && cur.last_failed_step != null && input.step > cur.last_failed_step) {
      const within = input.step - cur.last_failed_step <= RETRY_STEP_WINDOW;
      const sameClass = cur.last_failed_tool === input.toolClass;
      const sameTarget =
        input.targetHash != null && cur.last_failed_target != null && input.targetHash === cur.last_failed_target;
      if (within && (sameClass || sameTarget)) {
        isRetry = true;
      }
    }
  }

  const route: RouteId = isRetry ? 'retry_or_abort' : input.route;
  const toolClass = input.toolClass; // 재시도행도 정규화 클래스 유지(§4.5 단일 행 귀속)
  const weight = input.weight ?? 1;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (input.dedupeKey) {
      const existing = db
        .prepare('SELECT 1 AS one FROM decision_events WHERE dedupe_key = ?')
        .get(input.dedupeKey);
      if (existing) {
        db.exec('ROLLBACK');
        const post = getPosterior(db, input.projectId, route, toolClass);
        return {
          recorded: false,
          reason: 'duplicate',
          isRetry,
          route,
          pAfter: post.p,
          consecutiveErrors: post.consecutiveErrors,
          sessionConsecErr: getSessionConsecErr(db, input.conversationId),
        };
      }
    }
    updateStatsInTx(db, input.projectId, input.projectLabel, route, toolClass, input.ok, weight, input.targetHash ?? null, nowMs);
    insertEventInTx(db, input, route, isRetry, nowMs);
    updateCursorInTx(db, input, isRetry, nowMs);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 이미 롤백된 경우 무시 */
    }
    throw err;
  }

  const post = getPosterior(db, input.projectId, route, toolClass);
  return {
    recorded: true,
    isRetry,
    route,
    pAfter: post.p,
    consecutiveErrors: post.consecutiveErrors,
    sessionConsecErr: getSessionConsecErr(db, input.conversationId),
  };
}

export interface ForcedState {
  forcedSplit: boolean;
  forcedReason: string | null;
  escalateCarbon: boolean;
  keyConsecutiveErrors: number;
  sessionConsecErr: number;
}

/** §4.4: 키 카운터 OR 대화 카운터 >= 2 → p와 무관하게 강제 split(N7: 판정은 OR, 출력은 분리) */
export function evaluateForced(
  db: DatabaseSync,
  projectId: string,
  route: RouteId,
  toolClass: string,
  conversationId?: string | null
): ForcedState {
  const keyErr = readStatsRow(db, projectId, route, toolClass)?.consecutive_errors ?? 0;
  const sessErr = conversationId ? getSessionConsecErr(db, conversationId) : 0;
  const forcedSplit = keyErr >= FORCED_SPLIT_ERRORS || sessErr >= FORCED_SPLIT_ERRORS;
  const forcedReason = keyErr >= FORCED_SPLIT_ERRORS
    ? 'consecutive_errors>=2'
    : sessErr >= FORCED_SPLIT_ERRORS
      ? 'session_consec_err>=2'
      : null;
  return {
    forcedSplit,
    forcedReason,
    escalateCarbon: forcedSplit,
    keyConsecutiveErrors: keyErr,
    sessionConsecErr: sessErr,
  };
}

export interface ForkRow {
  fork_id: string;
  project_id: string;
  conversation_id: string | null;
  route: RouteId;
  tool_class: string;
  decision: 'sharp' | 'split';
  forced_split: number;
  p_at_gate: number;
  basis_at_gate: DecisionBasis;
  status: 'open' | 'ok' | 'fail' | 'abandoned' | 'rerouted' | 'backprop_fail';
  closed_by: string | null;
  neon_verdict: string | null;
  ttl_ms: number;
  created_at_ms: number;
  last_touch_ms: number;
  closed_at_ms: number | null;
  metadata_json: string | null;
}

export function getFork(db: DatabaseSync, forkId: string): ForkRow | null {
  const row = db.prepare('SELECT * FROM forks WHERE fork_id = ?').get(forkId) as unknown as ForkRow | undefined;
  return row ?? null;
}

export interface IssueForkInput {
  projectId: string;
  projectLabel: string;
  route: RouteId;
  toolClass: string;
  decision: 'sharp' | 'split';
  pAtGate: number;
  basisAtGate: DecisionBasis;
  forcedSplit: boolean;
  conversationId?: string | null;
  ttlMs?: number;
  title?: string | null;
  nowMs?: number;
}

/** Fork 발행(§4.7): `fk_<12hex>` ID로 `status='open'` 행 등록 */
export function issueFork(db: DatabaseSync, input: IssueForkInput): string {
  const forkId = `fk_${randomBytes(6).toString('hex')}`;
  const nowMs = input.nowMs ?? Date.now();
  const metadata = input.title ? JSON.stringify({ title: input.title }) : null;
  db.prepare(
    `INSERT INTO forks
       (fork_id, project_id, project_label, conversation_id, route, tool_class, decision,
        forced_split, p_at_gate, basis_at_gate, status, ttl_ms, created_at_ms, last_touch_ms, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(
    forkId,
    input.projectId,
    input.projectLabel,
    input.conversationId ?? null,
    input.route,
    input.toolClass,
    input.decision,
    input.forcedSplit ? 1 : 0,
    input.pAtGate,
    input.basisAtGate,
    input.ttlMs ?? TTL_EXPLORE_MS,
    nowMs,
    nowMs,
    metadata
  );
  return forkId;
}

/**
 * 고아 Fork TTL 정산(§4.6): `now - COALESCE(last_touch_ms, created_at_ms) > ttl_ms`인
 * `open` 행만 `abandoned`(closed_by='ttl')로 전환하고 EWMA 실패(source='ttl_orphan') 반영.
 * 생존 편향 차단이 목적이므로 모든 dg 쓰기/조회 진입점에서 선행 호출한다.
 */
export function settleOrphans(
  db: DatabaseSync,
  nowMs = Date.now()
): { settled: number; forkIds: string[] } {
  const stale = db
    .prepare(
      `SELECT fork_id, project_id, project_label, route, tool_class FROM forks
       WHERE status = 'open' AND (? - COALESCE(last_touch_ms, created_at_ms)) > ttl_ms`
    )
    .all(nowMs) as { fork_id: string; project_id: string; project_label: string; route: RouteId; tool_class: string }[];
  if (stale.length === 0) return { settled: 0, forkIds: [] };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of stale) {
      db.prepare(
        `UPDATE forks SET status = 'abandoned', closed_by = 'ttl', closed_at_ms = ? WHERE fork_id = ? AND status = 'open'`
      ).run(nowMs, row.fork_id);
      updateStatsInTx(db, row.project_id, row.project_label, row.route, row.tool_class, false, 1, null, nowMs);
      db.prepare(
        `INSERT INTO decision_events
           (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
         VALUES (?, ?, 'ttl_orphan', ?, 'ttl_settle', ?, 0, 1.0, 0, ?)`
      ).run(row.fork_id, row.project_id, row.route, row.tool_class, nowMs);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
  return { settled: stale.length, forkIds: stale.map((r) => r.fork_id) };
}

export type CloseOutcome = 'ok' | 'fail' | 'rerouted';

export interface CloseForkResult {
  forkId: string;
  status: CloseOutcome;
  closedBy: string;
  recorded: boolean;
  pAfter: number;
}

/**
 * Fork 닫힘(§3.3 전이표). `ok`/`fail`은 EWMA 1건(source='cli') 반영,
 * `rerouted`는 통계 미반영·감사 기록만(§2.0 에스컬레이션).
 */
export function closeFork(
  db: DatabaseSync,
  forkId: string,
  outcome: CloseOutcome,
  closedBy: string,
  reason?: string | null,
  opts: { nowMs?: number; recordStats?: boolean } = {}
): CloseForkResult {
  const fork = getFork(db, forkId);
  if (!fork) throw new Error(`fork not found: ${forkId}`);
  if (fork.status !== 'open') throw new Error(`fork ${forkId} already closed (status=${fork.status})`);
  const nowMs = opts.nowMs ?? Date.now();
  const recordStats = opts.recordStats !== false;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE forks SET status = ?, closed_by = ?, closed_at_ms = ?,
         metadata_json = COALESCE(metadata_json, ?)
       WHERE fork_id = ? AND status = 'open'`
    ).run(
      outcome,
      closedBy,
      nowMs,
      reason ? JSON.stringify({ close_reason: reason }) : null,
      forkId
    );
    if (recordStats && outcome !== 'rerouted') {
      updateStatsInTx(db, fork.project_id, getProjectLabel(db, fork.project_id), fork.route, fork.tool_class, outcome === 'ok', 1, null, nowMs);
      db.prepare(
        `INSERT INTO decision_events
           (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
         VALUES (?, ?, 'cli', ?, 'dg_close', ?, ?, 1.0, 0, ?)`
      ).run(forkId, fork.project_id, fork.route, fork.tool_class, outcome === 'ok' ? 1 : 0, nowMs);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
  const post = getPosterior(db, fork.project_id, fork.route, fork.tool_class);
  return { forkId, status: outcome, closedBy, recorded: recordStats && outcome !== 'rerouted', pAfter: post.p };
}

function getProjectLabel(db: DatabaseSync, projectId: string): string {
  const row = db
    .prepare('SELECT project_label FROM stats_summary WHERE project_id = ? LIMIT 1')
    .get(projectId) as { project_label: string } | undefined;
  return row?.project_label ?? projectId;
}

/** 진행 갱신(B1): `last_touch_ms` 갱신 + 선택적 TTL 조정 */
export function touchFork(
  db: DatabaseSync,
  forkId: string,
  ttlMs?: number,
  nowMs = Date.now()
): { forkId: string; lastTouchMs: number; ttlMs: number } {
  const fork = getFork(db, forkId);
  if (!fork) throw new Error(`fork not found: ${forkId}`);
  if (fork.status !== 'open') throw new Error(`fork ${forkId} not open (status=${fork.status})`);
  const newTtl = ttlMs ?? fork.ttl_ms;
  db.prepare('UPDATE forks SET last_touch_ms = ?, ttl_ms = ? WHERE fork_id = ?').run(nowMs, newTtl, forkId);
  return { forkId, lastTouchMs: nowMs, ttlMs: newTtl };
}

export interface BackpropResult {
  forkId: string;
  status: 'backprop_fail';
  neonVerdict: 'fail';
  weightApplied: number;
  pAfter: number;
}

/**
 * Neon FAIL 지연 역귀속(§4.6): `open`/`ok` fork를 `backprop_fail`로 재개방 후
 * 가중 실패(weight=penalty, source='neon_backprop')를 stats에 반영한다.
 */
export function backpropFork(
  db: DatabaseSync,
  forkId: string,
  penalty: number,
  reason?: string | null,
  nowMs = Date.now()
): BackpropResult {
  const fork = getFork(db, forkId);
  if (!fork) throw new Error(`fork not found: ${forkId}`);
  if (fork.status !== 'open' && fork.status !== 'ok') {
    throw new Error(`fork ${forkId} cannot backprop (status=${fork.status})`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE forks SET status = 'backprop_fail', closed_by = 'verifier', neon_verdict = 'fail',
         closed_at_ms = COALESCE(closed_at_ms, ?),
         metadata_json = COALESCE(metadata_json, ?)
       WHERE fork_id = ?`
    ).run(nowMs, reason ? JSON.stringify({ backprop_reason: reason, penalty }) : null, forkId);
    updateStatsInTx(db, fork.project_id, getProjectLabel(db, fork.project_id), fork.route, fork.tool_class, false, penalty, null, nowMs);
    db.prepare(
      `INSERT INTO decision_events
         (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
       VALUES (?, ?, 'neon_backprop', ?, 'neon_verifier', ?, 0, ?, 0, ?)`
    ).run(forkId, fork.project_id, fork.route, fork.tool_class, penalty, nowMs);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
  const post = getPosterior(db, fork.project_id, fork.route, fork.tool_class);
  return { forkId, status: 'backprop_fail', neonVerdict: 'fail', weightApplied: penalty, pAfter: post.p };
}

export interface CompactResult {
  deletedEvents: number;
  deletedForks: number;
  checkpoint: 'TRUNCATE';
  remainingEvents: number;
}

/**
 * 로그 컴팩션(§3.5): `stats_summary`는 상수 크기 유지, `decision_events`는
 * 30일 경과 또는 MAX_EVENTS 초과분(이 중 hook/wrap이 아니거나 14일 경과)만 삭제하고
 * 종료 후 30일 경과 forks를 정리한 뒤 WAL 체크포인트(TRUNCATE)를 실행한다.
 */
export function compactDb(
  db: DatabaseSync,
  maxEvents = 50_000,
  days = 30,
  nowMs = Date.now()
): CompactResult {
  const cutoff30 = nowMs - days * 86_400_000;
  const cutoff14 = nowMs - 14 * 86_400_000;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r1 = db.prepare('DELETE FROM decision_events WHERE created_at_ms < ?').run(cutoff30);
    let deleted = Number(r1.changes);
    const count = db.prepare('SELECT COUNT(*) AS n FROM decision_events').get() as { n: number };
    if (count.n > maxEvents) {
      const r2 = db
        .prepare(
          `DELETE FROM decision_events WHERE event_id IN (
             SELECT event_id FROM decision_events
             WHERE source NOT IN ('hook','wrap') OR created_at_ms < ?
             ORDER BY event_id DESC LIMIT -1 OFFSET ?
           )`
        )
        .run(cutoff14, maxEvents);
      deleted += Number(r2.changes);
    }
    const r3 = db
      .prepare('DELETE FROM forks WHERE status != \'open\' AND closed_at_ms IS NOT NULL AND closed_at_ms < ?')
      .run(cutoff30);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM decision_events').get() as { n: number };
    return { deletedEvents: deleted, deletedForks: Number(r3.changes), checkpoint: 'TRUNCATE', remainingEvents: remaining.n };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
}

/**
 * `sample_sources` 분포(§5.2): 최근 표본의 source별 건수. 표본 편중 관측용.
 */
export function sampleSources(
  db: DatabaseSync,
  projectId: string,
  route?: RouteId,
  toolClass?: string,
  limit = 500
): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT source, COUNT(*) AS n FROM (
         SELECT source FROM decision_events
         WHERE project_id = ?
           AND (? IS NULL OR route = ?)
           AND (? IS NULL OR tool_class = ?)
         ORDER BY event_id DESC LIMIT ?
       ) GROUP BY source ORDER BY n DESC`
    )
    .all(projectId, route ?? null, route ?? null, toolClass ?? null, toolClass ?? null, limit) as {
    source: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source] = r.n;
  return out;
}
