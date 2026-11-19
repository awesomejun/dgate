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
import { redactSecrets } from './redact.ts';
import type { VerdictValidationResult } from './verdict.ts';

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
/** `error_snippet` 상한 — 리댁션 적용 후 이 길이로 절단한다 (§3.1-B) */
export const ERROR_SNIPPET_MAX_CHARS = 300;
/** `waiting_human` 메타 상태의 TTL 면제 상한 — 7일 경과 시 고아 정산 재개 (§2.2) */
export const WAITING_HUMAN_MAX_MS = 7 * 86_400_000;

// ---------- 실패 원인 분류 (§3.1-B) ----------

/**
 * 실패 원인 11종 — `dg wrap`·verdict·고아 정산이 공유하는 분류 enum.
 * `config_error`/`interrupted`는 표본 정직성 보호를 위해 `stats_summary`·
 * `__GLOBAL__`·`consecutive_errors`에서 격리된다(감사 로그만 남김).
 */
export const FAILURE_CAUSES = [
  'ok_pass',
  'transient_network',
  'tool_error',
  'max_turns',
  'no_result',
  'artifact_missing',
  'gate_fail',
  'stall',
  'timeout',
  'config_error',
  'interrupted',
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

/** EWMA·카운터 오염이 금지된 원인 — decision_events 감사 로그만 남긴다 */
const AUDIT_ONLY_CAUSES: ReadonlySet<FailureCause> = new Set(['config_error', 'interrupted']);

export function isAuditOnlyCause(cause: FailureCause): boolean {
  return AUDIT_ONLY_CAUSES.has(cause);
}

/** 재시도 허용 원인 — `transient_network`·`tool_error` 뿐 (§3.1-B 매트릭스) */
export function isRetryableCause(cause: FailureCause): boolean {
  return cause === 'transient_network' || cause === 'tool_error';
}

/**
 * 종료 신호를 우선·문자열 휴리스틱을 보조로 사용하는 실패 원인 분류기(§3.1-B).
 * 문자열 includes() 단독 분류의 오탐을 막기 위해 명시 플래그·신호·종료코드를
 * 먼저 본다 — `errorText` 패턴 매칭은 그 다음이다.
 */
export function classifyFailure(input: {
  ok?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  stalled?: boolean;
  timedOut?: boolean;
  artifactMissing?: boolean;
  noResult?: boolean;
  gateFail?: boolean;
  errorText?: string;
}): FailureCause {
  if (input.ok === true) return 'ok_pass';
  if (input.stalled === true) return 'stall';
  if (input.timedOut === true) return 'timeout';
  if (input.artifactMissing === true) return 'artifact_missing';
  if (input.noResult === true) return 'no_result';
  if (input.gateFail === true) return 'gate_fail';
  const signal = input.signal;
  if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP') return 'interrupted';
  const code = input.exitCode;
  if (code === 127 || code === 2) return 'config_error';
  const text = input.errorText ?? '';
  if (/max[ -]?turns|reached max turns/i.test(text)) return 'max_turns';
  if (
    /ENOENT|command not found|not found as package|\b401\b|\b403\b|unauthorized|forbidden|authentication|permission denied|EACCES|unknown option|invalid option/i.test(
      text
    )
  ) {
    return 'config_error';
  }
  if (
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hangup|rate.?limit|\b429\b|\b502\b|\b503\b|\b504\b|network error/i.test(
      text
    )
  ) {
    return 'transient_network';
  }
  if (code !== null && code !== undefined && code !== 0) return 'tool_error';
  if (input.ok === false) return 'tool_error';
  if (code === 0) return 'ok_pass';
  return 'tool_error';
}

/**
 * `error_snippet` 규약 생성: `cause != 'ok_pass'`일 때 `cause=<enum>; <snippet>`
 * 형태를 만들고 리댁션 후 300자로 절단한다(§3.1-B). ok_pass면 null.
 */
export function formatErrorSnippet(cause: FailureCause, snippet: string | null | undefined): string | null {
  if (cause === 'ok_pass') return null;
  const body = snippet != null ? ` ${redactSecrets(snippet)}` : '';
  return `cause=${cause};${body}`.slice(0, ERROR_SNIPPET_MAX_CHARS);
}

// ---------- forks.metadata_json 규약 필드 (§2.2 Phase A 메타 상태) ----------

interface ForkMetadata {
  gen?: number;
  attempt?: number;
  cause?: string;
  rework_count?: number;
  waiting_human?: boolean;
  waiting_reason?: string;
  waiting_since_ms?: number;
  repo_scope?: string;
  lease_owner?: string;
  lease_until_ms?: number;
  close_reason?: string;
  backprop_reason?: string;
  penalty?: number;
  exit_code?: number | null;
  title?: string;
  [key: string]: unknown;
}

function parseForkMetadata(raw: string | null | undefined): ForkMetadata {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ForkMetadata)
      : {};
  } catch {
    return {};
  }
}

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
  /** 실패 원인 분류 (§3.1-B) — config_error/interrupted는 EWMA·카운터 격리 */
  cause?: FailureCause;
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
  // PR-A1 최종 방어선: DB 입력부 리댁션은 절단 이전에 강제 적용한다 (§4.1 Layer C).
  const cause = input.cause ?? 'ok_pass';
  if (cause !== 'ok_pass') {
    input.errorSnippet = formatErrorSnippet(cause, input.errorSnippet ?? undefined) ?? `cause=${cause};`;
  } else if (input.errorSnippet != null) {
    input.errorSnippet = redactSecrets(input.errorSnippet).slice(0, ERROR_SNIPPET_MAX_CHARS);
  }
  if (input.commandLine != null) input.commandLine = redactSecrets(input.commandLine);
  // §3.1-B EWMA 격리: config_error/interrupted 실패는 감사 로그만 남긴다
  const auditOnly = !input.ok && isAuditOnlyCause(cause);
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
    if (!auditOnly) {
      updateStatsInTx(db, input.projectId, input.projectLabel, route, toolClass, input.ok, weight, input.targetHash ?? null, nowMs);
    }
    insertEventInTx(db, input, route, isRetry, nowMs);
    if (!auditOnly) {
      updateCursorInTx(db, input, isRetry, nowMs);
    }
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
  /** metadata_json에 병합할 추가 규약 필드 (repo_scope·lease_* 등 — §2.2·§2.4) */
  metadata?: Record<string, unknown>;
  nowMs?: number;
}

/** Fork 발행(§4.7): `fk_<12hex>` ID로 `status='open'`, `gen=1, attempt=1` 메타 초기화 */
export function issueFork(db: DatabaseSync, input: IssueForkInput): string {
  const forkId = `fk_${randomBytes(6).toString('hex')}`;
  const nowMs = input.nowMs ?? Date.now();
  const metadataObj: ForkMetadata = { gen: 1, attempt: 1, ...(input.metadata ?? {}) };
  if (input.title != null) metadataObj.title = redactSecrets(input.title);
  const metadata = JSON.stringify(metadataObj);
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
  const settledIds: string[] = [];
  // Zero-TOCTOU (§2.3): stale 조회·상태 검증·UPDATE를 전부 BEGIN IMMEDIATE 안에서
  // 수행하고, `changes === 1`일 때만 표본을 기록한다 — 동시 정산 경합 시 나머지
  // writer는 `status='open'` 조건 불일치로 자동 탈락한다.
  db.exec('BEGIN IMMEDIATE');
  try {
    const stale = db
      .prepare(
        `SELECT fork_id, project_id, project_label, route, tool_class, metadata_json, created_at_ms FROM forks
         WHERE status = 'open' AND (? - COALESCE(last_touch_ms, created_at_ms)) > ttl_ms`
      )
      .all(nowMs) as {
      fork_id: string;
      project_id: string;
      project_label: string;
      route: RouteId;
      tool_class: string;
      metadata_json: string | null;
      created_at_ms: number;
    }[];
    for (const row of stale) {
      // waiting_human 예외(§2.2): 사람 승인 대기 fork는 최대 7일까지만 TTL 면제
      const meta = parseForkMetadata(row.metadata_json);
      if (meta.waiting_human === true) {
        const since = typeof meta.waiting_since_ms === 'number' ? meta.waiting_since_ms : row.created_at_ms;
        if (nowMs - since <= WAITING_HUMAN_MAX_MS) continue;
      }
      const res = db
        .prepare(
          `UPDATE forks SET status = 'abandoned', closed_by = 'ttl', closed_at_ms = ? WHERE fork_id = ? AND status = 'open'`
        )
        .run(nowMs, row.fork_id);
      if (Number(res.changes) !== 1) continue; // 이미 타 프로세스가 닫은 fork — 유령 표본 차단
      updateStatsInTx(db, row.project_id, row.project_label, row.route, row.tool_class, false, 1.0, null, nowMs);
      db.prepare(
        `INSERT INTO decision_events
           (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
         VALUES (?, ?, 'ttl_orphan', ?, 'ttl_settle', ?, 0, 1.0, 0, ?)`
      ).run(row.fork_id, row.project_id, row.route, row.tool_class, nowMs);
      settledIds.push(row.fork_id);
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
  return { settled: settledIds.length, forkIds: settledIds };
}

export type CloseOutcome = 'ok' | 'fail' | 'rerouted';

export interface CloseForkResult {
  forkId: string;
  status: string;
  closedBy: string;
  recorded: boolean;
  pAfter: number;
  /** false면 펜스·상태 불일치로 롤백됨 — 표본 미기록 (§2.3 Zero-TOCTOU) */
  committed: boolean;
  reason?: string;
}

export interface CloseForkOptions {
  nowMs?: number;
  recordStats?: boolean;
  /** Generation 펜스 — 지정 시 metadata.gen 불일치면 전면 거부 (§2.3-2) */
  expectedGen?: number;
  /** Attempt 펜스 — fail/rerouted는 attempt 불일치 시 거부, ok는 gen만 검증 */
  expectedAttempt?: number;
  /** metadata_json.cause 규약 필드 */
  cause?: FailureCause;
}

/**
 * Fork 닫힘(§3.3 전이표). `ok`/`fail`은 EWMA 1건(source='cli') 반영,
 * `rerouted`는 통계 미반영·감사 기록만(§2.0 에스컬레이션).
 * PR-A2: BEGIN IMMEDIATE 내부 재조회 + gen/attempt 비대칭 펜스 + `changes === 1`
 * 가드로 Zero-TOCTOU를 보장한다. 거부 시 `{ committed:false, reason }` 반환.
 */
export function closeFork(
  db: DatabaseSync,
  forkId: string,
  outcome: CloseOutcome,
  closedBy: string,
  reason?: string | null,
  opts: CloseForkOptions = {}
): CloseForkResult {
  const pre = getFork(db, forkId);
  if (!pre) throw new Error(`fork not found: ${forkId}`);
  if (pre.status !== 'open') throw new Error(`fork ${forkId} already closed (status=${pre.status})`);
  const nowMs = opts.nowMs ?? Date.now();
  const recordStats = opts.recordStats !== false;

  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db
      .prepare(`SELECT status, metadata_json, project_id, route, tool_class FROM forks WHERE fork_id = ?`)
      .get(forkId) as
      | { status: string; metadata_json: string | null; project_id: string; route: RouteId; tool_class: string }
      | undefined;
    const pAfter = () => getPosterior(db, pre.project_id, pre.route, pre.tool_class).p;
    if (!cur || cur.status !== 'open') {
      db.exec('ROLLBACK');
      return { forkId, status: cur?.status ?? 'unknown', closedBy, recorded: false, pAfter: pAfter(), committed: false, reason: 'stale_or_closed' };
    }
    const meta = parseForkMetadata(cur.metadata_json);
    const curGen = meta.gen ?? 1;
    const curAttempt = meta.attempt ?? 1;
    if (opts.expectedGen !== undefined && curGen !== opts.expectedGen) {
      db.exec('ROLLBACK');
      return { forkId, status: cur.status, closedBy, recorded: false, pAfter: pAfter(), committed: false, reason: 'stale_generation' };
    }
    if (outcome !== 'ok' && opts.expectedAttempt !== undefined && curAttempt !== opts.expectedAttempt) {
      db.exec('ROLLBACK');
      return { forkId, status: cur.status, closedBy, recorded: false, pAfter: pAfter(), committed: false, reason: 'stale_attempt' };
    }

    const merged = { ...meta };
    if (reason != null) merged.close_reason = redactSecrets(reason);
    if (opts.cause) merged.cause = opts.cause;
    const res = db
      .prepare(
        `UPDATE forks SET status = ?, closed_by = ?, closed_at_ms = ?, metadata_json = ?
         WHERE fork_id = ? AND status = 'open'`
      )
      .run(outcome, closedBy, nowMs, JSON.stringify(merged), forkId);
    if (Number(res.changes) !== 1) {
      db.exec('ROLLBACK');
      return { forkId, status: 'open', closedBy, recorded: false, pAfter: pAfter(), committed: false, reason: 'stale_or_closed' };
    }
    if (recordStats && outcome !== 'rerouted') {
      updateStatsInTx(db, cur.project_id, getProjectLabel(db, cur.project_id), cur.route, cur.tool_class, outcome === 'ok', 1, null, nowMs);
      db.prepare(
        `INSERT INTO decision_events
           (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
         VALUES (?, ?, 'cli', ?, 'dg_close', ?, ?, 1.0, 0, ?)`
      ).run(forkId, cur.project_id, cur.route, cur.tool_class, outcome === 'ok' ? 1 : 0, nowMs);
    }
    db.exec('COMMIT');
    return { forkId, status: outcome, closedBy, recorded: recordStats && outcome !== 'rerouted', pAfter: pAfter(), committed: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
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
  status: string;
  neonVerdict: 'fail' | null;
  weightApplied: number;
  pAfter: number;
  /** false면 상태 불일치로 롤백됨 — 이중 역귀속 차단 (§2.3) */
  committed: boolean;
  reason?: string;
}

/**
 * Neon FAIL 지연 역귀속(§4.6): `open`/`ok` fork를 `backprop_fail`로 재개방 후
 * 가중 실패(weight=penalty, source='neon_backprop')를 stats에 반영한다.
 * PR-A2: `WHERE status IN ('open','ok')` + `changes === 1` 가드로 이중 역귀속을
 * 원자적으로 차단한다. 거부 시 `{ committed:false, reason }` 반환.
 */
export function backpropFork(
  db: DatabaseSync,
  forkId: string,
  penalty: number,
  reason?: string | null,
  opts: { nowMs?: number; cause?: FailureCause } = {}
): BackpropResult {
  const pre = getFork(db, forkId);
  if (!pre) throw new Error(`fork not found: ${forkId}`);
  if (pre.status !== 'open' && pre.status !== 'ok') {
    throw new Error(`fork ${forkId} cannot backprop (status=${pre.status})`);
  }
  const nowMs = opts.nowMs ?? Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db
      .prepare(`SELECT status, metadata_json, project_id, route, tool_class FROM forks WHERE fork_id = ?`)
      .get(forkId) as
      | { status: string; metadata_json: string | null; project_id: string; route: RouteId; tool_class: string }
      | undefined;
    const pAfter = () => getPosterior(db, pre.project_id, pre.route, pre.tool_class).p;
    if (!cur || (cur.status !== 'open' && cur.status !== 'ok')) {
      db.exec('ROLLBACK');
      return { forkId, status: cur?.status ?? 'unknown', neonVerdict: null, weightApplied: 0, pAfter: pAfter(), committed: false, reason: 'stale_or_closed' };
    }
    const merged = { ...parseForkMetadata(cur.metadata_json) };
    if (reason != null) merged.backprop_reason = redactSecrets(reason);
    merged.penalty = penalty;
    if (opts.cause) merged.cause = opts.cause;
    const res = db
      .prepare(
        `UPDATE forks SET status = 'backprop_fail', closed_by = 'verifier', neon_verdict = 'fail',
           closed_at_ms = COALESCE(closed_at_ms, ?), metadata_json = ?
         WHERE fork_id = ? AND status IN ('open','ok')`
      )
      .run(nowMs, JSON.stringify(merged), forkId);
    if (Number(res.changes) !== 1) {
      db.exec('ROLLBACK');
      return { forkId, status: cur.status, neonVerdict: null, weightApplied: 0, pAfter: pAfter(), committed: false, reason: 'stale_or_closed' };
    }
    updateStatsInTx(db, cur.project_id, getProjectLabel(db, cur.project_id), cur.route, cur.tool_class, false, penalty, null, nowMs);
    db.prepare(
      `INSERT INTO decision_events
         (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
       VALUES (?, ?, 'neon_backprop', ?, 'neon_verifier', ?, 0, ?, 0, ?)`
    ).run(forkId, cur.project_id, cur.route, cur.tool_class, penalty, nowMs);
    db.exec('COMMIT');
    return { forkId, status: 'backprop_fail', neonVerdict: 'fail', weightApplied: penalty, pAfter: pAfter(), committed: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
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

// =============================================================================
// PR-A2: 단일 트랜잭션 wrap 커밋 · verdict 적용 · 회고·스코프 리스 (§2.3~§2.5)
// =============================================================================

export interface CommitWrapInput {
  forkId: string;
  projectId: string;
  projectLabel: string;
  route: RouteId;
  toolClass: string;
  toolName?: string;
  ok: boolean;
  outcome: CloseOutcome;
  cause: FailureCause;
  exitCode?: number | null;
  signal?: string | null;
  errorSnippet?: string | null;
  commandLine?: string | null;
  source?: EventSource;
  expectedGen?: number;
  expectedAttempt?: number;
  recordStats?: boolean;
  conversationId?: string | null;
  nowMs?: number;
}

export interface CommitWrapResult {
  committed: boolean;
  closed: boolean;
  recorded: boolean;
  outcome: string;
  reason?: string;
  pAfter: number;
}

/**
 * `dg wrap` 종료 원자 커밋(§2.3-3·Bug A 수정): 기존 `recordToolOutcome` +
 * `closeFork`의 2-Tx 경합(사이에 ttl 고아 정산이 끼어들어 이중 표본 가능)을
 * 단일 `BEGIN IMMEDIATE`로 합친다. fork 상태·gen/attempt 펜스·UPDATE
 * `changes === 1`·`dedupe_key = wrap:<forkId>:a<attempt>`를 모두 같은
 * 트랜잭션에서 검증한다. 이미 닫힌 fork에 지연 도착하면
 * `{ committed:false, reason:'stale_or_closed' }`.
 */
export function commitWrapOutcome(db: DatabaseSync, input: CommitWrapInput): CommitWrapResult {
  const nowMs = input.nowMs ?? Date.now();
  const recordStats = input.recordStats !== false;
  const selfInvoke = isSelfInvocation(`${input.toolName ?? ''} ${input.commandLine ?? ''}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db
      .prepare(
        `SELECT status, metadata_json, project_id, project_label, route, tool_class FROM forks WHERE fork_id = ?`
      )
      .get(input.forkId) as
      | {
          status: string;
          metadata_json: string | null;
          project_id: string;
          project_label: string;
          route: RouteId;
          tool_class: string;
        }
      | undefined;
    if (!cur) {
      db.exec('ROLLBACK');
      return { committed: false, closed: false, recorded: false, outcome: 'unknown', reason: 'not_found', pAfter: 0 };
    }
    const pAfter = () => getPosterior(db, cur.project_id, cur.route, cur.tool_class).p;
    if (cur.status !== 'open') {
      db.exec('ROLLBACK');
      return { committed: false, closed: false, recorded: false, outcome: cur.status, reason: 'stale_or_closed', pAfter: pAfter() };
    }
    const meta = parseForkMetadata(cur.metadata_json);
    const curGen = meta.gen ?? 1;
    const curAttempt = meta.attempt ?? 1;
    if (input.expectedGen !== undefined && curGen !== input.expectedGen) {
      db.exec('ROLLBACK');
      return { committed: false, closed: false, recorded: false, outcome: 'open', reason: 'stale_generation', pAfter: pAfter() };
    }
    if (input.outcome !== 'ok' && input.expectedAttempt !== undefined && curAttempt !== input.expectedAttempt) {
      db.exec('ROLLBACK');
      return { committed: false, closed: false, recorded: false, outcome: 'open', reason: 'stale_attempt', pAfter: pAfter() };
    }

    const merged: ForkMetadata = { ...meta, cause: input.cause, exit_code: input.exitCode ?? null };
    if (input.errorSnippet != null) {
      merged.close_reason = redactSecrets(input.errorSnippet).slice(0, ERROR_SNIPPET_MAX_CHARS);
    }
    const res = db
      .prepare(
        `UPDATE forks SET status = ?, closed_by = 'worker', closed_at_ms = ?, metadata_json = ?
         WHERE fork_id = ? AND status = 'open'`
      )
      .run(input.outcome, nowMs, JSON.stringify(merged), input.forkId);
    if (Number(res.changes) !== 1) {
      db.exec('ROLLBACK');
      return { committed: false, closed: false, recorded: false, outcome: 'open', reason: 'stale_or_closed', pAfter: pAfter() };
    }

    let recorded = false;
    if (!selfInvoke) {
      const dedupeKey = `wrap:${input.forkId}:a${curAttempt}`;
      const evRes = db
        .prepare(
          `INSERT OR IGNORE INTO decision_events
             (dedupe_key, fork_id, project_id, conversation_id, source, route, tool_name, tool_class,
              ok, weight, is_retry, error_snippet, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0, ?, ?)`
        )
        .run(
          dedupeKey,
          input.forkId,
          cur.project_id,
          input.conversationId ?? null,
          input.source ?? 'wrap',
          cur.route,
          input.toolName ?? 'dg_wrap',
          cur.tool_class,
          input.outcome === 'ok' ? 1 : 0,
          formatErrorSnippet(input.cause, input.errorSnippet),
          nowMs
        );
      // 표본 기록은 이벤트가 실제로 1건 삽입됐을 때만 — dedupe 충돌·비표본 결과 차단
      const skipStats =
        input.outcome === 'rerouted' || isAuditOnlyCause(input.cause) || !recordStats;
      if (Number(evRes.changes) === 1 && !skipStats) {
        updateStatsInTx(
          db, cur.project_id, cur.project_label, cur.route, cur.tool_class,
          input.outcome === 'ok', 1.0, null, nowMs
        );
        recorded = true;
      }
    }
    db.exec('COMMIT');
    return { committed: true, closed: true, recorded, outcome: input.outcome, pAfter: pAfter() };
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
 * `waiting_human` 메타 상태 마킹(§2.2 Phase A): fork 상태는 유지한 채
 * `metadata_json.waiting_human=true`를 세팅한다 — settleOrphans가 최대
 * `WAITING_HUMAN_MAX_MS`(7일)까지 TTL 정산을 면제한다. `open`/`ok`만 허용.
 */
export function markForkWaitingHuman(
  db: DatabaseSync,
  forkId: string,
  opts: { reason: string; reworkCount?: number; nowMs?: number }
): { marked: boolean; reason?: string } {
  const nowMs = opts.nowMs ?? Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db
      .prepare(`SELECT status, metadata_json FROM forks WHERE fork_id = ?`)
      .get(forkId) as { status: string; metadata_json: string | null } | undefined;
    if (!cur) {
      db.exec('ROLLBACK');
      return { marked: false, reason: 'not_found' };
    }
    if (cur.status !== 'open' && cur.status !== 'ok') {
      db.exec('ROLLBACK');
      return { marked: false, reason: 'stale_or_closed' };
    }
    const merged = {
      ...parseForkMetadata(cur.metadata_json),
      waiting_human: true,
      waiting_reason: redactSecrets(opts.reason).slice(0, ERROR_SNIPPET_MAX_CHARS),
      waiting_since_ms: nowMs,
    };
    if (opts.reworkCount !== undefined) merged.rework_count = opts.reworkCount;
    const res = db
      .prepare(`UPDATE forks SET metadata_json = ? WHERE fork_id = ? AND status IN ('open','ok')`)
      .run(JSON.stringify(merged), forkId);
    if (Number(res.changes) !== 1) {
      db.exec('ROLLBACK');
      return { marked: false, reason: 'stale_or_closed' };
    }
    db.exec('COMMIT');
    return { marked: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
}

export interface VerdictApplyResult {
  /** pass(0) / backprop_fail(0) / rework(0) / escalate_human(3) */
  action: 'pass' | 'backprop_fail' | 'rework' | 'escalate_human';
  exitCode: number;
  committed: boolean;
  reason?: string;
  waitingHuman?: boolean;
  pAfter?: number;
}

/**
 * 검증된 verdict의 fork 상태 반영(§2.6 fail-closed).
 * - `pass`: `open`→`ok`(closed_by='verifier'). 이미 `ok`면 멱등 통과.
 * - `fail`: `backpropFork(2.0, cause='gate_fail')`. 이미 `backprop_fail`이면 멱등.
 * - `rework`: `rework_count < maxReworks`면 count+1 + w=1.0 페널티 표본(fork 유지,
 *   단 `ok`면 backprop_fail 전이); 예산 소진 시 `waiting_human` + escalate.
 * - `human`/무효 verdict: `waiting_human` 마킹 + escalate. 어떤 경로도
 *   누락·불량·재생 verdict를 pass로 해석하지 않는다.
 */
export function applyVerdictToFork(
  db: DatabaseSync,
  input: {
    forkId: string;
    verdict: VerdictValidationResult;
    maxReworks?: number;
    nowMs?: number;
  }
): VerdictApplyResult {
  const nowMs = input.nowMs ?? Date.now();
  const fork = getFork(db, input.forkId);
  if (!fork) {
    return { action: 'escalate_human', exitCode: 3, committed: false, reason: 'fork_not_found' };
  }
  const v = input.verdict;
  const vReason = v.document?.action_required ?? v.document?.reason ?? v.errors.join('; ');

  if (!v.valid || v.effectiveDecision === 'human') {
    const marked = markForkWaitingHuman(db, input.forkId, {
      reason: vReason || 'invalid/human verdict', nowMs,
    });
    return { action: 'escalate_human', exitCode: 3, committed: marked.marked, reason: vReason || 'invalid/human verdict', waitingHuman: marked.marked };
  }

  if (v.effectiveDecision === 'pass') {
    if (fork.status === 'ok') {
      return { action: 'pass', exitCode: 0, committed: true, reason: 'idempotent' };
    }
    if (fork.status !== 'open') {
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: `fork status ${fork.status}` };
    }
    const res = closeFork(db, input.forkId, 'ok', 'verifier', vReason || 'verdict pass', { cause: 'ok_pass', nowMs });
    if (!res.committed) {
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: res.reason };
    }
    return { action: 'pass', exitCode: 0, committed: true, pAfter: res.pAfter };
  }

  if (v.effectiveDecision === 'fail') {
    if (fork.status === 'backprop_fail') {
      return { action: 'backprop_fail', exitCode: 0, committed: true, reason: 'idempotent' };
    }
    if (fork.status !== 'open' && fork.status !== 'ok') {
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: `fork status ${fork.status}` };
    }
    const res = backpropFork(db, input.forkId, 2.0, vReason || 'verdict fail', { cause: 'gate_fail', nowMs });
    if (!res.committed) {
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: res.reason };
    }
    return { action: 'backprop_fail', exitCode: 0, committed: true, pAfter: res.pAfter };
  }

  // rework — 예산 검사·count 증분·페널티 표본을 단일 트랜잭션으로
  const maxReworks = input.maxReworks ?? 2;
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db
      .prepare(
        `SELECT status, metadata_json, project_id, project_label, route, tool_class FROM forks WHERE fork_id = ?`
      )
      .get(input.forkId) as
      | {
          status: string;
          metadata_json: string | null;
          project_id: string;
          project_label: string;
          route: RouteId;
          tool_class: string;
        }
      | undefined;
    if (!cur) {
      db.exec('ROLLBACK');
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: 'fork_not_found' };
    }
    const meta = parseForkMetadata(cur.metadata_json);
    const reworkCount = meta.rework_count ?? 0;
    if (reworkCount >= maxReworks) {
      // 예산 소진 → waiting_human(가능 시) + 사람 에스컬레이션
      db.exec('ROLLBACK');
      const marked = markForkWaitingHuman(db, input.forkId, {
        reason: `rework budget exhausted (${reworkCount}>=${maxReworks}): ${vReason || ''}`,
        reworkCount, nowMs,
      });
      return { action: 'escalate_human', exitCode: 3, committed: marked.marked, reason: 'rework budget exhausted', waitingHuman: marked.marked };
    }
    if (cur.status !== 'open' && cur.status !== 'ok') {
      db.exec('ROLLBACK');
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: `fork status ${cur.status}` };
    }
    const merged: ForkMetadata = {
      ...meta,
      rework_count: reworkCount + 1,
      cause: 'gate_fail',
      ...(vReason ? { rework_reason: redactSecrets(vReason).slice(0, ERROR_SNIPPET_MAX_CHARS) } : {}),
    };
    // open이면 재작업을 위해 fork 유지, ok면 backprop_fail로 전이 — 둘 다 w=1.0 페널티
    const res = cur.status === 'open'
      ? db
          .prepare(`UPDATE forks SET metadata_json = ? WHERE fork_id = ? AND status = 'open'`)
          .run(JSON.stringify(merged), input.forkId)
      : db
          .prepare(
            `UPDATE forks SET status = 'backprop_fail', closed_by = 'verifier', neon_verdict = 'fail',
               closed_at_ms = COALESCE(closed_at_ms, ?), metadata_json = ?
             WHERE fork_id = ? AND status = 'ok'`
          )
          .run(nowMs, JSON.stringify(merged), input.forkId);
    if (Number(res.changes) !== 1) {
      db.exec('ROLLBACK');
      return { action: 'escalate_human', exitCode: 3, committed: false, reason: 'stale_or_closed' };
    }
    db.prepare(
      `INSERT INTO decision_events
         (fork_id, project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
       VALUES (?, ?, 'neon_backprop', ?, 'neon_verifier', ?, 0, 1.0, 0, ?)`
    ).run(input.forkId, cur.project_id, cur.route, cur.tool_class, nowMs);
    updateStatsInTx(db, cur.project_id, cur.project_label, cur.route, cur.tool_class, false, 1.0, null, nowMs);
    db.exec('COMMIT');
    const post = getPosterior(db, cur.project_id, cur.route, cur.tool_class);
    return { action: 'rework', exitCode: 0, committed: true, pAfter: post.p };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
}

export interface ForkRetroToolRow {
  toolName: string;
  count: number;
  lastError: string | null;
}

export interface ForkRetroData {
  fork: ForkRow;
  metadata: ForkMetadata;
  eventCount: number;
  /** 해당 프로젝트 실패 도구 상위 N (retro 마크다운 소재, §2.7) */
  topFailedTools: ForkRetroToolRow[];
}

/** `dg retro`용 fork 회고 데이터 수집 — 읽기 전용, 표본 기록 없음 */
export function collectForkRetroData(db: DatabaseSync, forkId: string, limit = 5): ForkRetroData | null {
  const fork = getFork(db, forkId);
  if (!fork) return null;
  const tools = db
    .prepare(
      `SELECT e.tool_name AS tool_name, COUNT(*) AS n,
         (SELECT e2.error_snippet FROM decision_events e2
           WHERE e2.project_id = e.project_id AND e2.tool_name = e.tool_name
             AND e2.ok = 0 AND e2.error_snippet IS NOT NULL
           ORDER BY e2.created_at_ms DESC LIMIT 1) AS last_error
       FROM decision_events e
       WHERE e.project_id = ? AND e.ok = 0
       GROUP BY e.tool_name ORDER BY n DESC, e.tool_name ASC LIMIT ?`
    )
    .all(fork.project_id, limit) as { tool_name: string; n: number; last_error: string | null }[];
  const ev = db
    .prepare(`SELECT COUNT(*) AS n FROM decision_events WHERE fork_id = ?`)
    .get(forkId) as { n: number };
  return {
    fork,
    metadata: parseForkMetadata(fork.metadata_json),
    eventCount: ev.n,
    topFailedTools: tools.map((t) => ({ toolName: t.tool_name, count: t.n, lastError: t.last_error })),
  };
}

export interface ScopeLeaseResult {
  acquired: boolean;
  holder?: string;
  reason?: string;
}

/**
 * Cooperative Lease(§2.4): 동일 `metadata_json.repo_scope`를 가진 `open` fork 중
 * lease 미만료이고 `lease_owner`가 `liveSessions`에 있는 점유자가 있으면
 * `{ acquired:false, holder }`. 소유자 생존 증명(`liveSessions` 미제공·부재) 또는
 * 만료 시 `acquired:true` — 미검증 점유로 배치를 막지 않는다.
 * 순수 조회이며 새 점유는 호출자가 `issueFork(metadata)`로 기록한다.
 */
export function acquireScopeLease(
  db: DatabaseSync,
  input: {
    repoScope: string;
    leaseOwner: string;
    liveSessions?: readonly string[];
    nowMs?: number;
  }
): ScopeLeaseResult {
  const nowMs = input.nowMs ?? Date.now();
  const live = input.liveSessions !== undefined ? new Set(input.liveSessions) : null;
  const rows = db
    .prepare(`SELECT metadata_json FROM forks WHERE status = 'open'`)
    .all() as { metadata_json: string | null }[];
  for (const row of rows) {
    const meta = parseForkMetadata(row.metadata_json);
    if (meta.repo_scope !== input.repoScope) continue;
    if (meta.lease_owner == null) continue; // 스코프 기록은 있으나 점유자 미지정
    if (meta.lease_owner === input.leaseOwner) continue; // 자기 자신은 충돌 아님
    const until = typeof meta.lease_until_ms === 'number' ? meta.lease_until_ms : 0;
    if (until <= nowMs) continue; // lease 만료 → 탈취 가능
    if (live !== null && !live.has(meta.lease_owner)) continue; // 소유 세션 사망 확인 → 탈취
    if (live === null) continue; // 생존 검증 수단 없음 → 점유로 보지 않음 (fail-open)
    return {
      acquired: false,
      holder: meta.lease_owner,
      reason: `scope lease held by ${meta.lease_owner} until ${new Date(until).toISOString()}`,
    };
  }
  return { acquired: true };
}
