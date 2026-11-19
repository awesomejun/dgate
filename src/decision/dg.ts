#!/usr/bin/env node
/**
 * `dg` CLI — Decision 게이트 명령 체계 (plan-r2.1 §4.7, 9종).
 *
 * 목적: `route | gate | close | touch | record | backprop | attempt | retro | settle-orphans |
 * wrap | compact | stats | checkpoint | worktree | report` 명령으로 태스크 단위 선별
 * 라우팅(LLM 턴 0)·Fork 생명주기·표본 수집·읽기전용 통계/리포트·워크트리 체크포인트를 제어한다.
 * PB-2.5: `stats`/`report`는 `readOnly: true`로만 열고 `settleOrphans`를 절대 호출하지
 * 않으며, `checkpoint`/`worktree remove`는 checkpoint.ts의 삭제 게이트(exitCode 4)를 경유한다.
 *
 * 외부 연결:
 * - 디스패처/리드/워커 셸에서 `node ./src/decision/dg.ts <cmd> …` 로 직접 실행.
 * - `.agents/hooks/dg-hook.ts`(W3)가 `engine` 모듈을 공유해 동일 판정으로 기록.
 *
 * 주의:
 * - 안전 폴백(§3.5): DB 오류 시 stderr 경고 + 안전 JSON 출력 후 exit 0(게이트 SPOF 차단).
 *   단, 잘못된 Route enum·task-kind·source 등 입력 검증 오류는 exit 2.
 * - 모든 쓰기/조회 진입점은 트랜잭션 내에서 `settleOrphans`를 먼저 실행한다(§4.6).
 * - `source` enum은 DDL·CLI 모두 8값으로 통일(N-NEW-6). CLI에서는 'stream' 대신 'agy_stream'.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  createWorktreeCheckpoint,
  restoreWorktreeCheckpoint,
  safeRemoveWorktree,
  verifyWorktreeCheckpoint,
} from './checkpoint.ts';
import { openDbSafe, resolveProjectIdentity } from './db.ts';
import {
  applyVerdictToFork,
  backpropFork,
  bumpForkAttempt,
  classifyFailure,
  closeFork,
  collectForkRetroData,
  commitWrapOutcome,
  compactDb,
  ensureForkWaitInterval,
  evaluateForced,
  evaluateGate,
  evaluateRoute,
  getFork,
  getForkGenAttempt,
  getPosterior,
  isEventSource,
  isForkLiveStatus,
  isRouteId,
  issueFork,
  markForkWaitingHuman,
  recordForkIntervalStart,
  recordToolOutcome,
  sampleSources,
  settleOrphans,
  taskKindSpec,
  touchFork,
  TTL_CODING_MS,
  TTL_EXPLORE_MS,
  type CloseOutcome,
  type EventSource,
  type FailureCause,
  type RiskLevel,
  type RouteId,
} from './engine.ts';
import {
  applyDecisionApi,
  createDecisionAdapter,
  isDecisionApiMode,
  parseDecisionApiMode,
  type DecisionApiAudit,
  type DecisionApiMode,
} from './adapter.ts';
import { buildSanitizedChildEnv, redactSecrets } from './redact.ts';
import {
  formatReportMarkdown,
  generateRuleCandidateReport,
  openReportDb,
  writeReportFileSafe,
} from './report.ts';
import { loadRosterConfig, resolveRosterProfile } from './roster.ts';
import { computeCostStats, computeDynamicSharpThreshold, computeTimingStats } from './stats.ts';
import { buildRetroMarkdown, validateVerdictFile } from './verdict.ts';

class UsageError extends Error {}

/** 값 없이 단독으로 쓰는 불리언 플래그 */
const BOOL_FLAGS = new Set([
  'json',
  'is-retry',
  'require-stdout-nonempty',
  'require-nonempty',
  'sanitize-env',
  'bump-gen',
  'cost',
  'timing',
  'force',
  'api-eval',
]);

interface ParsedArgs {
  flags: Map<string, string>;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      throw new UsageError(`unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    let key: string;
    let value: string | undefined;
    if (eq !== -1) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
    }
    if (value === undefined) {
      if (BOOL_FLAGS.has(key)) {
        flags.set(key, '1');
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`missing value for --${key}`);
      }
      value = next;
      i++;
    }
    if (flags.has(key)) throw new UsageError(`duplicate flag --${key}`);
    flags.set(key, value);
  }
  return { flags, rest };
}

function requireFlag(args: ParsedArgs, name: string): string {
  const v = args.flags.get(name);
  if (v === undefined || v === '') throw new UsageError(`missing required flag --${name}`);
  return v;
}

function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return v === undefined || v === '' ? undefined : v;
}

function parseIntFlag(args: ParsedArgs, name: string, fallback: number): number {
  const v = optionalFlag(args, name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

function parseFloatFlag(args: ParsedArgs, name: string, fallback: number): number {
  const v = optionalFlag(args, name);
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
  return n;
}

function parseRoute(v: string, flagName = 'route'): RouteId {
  if (!isRouteId(v)) {
    throw new UsageError(`invalid --${flagName} "${v}" (allowed: file_select|tool_select|retry_or_abort|delegate_swarm)`);
  }
  return v;
}

function parseSource(v: string): EventSource {
  if (!isEventSource(v)) {
    throw new UsageError(
      `invalid --source "${v}" (allowed: hook|agy_stream|transcript|rest_api|cli|wrap|ttl_orphan|neon_backprop)`
    );
  }
  return v;
}

function parseRisk(v: string | undefined): RiskLevel | undefined {
  if (v === undefined) return undefined;
  if (v !== 'low' && v !== 'medium' && v !== 'high') {
    throw new UsageError(`invalid --risk "${v}" (allowed: low|medium|high)`);
  }
  return v;
}

function resolveIdentity(projectDir: string | undefined): { projectId: string; projectLabel: string } {
  const dir = projectDir ?? process.cwd();
  if (!fs.existsSync(dir)) throw new UsageError(`--project directory not found: ${dir}`);
  return resolveProjectIdentity(dir);
}

function emit(json: boolean, human: () => string, data: unknown): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else {
    process.stdout.write(`${human()}\n`);
  }
}

function fallbackForkId(): string {
  return `fk_fallback_${randomBytes(4).toString('hex')}`;
}

function openWriter(dbPath?: string): DatabaseSync {
  const db = openDbSafe(dbPath, { busyTimeoutMs: 5000 });
  if (!db) throw new Error('decision db unavailable');
  return db;
}

/** `--db` 공용 옵션 — 명시 시 `DGATE_DB_PATH`·`DECISION_ORCHESTRATOR_DB_PATH`·`GEMINI_TRICK_DB_PATH`보다 우선 (resolveDbPath 우선순위 그대로) */
function dbFlag(args: ParsedArgs): string | undefined {
  return optionalFlag(args, 'db');
}

/**
 * 읽기전용 연결 — `stats` 전용. `settleOrphans` 등 쓰기 경로를 절대 타지 않는다
 * (v1 DB readOnly 안전 — brief-pbwire §3). `report`는 openReportDb를 쓴다.
 */
function openReader(dbPath?: string): DatabaseSync {
  const db = openDbSafe(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  if (!db) throw new Error('decision db unavailable');
  return db;
}

/**
 * PB-2.5: `--roster`/`--profile` 명시 시 roster 기반 동적 θ_sharp 산출.
 * 둘 다 미지정이면 undefined → evaluateRoute/evaluateGate 기본 0.70 경로와 동일.
 * `--project`는 roster 탐색의 `<repo>/.herdr/roster.json` 후보 디렉터리로도 쓰인다.
 */
function resolveSharpTheta(args: ParsedArgs): number | undefined {
  const rosterPath = optionalFlag(args, 'roster');
  const profileName = optionalFlag(args, 'profile');
  if (rosterPath === undefined && profileName === undefined) return undefined;
  const loaded = loadRosterConfig({
    rosterPath: rosterPath ?? null,
    repoDir: optionalFlag(args, 'project') ?? null,
  });
  const resolved = resolveRosterProfile(loaded.config, profileName ?? loaded.config.defaultProfile);
  return computeDynamicSharpThreshold({ profile: resolved.profile }).threshold;
}

// ---------- Decision API (--decision-api/--context/--api-eval) ----------

/** route·gate 공용 Decision API 플래그 — 무효 값은 UsageError(exit 2), 무키는 off 강등 */
function parseDecisionApiFlags(args: ParsedArgs): { mode: DecisionApiMode; context: string | null; apiEval: boolean } {
  const raw = optionalFlag(args, 'decision-api');
  if (raw !== undefined && !isDecisionApiMode(raw)) {
    throw new UsageError(`invalid --decision-api "${raw}" (allowed: off|shadow|on)`);
  }
  return {
    mode: parseDecisionApiMode(process.env, raw),
    context: optionalFlag(args, 'context') ?? null,
    apiEval: optionalFlag(args, 'api-eval') === '1',
  };
}

/** 사람 출력 접미 — audit가 있을 때만 (off 모드 출력 100% 불변 유지) */
function apiSuffix(audit: DecisionApiAudit | null): string {
  if (audit === null) return '';
  return ` api=${audit.mode}(${audit.ok ? `p=${audit.p_api?.toFixed(3)},${audit.applied ? 'applied' : audit.disagreed ? 'disagreed' : 'agreed'}` : 'fallback'})`;
}

/** `dg gate --fork <existing>` 경로 — 기존 fork의 metadata_json에 decision_api를 병합 */
function mergeForkDecisionApi(db: DatabaseSync, forkId: string, audit: DecisionApiAudit): void {
  const row = db.prepare('SELECT metadata_json FROM forks WHERE fork_id = ?').get(forkId) as
    | { metadata_json: string | null }
    | undefined;
  if (!row) return;
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json ?? '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    /* 손상 JSON은 새 객체로 교체 */
  }
  meta['decision_api'] = audit;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE forks SET metadata_json = ? WHERE fork_id = ?').run(JSON.stringify(meta), forkId);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
}

// ---------- route ----------

async function cmdRoute(args: ParsedArgs, json: boolean): Promise<void> {
  const taskKindRaw = requireFlag(args, 'task-kind');
  const spec = taskKindSpec(taskKindRaw);
  if (!spec) {
    throw new UsageError(
      `invalid --task-kind "${taskKindRaw}" (allowed: explore_read|code_search|static_check|single_edit|multi_edit|test_or_deploy|swarm_fanout)`
    );
  }
  const riskOverride = parseRisk(optionalFlag(args, 'risk'));
  const title = optionalFlag(args, 'title') ?? null;
  const apiFlags = parseDecisionApiFlags(args);
  const theta = resolveSharpTheta(args);
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const ev = evaluateRoute(db, {
      projectId: identity.projectId,
      taskKind: spec.taskKind,
      risk: riskOverride,
      sharpThreshold: theta,
    });
    if (!ev) throw new UsageError(`invalid --task-kind "${taskKindRaw}"`); // spec 선행 검증으로 미도달
    const { post, forced, risk } = ev;
    let { decision } = ev;
    let finalP = post.p;
    let finalRisk = risk;
    const api =
      apiFlags.mode === 'off'
        ? null
        : await applyDecisionApi({
            mode: apiFlags.mode,
            adapter: createDecisionAdapter(apiFlags.mode),
            localDecision: ev.decision,
            pLocal: post.p,
            sharpThreshold: ev.sharpThreshold,
            basis: post.basis,
            sharpEligible: spec.sharpEligible,
            localRisk: risk,
            forcedSplit: forced.forcedSplit,
            forceApiEval: apiFlags.apiEval || apiFlags.context !== null,
            adapterInput: {
              projectId: identity.projectId,
              route: spec.route,
              toolClass: spec.toolClass,
              basis: post.basis,
              pLocal: post.p,
              taskKind: spec.taskKind,
              requiresWrite: spec.requiresWrite,
              riskLevel: risk,
              samples: post.samples,
              consecutiveErrors: post.consecutiveErrors,
              title,
              context: apiFlags.context,
            },
          });
    let audit: DecisionApiAudit | null = null;
    if (api) {
      decision = api.decision;
      finalP = api.p;
      finalRisk = api.risk;
      audit = api.audit;
    }
    const forkId = issueFork(db, {
      projectId: identity.projectId,
      projectLabel: identity.projectLabel,
      route: spec.route,
      toolClass: spec.toolClass,
      decision,
      pAtGate: finalP,
      basisAtGate: post.basis,
      forcedSplit: forced.forcedSplit,
      ttlMs: TTL_EXPLORE_MS,
      title,
      metadata: audit !== null ? { decision_api: audit } : undefined,
    });
    emit(
      json,
      () =>
        `[route] ${spec.taskKind} → ${decision.toUpperCase()} (${spec.route}/${spec.toolClass}) p=${finalP.toFixed(3)} (${post.basis}, n=${post.samples}) fork=${forkId}${apiSuffix(audit)}`,
      {
        fork_id: forkId,
        task_kind: spec.taskKind,
        route: spec.route,
        tool_class: spec.toolClass,
        requires_write: spec.requiresWrite,
        risk_level: finalRisk,
        p: finalP,
        basis: post.basis,
        samples: post.samples,
        consecutive_errors: post.consecutiveErrors,
        session_consec_err: forced.sessionConsecErr,
        decision,
        forced_split: forced.forcedSplit,
        forced_reason: forced.forcedReason,
        escalate_carbon: forced.escalateCarbon,
        sharp_threshold: ev.sharpThreshold,
        ttl_ms: TTL_EXPLORE_MS,
        project_id: identity.projectId,
        sample_sources: sampleSources(db, identity.projectId, spec.route, spec.toolClass),
        ...(audit !== null ? { decision_api: audit } : {}),
      }
    );
  } finally {
    db.close();
  }
}

// ---------- gate ----------

async function cmdGate(args: ParsedArgs, json: boolean): Promise<void> {
  const route = parseRoute(requireFlag(args, 'route'));
  const toolClass = requireFlag(args, 'tool-class');
  const riskOverride = parseRisk(optionalFlag(args, 'risk'));
  const conversation = optionalFlag(args, 'conversation') ?? null;
  const forkOpt = optionalFlag(args, 'fork');
  const apiFlags = parseDecisionApiFlags(args);
  const theta = resolveSharpTheta(args);
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const ev = evaluateGate(db, {
      projectId: identity.projectId,
      route,
      toolClass,
      conversationId: conversation,
      sharpThreshold: theta,
    });
    const { post, forced } = ev;
    let { decision } = ev;
    let finalP = post.p;
    // gate 경로 로컬 위험도는 --risk 오버라이드뿐 — API는 상향만 가능, 'high'는 우회 불가
    const localRisk: RiskLevel = riskOverride ?? 'low';
    const api =
      apiFlags.mode === 'off'
        ? null
        : await applyDecisionApi({
            mode: apiFlags.mode,
            adapter: createDecisionAdapter(apiFlags.mode),
            localDecision: ev.decision,
            pLocal: post.p,
            sharpThreshold: ev.sharpThreshold,
            basis: post.basis,
            sharpEligible: true,
            localRisk,
            forcedSplit: forced.forcedSplit,
            forceApiEval: apiFlags.apiEval || apiFlags.context !== null,
            adapterInput: {
              projectId: identity.projectId,
              route,
              toolClass,
              basis: post.basis,
              pLocal: post.p,
              riskLevel: localRisk,
              samples: post.samples,
              consecutiveErrors: post.consecutiveErrors,
              context: apiFlags.context,
            },
          });
    let audit: DecisionApiAudit | null = null;
    if (api) {
      decision = api.decision;
      finalP = api.p;
      audit = api.audit;
    }
    let forkId: string;
    if (forkOpt) {
      const fork = getFork(db, forkOpt);
      if (!fork) throw new UsageError(`fork not found: ${forkOpt}`);
      if (!isForkLiveStatus(fork.status)) throw new UsageError(`fork ${forkOpt} not open (status=${fork.status})`);
      forkId = forkOpt;
      // PB-1: 열린 구간이 없으면(레거시 발행 fork 등) 현재 attempt의 wait 구간을 멱등 보장
      ensureForkWaitInterval(db, forkId);
      if (audit !== null) mergeForkDecisionApi(db, forkId, audit);
    } else {
      forkId = issueFork(db, {
        projectId: identity.projectId,
        projectLabel: identity.projectLabel,
        route,
        toolClass,
        decision,
        pAtGate: finalP,
        basisAtGate: post.basis,
        forcedSplit: forced.forcedSplit,
        conversationId: conversation,
        ttlMs: TTL_CODING_MS,
        metadata: audit !== null ? { decision_api: audit } : undefined,
      });
    }
    emit(
      json,
      () =>
        `[gate] ${route}/${toolClass} → ${decision.toUpperCase()}${forced.forcedSplit ? ' (forced)' : ''} p=${finalP.toFixed(3)} (${post.basis}, n=${post.samples}) fork=${forkId}${apiSuffix(audit)}`,
      {
        fork_id: forkId,
        route,
        tool_class: toolClass,
        p: finalP,
        basis: post.basis,
        samples: post.samples,
        consecutive_errors: forced.keyConsecutiveErrors,
        session_consec_err: forced.sessionConsecErr,
        decision,
        forced_split: forced.forcedSplit,
        forced_reason: forced.forcedReason,
        escalate_carbon: forced.escalateCarbon,
        sharp_threshold: ev.sharpThreshold,
        ttl_ms: TTL_CODING_MS,
        project_id: identity.projectId,
        sample_sources: sampleSources(db, identity.projectId, route, toolClass),
        ...(audit !== null ? { decision_api: audit } : {}),
      }
    );
  } finally {
    db.close();
  }
}

// ---------- close ----------

const CLOSE_BY_OK_FAIL = new Set(['dispatcher', 'lead', 'worker', 'verifier']);
const CLOSE_BY_REROUTED = new Set(['worker', 'dispatcher']);

function cmdClose(args: ParsedArgs, json: boolean): void {
  const forkId = requireFlag(args, 'fork');
  const outcomeRaw = optionalFlag(args, 'outcome');
  const okAlias = optionalFlag(args, 'ok');
  let outcome: CloseOutcome;
  if (outcomeRaw !== undefined && okAlias !== undefined) {
    throw new UsageError('use either --outcome or --ok, not both');
  }
  if (outcomeRaw !== undefined) {
    if (outcomeRaw !== 'ok' && outcomeRaw !== 'fail' && outcomeRaw !== 'rerouted') {
      throw new UsageError(`invalid --outcome "${outcomeRaw}" (allowed: ok|fail|rerouted)`);
    }
    outcome = outcomeRaw;
  } else if (okAlias !== undefined) {
    if (okAlias !== '0' && okAlias !== '1') throw new UsageError(`invalid --ok "${okAlias}" (allowed: 0|1)`);
    outcome = okAlias === '1' ? 'ok' : 'fail';
  } else {
    throw new UsageError('missing required flag --outcome (or --ok 0|1)');
  }
  const byRaw = optionalFlag(args, 'by') ?? 'dispatcher';
  if (!['dispatcher', 'lead', 'worker', 'ttl', 'verifier'].includes(byRaw)) {
    throw new UsageError(`invalid --by "${byRaw}" (allowed: dispatcher|lead|worker|ttl|verifier)`);
  }
  // §3.3 닫힘 책임 매트릭스: rerouted는 worker·dispatcher만, ok/fail은 ttl 제외
  const allowedBy = outcome === 'rerouted' ? CLOSE_BY_REROUTED : CLOSE_BY_OK_FAIL;
  if (!allowedBy.has(byRaw)) {
    throw new UsageError(`--by ${byRaw} not allowed for outcome=${outcome}`);
  }
  const reason = optionalFlag(args, 'reason') ?? null;
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (!isForkLiveStatus(fork.status)) throw new UsageError(`fork ${forkId} already closed (status=${fork.status})`);
    const res = closeFork(db, forkId, outcome, byRaw, reason);
    emit(
      json,
      () => `[close] ${forkId} → ${res.status} by=${res.closedBy} recorded=${res.recorded}`,
      { fork_id: res.forkId, status: res.status, closed_by: res.closedBy, recorded: res.recorded, p_after: res.pAfter }
    );
  } finally {
    db.close();
  }
}

// ---------- touch ----------

function cmdTouch(args: ParsedArgs, json: boolean): void {
  const forkId = requireFlag(args, 'fork');
  const ttlMs = optionalFlag(args, 'ttl-ms') !== undefined ? parseIntFlag(args, 'ttl-ms', 600000) : undefined;
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (!isForkLiveStatus(fork.status)) throw new UsageError(`fork ${forkId} not open (status=${fork.status})`);
    const res = touchFork(db, forkId, ttlMs);
    emit(json, () => `[touch] ${res.forkId} last_touch=${res.lastTouchMs} ttl=${res.ttlMs}`, {
      fork_id: res.forkId,
      last_touch_ms: res.lastTouchMs,
      ttl_ms: res.ttlMs,
    });
  } finally {
    db.close();
  }
}

// ---------- record ----------

function cmdRecord(args: ParsedArgs, json: boolean): void {
  const route = parseRoute(requireFlag(args, 'route'));
  const toolClass = requireFlag(args, 'tool-class');
  const toolName = requireFlag(args, 'tool');
  const okRaw = requireFlag(args, 'ok');
  if (okRaw !== '0' && okRaw !== '1') throw new UsageError(`invalid --ok "${okRaw}" (allowed: 0|1)`);
  const ok = okRaw === '1';
  const weight = parseFloatFlag(args, 'weight', 1.0);
  const isRetry = optionalFlag(args, 'is-retry') === '1';
  const conversation = optionalFlag(args, 'conversation') ?? null;
  const source = parseSource(optionalFlag(args, 'source') ?? 'cli');
  const targetHash = optionalFlag(args, 'target-hash') ?? null;
  const errorSnippet = optionalFlag(args, 'error') ?? null;
  const step = optionalFlag(args, 'step') !== undefined ? parseIntFlag(args, 'step', 0) : null;
  const commandLine = optionalFlag(args, 'command') ?? null;
  const dedupeKey = optionalFlag(args, 'dedupe') ?? null;
  const forkId = optionalFlag(args, 'fork') ?? null;
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const res = recordToolOutcome(db, {
      projectId: identity.projectId,
      projectLabel: identity.projectLabel,
      route,
      toolClass,
      toolName,
      ok,
      weight,
      isRetry,
      conversationId: conversation,
      step,
      targetHash,
      errorSnippet,
      source,
      dedupeKey,
      forkId,
      commandLine,
    });
    const data: Record<string, unknown> = {
      recorded: res.recorded,
      reason: res.reason ?? null,
      is_retry: res.isRetry,
      route: res.route,
      p_after: res.pAfter,
      consecutive_errors: res.consecutiveErrors,
      session_consec_err: res.sessionConsecErr,
    };
    if (dedupeKey !== null) data.dedupe_key = dedupeKey;
    emit(
      json,
      () =>
        `[record] ${route}/${toolClass} ok=${ok ? 1 : 0} → ${res.recorded ? 'recorded' : `skipped (${res.reason})`}${res.isRetry ? ' [retry]' : ''} p_after=${res.pAfter.toFixed(3)}`,
      data
    );
  } finally {
    db.close();
  }
}

// ---------- backprop ----------

/**
 * `dg backprop` 두 모드:
 * - `--verdict-file` 부재: 기존 수동 역귀속(exit 0, UsageError=2).
 * - `--verdict-file <p>` 존재: PR-A3 fail-closed verdict 파이프라인 —
 *   `validateVerdictFile` → `applyVerdictToFork` → exit code는 결과의
 *   `exitCode`(0 pass/backprop_fail/rework, 3 escalate_human)를 그대로 반환.
 */
function cmdBackprop(args: ParsedArgs, json: boolean): number | void {
  const forkId = requireFlag(args, 'fork');
  const verdictFile = optionalFlag(args, 'verdict-file');
  const penalty = parseFloatFlag(args, 'penalty', 2.0);
  const reason = optionalFlag(args, 'reason') ?? null;
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (verdictFile !== undefined) {
      try {
        const expectedHead = optionalFlag(args, 'expected-head');
        const maxReworks = parseIntFlag(args, 'max-reworks', 2);
        const verdict = validateVerdictFile(verdictFile, {
          expectedForkId: forkId,
          expectedHead,
        });
        const res = applyVerdictToFork(db, { forkId, verdict, maxReworks });
        emit(
          json,
          () => `[backprop] ${forkId} verdict=${verdict.effectiveDecision} → ${res.action} (exit ${res.exitCode})`,
          {
            fork_id: forkId,
            valid: verdict.valid,
            effective_decision: verdict.effectiveDecision,
            errors: verdict.errors,
            action: res.action,
            exit_code: res.exitCode,
            committed: res.committed,
            reason: res.reason ?? null,
            waiting_human: res.waitingHuman ?? false,
            p_after: res.pAfter ?? null,
          }
        );
        return res.exitCode;
      } catch (err) {
        // fail-closed: verdict 경로의 내부 예외를 §3.5 DB 폴백(exit 0)으로 흡수하지 않는다
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[dg backprop] verdict pipeline error: ${message}\n`);
        let waitingHuman = false;
        try {
          waitingHuman = markForkWaitingHuman(db, forkId, {
            reason: `verdict pipeline error: ${message}`,
          }).marked;
        } catch {
          /* DB까지 불량이면 마킹 생략 — exit 3은 유지 */
        }
        emit(
          json,
          () => `[backprop] ${forkId} verdict 처리 오류 → escalate_human (exit 3): ${message}`,
          {
            fork_id: forkId,
            valid: false,
            effective_decision: 'human',
            errors: [message],
            action: 'escalate_human',
            exit_code: 3,
            committed: waitingHuman,
            reason: message,
            waiting_human: waitingHuman,
            p_after: null,
          }
        );
        return 3;
      }
    }
    if (!isForkLiveStatus(fork.status) && fork.status !== 'ok') {
      throw new UsageError(`fork ${forkId} cannot backprop (status=${fork.status})`);
    }
    const res = backpropFork(db, forkId, penalty, reason, { cause: 'gate_fail' });
    if (!res.committed) {
      throw new UsageError(`fork ${forkId} cannot backprop (${res.reason ?? 'stale'})`);
    }
    emit(json, () => `[backprop] ${res.forkId} → backprop_fail penalty=${res.weightApplied} p_after=${res.pAfter.toFixed(3)}`, {
      fork_id: res.forkId,
      status: res.status,
      neon_verdict: res.neonVerdict,
      weight_applied: res.weightApplied,
      p_after: res.pAfter,
    });
  } finally {
    db.close();
  }
}

// ---------- attempt ----------

/**
 * `dg attempt --fork <id> [--bump-gen] [--json]` (PB-1 §3.5):
 * 열린 fork의 attempt를 +1(`--bump-gen`이면 generation도 +1)하고 새 `wait` 구간을
 * 연다 — 재시도 경계의 펜싱 토큰 갱신에 쓰인다.
 */
function cmdAttempt(args: ParsedArgs, json: boolean): void {
  const forkId = requireFlag(args, 'fork');
  const bumpGen = optionalFlag(args, 'bump-gen') === '1';
  const db = openWriter(dbFlag(args));
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (!isForkLiveStatus(fork.status)) throw new UsageError(`fork ${forkId} not open (status=${fork.status})`);
    const res = bumpForkAttempt(db, forkId, { bumpGen });
    emit(
      json,
      () => `[attempt] ${res.forkId} → gen=${res.generation} attempt=${res.attempt}${bumpGen ? ' (gen bumped)' : ''}`,
      { fork_id: res.forkId, generation: res.generation, attempt: res.attempt }
    );
  } finally {
    db.close();
  }
}

// ---------- settle-orphans ----------

function cmdSettleOrphans(args: ParsedArgs, json: boolean): void {
  const db = openWriter(dbFlag(args));
  try {
    const res = settleOrphans(db);
    emit(json, () => `[settle-orphans] settled=${res.settled}${res.forkIds.length ? ` (${res.forkIds.join(', ')})` : ''}`, {
      settled: res.settled,
      fork_ids: res.forkIds,
      ttl_policy_ms: { explore: TTL_EXPLORE_MS, coding: TTL_CODING_MS },
    });
  } finally {
    db.close();
  }
}

// ---------- wrap ----------

interface WrapRunResult {
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  durationMs: number;
  stalled: boolean;
  timedOut: boolean;
  stdoutNonEmpty: boolean;
  firstNonBlankLine: string | null;
  tailLines: string[];
}

const SIGNAL_EXIT_OFFSET: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15,
};

/**
 * 단일 자식 실행 + 진행 감시 루프(§2.5): stdout/stderr를 패스스루 캡처하고
 * `hasNewProgress` 게이트의 하트비트(onHeartbeat)와 stall/timeout 워치독을 돌린다.
 * `detached:true`로 자식을 자체 프로세스 그룹 리더로 띄워 `killProcessGroup`이
 * 자식의 자식까지 한 번에 끝내도록 한다.
 */
function runWrappedChild(opts: {
  command: string[];
  env: NodeJS.ProcessEnv;
  stallMs: number;
  maxMs: number;
  heartbeatMs: number;
  killGraceMs: number;
  onHeartbeat: () => void;
  /** 스폰 직후 1회 호출 — fork_intervals `exec` 구간 시작 지점 (PB-1 §3.2) */
  onSpawn?: () => void;
}): Promise<WrapRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let lastTouchAt = startedAt;
    let hasNewProgress = false;
    let settled = false;
    let killSent = false;
    let stalled = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let stdoutNonEmpty = false;
    let firstNonBlankLine: string | null = null;
    let stdoutScanBuf = '';
    let pendingLine = '';
    const tailLines: string[] = [];

    const pushLine = (line: string): void => {
      tailLines.push(redactSecrets(line));
      if (tailLines.length > 20) tailLines.shift();
    };
    const ingest = (text: string): void => {
      const parts = (pendingLine + text).split('\n');
      pendingLine = parts.pop() ?? '';
      for (const l of parts) pushLine(l);
    };

    const child = spawn(opts.command[0]!, opts.command.slice(1), {
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: true,
      env: opts.env,
    });
    try {
      opts.onSpawn?.();
    } catch {
      /* 구간 기록 실패는 실행을 막지 않는다 — 커밋 시점에 열린 구간은 정리됨 */
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();
      hasNewProgress = true;
      process.stdout.write(text);
      if (!stdoutNonEmpty && /\S/.test(text)) stdoutNonEmpty = true;
      if (firstNonBlankLine === null) {
        stdoutScanBuf += text;
        for (const l of stdoutScanBuf.split('\n')) {
          if (l.trim().length > 0) {
            firstNonBlankLine = l.trim();
            break;
          }
        }
      }
      ingest(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();
      hasNewProgress = true;
      process.stderr.write(text);
      ingest(text);
    });
    child.on('error', (err) => {
      spawnError = err.message;
    });

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (pendingLine.length > 0) pushLine(pendingLine);
      resolve({
        exitCode: code,
        signal,
        spawnError,
        durationMs: Date.now() - startedAt,
        stalled,
        timedOut,
        stdoutNonEmpty,
        firstNonBlankLine,
        tailLines,
      });
    };

    const killGroup = (sig: 'SIGTERM' | 'SIGKILL'): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 무시 */
        }
      }
    };

    const beginKill = (kind: 'stall' | 'timeout'): void => {
      if (killSent) return;
      killSent = true;
      if (kind === 'stall') stalled = true;
      else timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => {
        if (!settled) killGroup('SIGKILL');
      }, opts.killGraceMs).unref();
    };

    // 1s 틱 — --stall-ms 지정 시 반응성을 위해 min(stallMs/4, 1000) 틱
    const tickMs =
      opts.stallMs > 0 ? Math.min(Math.max(Math.floor(opts.stallMs / 4), 10), 1000) : 1000;
    const timer = setInterval(() => {
      if (settled || killSent) return; // 킬 개시 후 하트비트·감시 즉시 중단
      const now = Date.now();
      if (opts.stallMs > 0 && now - lastOutputAt >= opts.stallMs) {
        beginKill('stall');
        return;
      }
      if (opts.maxMs > 0 && now - startedAt >= opts.maxMs) {
        beginKill('timeout');
        return;
      }
      if (hasNewProgress && opts.heartbeatMs > 0 && now - lastTouchAt >= opts.heartbeatMs) {
        try {
          opts.onHeartbeat();
        } catch {
          /* fork가 이미 닫혀 있음 — 하트비트만 중단 */
        }
        hasNewProgress = false;
        lastTouchAt = now;
      }
    }, tickMs);
    timer.unref();
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function statSizeOrNull(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

async function cmdWrap(args: ParsedArgs, json: boolean): Promise<number> {
  const route = parseRoute(requireFlag(args, 'route'));
  const toolClass = requireFlag(args, 'tool-class');
  const forkOpt = optionalFlag(args, 'fork');
  const source = parseSource(optionalFlag(args, 'source') ?? 'wrap');
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const command = args.rest;
  if (command.length === 0) throw new UsageError('missing child command after "--"');

  // §2.5 출력·산출물 계약 + 감시·펜스 플래그
  const requireArtifact = optionalFlag(args, 'require-artifact');
  const requireNonempty = optionalFlag(args, 'require-nonempty') === '1';
  const requireStdout = optionalFlag(args, 'require-stdout-nonempty') === '1';
  const stallMs = parseIntFlag(args, 'stall-ms', 120_000);
  const maxMs = parseIntFlag(args, 'max-ms', 1_200_000);
  const heartbeatMs = parseIntFlag(args, 'heartbeat-ms', 60_000);
  const killGraceMs = parseIntFlag(args, 'kill-grace-ms', 1_000);
  const expectedGen = optionalFlag(args, 'expected-gen') !== undefined
    ? parseIntFlag(args, 'expected-gen', 0)
    : undefined;
  const expectedAttempt = optionalFlag(args, 'expected-attempt') !== undefined
    ? parseIntFlag(args, 'expected-attempt', 0)
    : undefined;
  const sanitizeEnv = optionalFlag(args, 'sanitize-env') === '1';
  const allowEnv = (optionalFlag(args, 'allow-env') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let forkId: string | null = null;
  let db: DatabaseSync | null = null;
  try {
    db = openWriter(dbFlag(args));
    settleOrphans(db);
    if (forkOpt) {
      const fork = getFork(db, forkOpt);
      if (!fork) throw new UsageError(`fork not found: ${forkOpt}`);
      if (!isForkLiveStatus(fork.status)) throw new UsageError(`fork ${forkOpt} not open (status=${fork.status})`);
      forkId = forkOpt;
    } else {
      const post = getPosterior(db, identity.projectId, route, toolClass);
      const forced = evaluateForced(db, identity.projectId, route, toolClass, null);
      forkId = issueFork(db, {
        projectId: identity.projectId,
        projectLabel: identity.projectLabel,
        route,
        toolClass,
        decision: forced.forcedSplit ? 'split' : post.p >= 0.7 ? 'sharp' : 'split',
        pAtGate: post.p,
        basisAtGate: post.basis,
        forcedSplit: forced.forcedSplit,
        ttlMs: TTL_EXPLORE_MS,
        title: command.join(' ').slice(0, 80),
      });
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    process.stderr.write(`[dg wrap] db fallback: ${(err as Error).message}\n`);
    try {
      db?.close();
    } catch {
      /* 무시 */
    }
    db = null;
    forkId = forkId ?? fallbackForkId();
  }

  const isFallbackFork = forkId === null || forkId.startsWith('fk_fallback_');
  const onHeartbeat = (): void => {
    if (db === null || isFallbackFork || forkId === null) return;
    touchFork(db, forkId);
  };
  const childEnv = sanitizeEnv
    ? buildSanitizedChildEnv({ allowKeys: allowEnv })
    : process.env;

  // PB-1 §3.2: 스폰 직후 `exec` 구간을 연다 — fk_fallback 또는 DB 무연결 시 생략
  const execAttempt =
    db !== null && !isFallbackFork && forkId !== null ? getForkGenAttempt(db, forkId)?.attempt ?? null : null;
  const onSpawn = (): void => {
    if (db === null || isFallbackFork || forkId === null || execAttempt === null) return;
    recordForkIntervalStart(db, { forkId, attempt: execAttempt, phase: 'exec', nowMs: Date.now() });
  };

  const run = await runWrappedChild({
    command,
    env: childEnv,
    stallMs,
    maxMs,
    heartbeatMs,
    killGraceMs,
    onHeartbeat,
    onSpawn,
  });

  // AND 게이트 출력 계약(§2.5): clean exit(0 + 자연 종료)에서만 계약 평가
  const cleanExit = run.exitCode === 0 && !run.stalled && !run.timedOut && run.spawnError === null;
  let contractOk = true;
  let noResult = false;
  let artifactMissing = false;
  let rerouted = false;
  if (requireStdout && cleanExit && run.firstNonBlankLine === 'rerouted') {
    rerouted = true; // 워커의 리드 승격 신호 — 표본·실패 모두 아님
  }
  if (requireStdout && cleanExit && !rerouted && !run.stdoutNonEmpty) {
    contractOk = false;
    noResult = true;
  }
  if (requireArtifact !== undefined && cleanExit && !rerouted) {
    const size = statSizeOrNull(requireArtifact);
    if (size === null || (requireNonempty && size === 0)) {
      contractOk = false;
      artifactMissing = true;
    }
  }
  const ok = cleanExit && contractOk && !rerouted;
  let cause: FailureCause = classifyFailure({
    ok,
    exitCode: run.exitCode,
    signal: run.signal,
    stalled: run.stalled,
    timedOut: run.timedOut,
    artifactMissing,
    noResult,
    errorText: run.spawnError ?? run.tailLines.join('\n'),
  });
  // 외인성 정상 중단(SIGINT/SIGTERM, 스톨 킬 제외)은 rerouted로 분리해 EWMA 오염 차단
  let outcome: CloseOutcome = rerouted ? 'rerouted' : ok ? 'ok' : 'fail';
  if (!rerouted && cause === 'interrupted') outcome = 'rerouted';
  if (rerouted && cause !== 'interrupted') cause = 'interrupted';

  // Bug A 수정: recordToolOutcome + closeFork 2-Tx → commitWrapOutcome 단일 Tx
  let committed = false;
  let recorded = false;
  let closed = false;
  let rejectReason: string | null = null;
  if (db !== null) {
    try {
      if (!isFallbackFork && forkId !== null) {
        const res = commitWrapOutcome(db, {
          forkId,
          projectId: identity.projectId,
          projectLabel: identity.projectLabel,
          route,
          toolClass,
          toolName: 'dg_wrap',
          ok,
          outcome,
          cause,
          exitCode: run.exitCode,
          signal: run.signal,
          errorSnippet: run.spawnError ?? run.tailLines.join('\n') ?? null,
          commandLine: command.join(' '),
          source,
          expectedGen,
          expectedAttempt,
        });
        committed = res.committed;
        recorded = res.recorded;
        closed = res.closed;
        rejectReason = res.reason ?? null;
      } else {
        // fork 미발행 폴백 — 표본만 기록(구 동작 호환)
        const res = recordToolOutcome(db, {
          projectId: identity.projectId,
          projectLabel: identity.projectLabel,
          route,
          toolClass,
          toolName: 'dg_wrap',
          ok,
          weight: 1,
          conversationId: null,
          source,
          forkId,
          commandLine: command.join(' '),
          cause,
        });
        recorded = res.recorded;
      }
    } catch (err) {
      process.stderr.write(`[dg wrap] record fallback: ${(err as Error).message}\n`);
    } finally {
      try {
        db.close();
      } catch {
        /* 무시 */
      }
    }
  }
  const exitCode =
    run.exitCode ?? (run.signal !== null ? 128 + (SIGNAL_EXIT_OFFSET[run.signal] ?? 0) : 127);
  const summary = {
    fork_id: forkId,
    exit_code: exitCode,
    ok: ok ? 1 : 0,
    cause,
    outcome,
    committed,
    recorded,
    closed,
    stalled: run.stalled,
    timed_out: run.timedOut,
    duration_ms: run.durationMs,
    tail_lines: run.tailLines,
    ...(rejectReason !== null ? { reason: rejectReason } : {}),
  };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  return exitCode;
}

// ---------- compact ----------

function cmdCompact(args: ParsedArgs, json: boolean): void {
  const maxEvents = parseIntFlag(args, 'max-events', 50_000);
  const days = parseIntFlag(args, 'days', 30);
  const db = openWriter(dbFlag(args));
  try {
    const res = compactDb(db, maxEvents, days);
    emit(
      json,
      () => `[compact] deleted_events=${res.deletedEvents} deleted_forks=${res.deletedForks} remaining=${res.remainingEvents}`,
      {
        deleted_events: res.deletedEvents,
        deleted_forks: res.deletedForks,
        checkpoint: res.checkpoint,
        remaining_events: res.remainingEvents,
      }
    );
  } finally {
    db.close();
  }
}

// ---------- retro ----------

/** 원인·상태 기반 다음 시도 권고(최대 3줄) — retro 마크다운의 권고 블록 소재 */
function retroRecommendations(data: {
  metadata: { cause?: string; waiting_human?: boolean; rework_count?: number };
  fork: { status: string };
}): string[] {
  const out: string[] = [];
  const cause = data.metadata.cause;
  if (cause === 'stall' || cause === 'timeout') {
    out.push('무출력 스톨/타임아웃 — 작업을 더 작은 단위로 분할하고 주기적 진행 로그를 남겨라');
  }
  if (cause === 'artifact_missing' || cause === 'no_result') {
    out.push('산출물 계약 미충족 — 요구 산출물 경로·작성 의무·종료 전 출력을 브리프에 명시하라');
  }
  if (cause === 'gate_fail') {
    out.push('Verifier fail — findings의 evidence를 해소한 뒤 재검증하라');
  }
  if (cause === 'config_error') {
    out.push('환경/설정 오류 — CLI 경로·플래그·인증 키를 먼저 점검하라(EWMA 표본 미반영)');
  }
  if (data.metadata.waiting_human === true) {
    out.push('사람 승인 대기 — waiting_reason을 확인하고 사람이 개입 결정하라');
  }
  if ((data.metadata.rework_count ?? 0) > 0) {
    out.push(`재작업 ${data.metadata.rework_count}회 누적 — 같은 접근 반복 대신 근본 원인을 재진단하라`);
  }
  return out.slice(0, 3);
}

/**
 * `dg retro --fork <id> [--out <path>] [--json]` (§2.7):
 * `collectForkRetroData` → `buildRetroMarkdown(..., sanitize: redactSecrets)`로
 * 다음 워커 브리프용 회고 마크다운을 생성한다. `--out` 지정 시 부모 디렉터리를
 * 만들고 파일로 기록, 아니면 stdout으로 출력한다.
 */
function cmdRetro(args: ParsedArgs, json: boolean): void {
  const forkId = requireFlag(args, 'fork');
  const outPath = optionalFlag(args, 'out');
  const db = openWriter(dbFlag(args));
  try {
    const data = collectForkRetroData(db, forkId);
    if (!data) throw new UsageError(`fork not found: ${forkId}`);
    const md = buildRetroMarkdown({
      forkId,
      projectLabel: data.fork.project_label,
      route: data.fork.route,
      toolClass: data.fork.tool_class,
      status: data.fork.status,
      attempts: data.metadata.attempt ?? data.eventCount,
      cause: data.metadata.cause,
      reworkCount: data.metadata.rework_count,
      reason:
        data.metadata.close_reason ??
        data.metadata.backprop_reason ??
        data.metadata.waiting_reason,
      topFailedTools: data.topFailedTools.map((t) => ({
        toolName: t.toolName,
        count: t.count,
        lastError: t.lastError ?? undefined,
      })),
      recommendations: retroRecommendations(data),
      sanitize: redactSecrets,
    });
    if (outPath !== undefined) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, md, 'utf8');
    } else if (!json) {
      process.stdout.write(md);
      return;
    }
    emit(
      json,
      () => `[retro] ${forkId} → ${outPath ?? 'stdout'}`,
      { fork_id: forkId, written: outPath !== undefined, out: outPath ?? null, markdown: md }
    );
  } finally {
    db.close();
  }
}

// ---------- stats (PB-2.5: readOnly — settleOrphans 절대 금지) ----------

/**
 * `dg stats [--cost] [--timing] [--project <dir>] [--fork <id>] [--days 14] [--db <path>] [--json]`
 * `--cost`/`--timing` 둘 다 미지정이면 둘 다 포함한다. 읽기전용 연결로만 열어
 * v1 DB에서도 파일을 변경하지 않는다.
 */
function cmdStats(args: ParsedArgs, json: boolean): void {
  const wantCost = optionalFlag(args, 'cost') === '1';
  const wantTiming = optionalFlag(args, 'timing') === '1';
  const includeCost = wantCost || !wantTiming;
  const includeTiming = wantTiming || !wantCost;
  const days = parseIntFlag(args, 'days', 14);
  const forkId = optionalFlag(args, 'fork') ?? undefined;
  const projectDir = optionalFlag(args, 'project');
  const projectId = projectDir !== undefined ? resolveIdentity(projectDir).projectId : undefined;
  const db = openReader(dbFlag(args));
  try {
    const cost = includeCost ? computeCostStats(db, { projectId, days }) : undefined;
    const timing = includeTiming ? computeTimingStats(db, { projectId, forkId, days }) : undefined;
    emit(
      json,
      () => {
        const parts: string[] = [];
        if (cost) {
          const usd =
            cost.total_usd_display === null ? 'unavailable' : `$${cost.total_usd_display.toFixed(4)}`;
          parts.push(
            `cost events=${cost.total_events} known_usd=${usd} unknown=${cost.unknown_events}${cost.schema_v1 ? ' (schema_v1)' : ''}`
          );
        }
        if (timing) {
          parts.push(
            timing.intervals_unavailable
              ? 'timing intervals_unavailable (v1 schema)'
              : `timing exec=${timing.execution_ms}ms wait=${timing.wait_ms}ms wall=${timing.wall_ms}ms coverage=${timing.coverage_ratio.toFixed(3)}`
          );
        }
        return `[stats] ${parts.join(' · ')}`;
      },
      {
        cmd: 'stats',
        project_id: projectId ?? null,
        days,
        fork_id: forkId ?? null,
        cost: cost ?? null,
        timing: timing ?? null,
      }
    );
  } finally {
    db.close();
  }
}

// ---------- checkpoint / worktree (PB-2.5: B4 삭제 게이트 배선) ----------

/** `dg checkpoint create|verify|restore` — 실패는 exit 1 (게이트 거부 exit 4는 worktree remove 전용) */
function cmdCheckpoint(sub: string | undefined, args: ParsedArgs, json: boolean): number {
  if (sub === 'create') {
    const res = createWorktreeCheckpoint({
      repoDir: optionalFlag(args, 'repo') ?? process.cwd(),
      worktreeDir: requireFlag(args, 'worktree'),
      runId: requireFlag(args, 'run-id'),
      worktreeName: optionalFlag(args, 'name'),
      checkpointRoot: optionalFlag(args, 'checkpoint-root'),
    });
    if (!res.saved) {
      for (const e of res.errors) process.stderr.write(`[dg checkpoint] ${e}\n`);
    }
    emit(
      json,
      () => `[checkpoint create] ${res.saved ? `saved → ${res.checkpointDir}` : 'failed'}`,
      { action: 'create', saved: res.saved, checkpoint_dir: res.checkpointDir ?? null, errors: res.errors }
    );
    return res.saved ? 0 : 1;
  }
  if (sub === 'verify') {
    const res = verifyWorktreeCheckpoint(requireFlag(args, 'dir'));
    if (!res.valid) {
      for (const e of res.errors) process.stderr.write(`[dg checkpoint] ${e}\n`);
    }
    emit(json, () => `[checkpoint verify] ${res.valid ? 'valid' : 'invalid'}`, {
      action: 'verify',
      valid: res.valid,
      errors: res.errors,
    });
    return res.valid ? 0 : 1;
  }
  if (sub === 'restore') {
    const res = restoreWorktreeCheckpoint({
      checkpointDir: requireFlag(args, 'dir'),
      targetWorktreeDir: requireFlag(args, 'target'),
    });
    if (!res.restored) {
      for (const e of res.errors) process.stderr.write(`[dg checkpoint] ${e}\n`);
    }
    emit(json, () => `[checkpoint restore] ${res.restored ? 'restored' : 'failed'}`, {
      action: 'restore',
      restored: res.restored,
      errors: res.errors,
    });
    return res.restored ? 0 : 1;
  }
  throw new UsageError(`unknown checkpoint subcommand: ${sub ?? '(missing)'} (allowed: create|verify|restore)`);
}

/**
 * `dg worktree remove` — `safeRemoveWorktree` 단일 진입만 경유(우회 경로 없음).
 * 종료코드는 결과의 `exitCode` 그대로(체크포인트 미통과 시 4).
 */
function cmdWorktree(sub: string | undefined, args: ParsedArgs, json: boolean): number {
  if (sub !== 'remove') {
    throw new UsageError(`unknown worktree subcommand: ${sub ?? '(missing)'} (allowed: remove)`);
  }
  const res = safeRemoveWorktree({
    repoDir: optionalFlag(args, 'repo') ?? process.cwd(),
    worktreeDir: requireFlag(args, 'worktree'),
    runId: optionalFlag(args, 'run-id') ?? `wt-rm-${Date.now()}`,
    worktreeName: optionalFlag(args, 'name'),
    checkpointRoot: optionalFlag(args, 'checkpoint-root'),
    forceGitRemove: optionalFlag(args, 'force') === '1',
  });
  if (!res.removed) {
    for (const e of res.errors) process.stderr.write(`[dg worktree] ${e}\n`);
  }
  emit(
    json,
    () =>
      `[worktree remove] ${res.removed ? `removed (checkpoint → ${res.checkpointDir})` : `refused/failed (exit ${res.exitCode})`}`,
    {
      action: 'remove',
      removed: res.removed,
      exit_code: res.exitCode,
      checkpoint_dir: res.checkpointDir ?? null,
      errors: res.errors,
    }
  );
  return res.exitCode;
}

// ---------- report (PB-2.5: readOnly — settleOrphans 절대 금지) ----------

/**
 * `dg report [--days 14] [--project <dir>] [--out <path>] [--repo <dir>] [--db <path>] [--json]`
 * `openReportDb`(readOnly + query_only)로만 연다. `--out`은 allowlist 가드 통과
 * 경로에만 기록하며 거부 시 파일·부모 디렉터리 모두 미생성 + stderr + exit 2.
 */
function cmdReport(args: ParsedArgs, json: boolean): number {
  const days = parseIntFlag(args, 'days', 14);
  const projectDir = optionalFlag(args, 'project');
  const projectId = projectDir !== undefined ? resolveIdentity(projectDir).projectId : undefined;
  const repoDir = optionalFlag(args, 'repo') ?? process.cwd();
  const outPath = optionalFlag(args, 'out');
  const db = openReportDb(dbFlag(args));
  try {
    const rep = generateRuleCandidateReport(db, { projectId: projectId ?? null, days });
    const md = formatReportMarkdown(rep);
    if (outPath !== undefined) {
      const w = writeReportFileSafe({ outPath, repoDir, content: md });
      if (!w.written) {
        process.stderr.write(`[dg report] --out refused: ${outPath} (${w.reason ?? 'forbidden_out_path'})\n`);
        return 2;
      }
      emit(
        json,
        () => `[report] written → ${w.resolvedPath}`,
        { cmd: 'report', written: true, out: w.resolvedPath ?? null, report: rep }
      );
      return 0;
    }
    emit(json, () => md, { cmd: 'report', written: false, out: null, report: rep, markdown: md });
    return 0;
  } finally {
    db.close();
  }
}

// ---------- fallback & main ----------

function fallbackJson(cmd: string, err: Error, args: ParsedArgs): Record<string, unknown> {
  const base: Record<string, unknown> = { cmd, fallback: true, error: err.message };
  const fork = optionalFlag(args, 'fork');
  if (cmd === 'route') {
    return { ...base, fork_id: fallbackForkId(), task_kind: optionalFlag(args, 'task-kind') ?? null, decision: 'split', forced_split: false };
  }
  if (cmd === 'gate') {
    return { ...base, fork_id: fork ?? fallbackForkId(), decision: 'split', forced_split: false };
  }
  if (cmd === 'settle-orphans') {
    return { ...base, settled: 0, fork_ids: [], ttl_policy_ms: { explore: TTL_EXPLORE_MS, coding: TTL_CODING_MS } };
  }
  if (cmd === 'compact') {
    return { ...base, deleted_events: 0, deleted_forks: 0, checkpoint: 'TRUNCATE', remaining_events: 0 };
  }
  if (cmd === 'record') return { ...base, recorded: false };
  if (cmd === 'close') return { ...base, fork_id: fork ?? null, recorded: false };
  if (cmd === 'backprop') return { ...base, fork_id: fork ?? null, status: null };
  if (cmd === 'retro') return { ...base, fork_id: fork ?? null, written: false };
  if (cmd === 'attempt') return { ...base, fork_id: fork ?? null, generation: null, attempt: null };
  if (cmd === 'stats') return { ...base, cost: null, timing: null };
  if (cmd === 'report') return { ...base, written: false };
  return fork ? { ...base, fork_id: fork } : base;
}

const HELP = `dg — decision gate CLI (plan-r2.1 §4.7)

사용법:
  dg route --task-kind <explore_read|code_search|static_check|single_edit|multi_edit|test_or_deploy|swarm_fanout> [--project <dir>] [--title <text>] [--context <text>] [--decision-api <off|shadow|on>] [--api-eval] [--json]
  dg gate --route <r> --tool-class <c> [--fork <id>] [--risk <low|medium|high>] [--conversation <id>] [--project <dir>] [--context <text>] [--decision-api <off|shadow|on>] [--api-eval] [--json]
  dg close --fork <id> --outcome <ok|fail|rerouted> [--ok 0|1] [--by dispatcher|lead|worker|ttl|verifier] [--reason <text>] [--json]
  dg touch --fork <id> [--ttl-ms <n>] [--json]
  dg record --route <r> --tool-class <c> --tool <name> --ok <0|1> [--weight 1.0] [--is-retry] [--conversation <id>] [--source <hook|agy_stream|transcript|rest_api|cli|wrap|ttl_orphan|neon_backprop>] [--target-hash <h>] [--error <snippet>] [--step <n>] [--command <text>] [--dedupe <key>] [--fork <id>] [--project <dir>] [--json]
  dg backprop --fork <id> [--penalty 2.0] [--reason <text>] [--json]
  dg backprop --fork <id> --verdict-file <p> [--expected-head <sha>] [--max-reworks 2] [--json]
  dg attempt --fork <id> [--bump-gen] [--json]
  dg retro --fork <id> [--out <path>] [--json]
  dg settle-orphans [--json]
  dg wrap --route <r> --tool-class <c> [--fork <id>] [--source wrap] [--require-artifact <path>] [--require-nonempty] [--require-stdout-nonempty] [--stall-ms 120000] [--max-ms 1200000] [--heartbeat-ms 60000] [--kill-grace-ms 1000] [--expected-gen <n>] [--expected-attempt <n>] [--sanitize-env] [--allow-env K1,K2] [--json] -- <cmd…>
  dg compact [--max-events 50000] [--days 30] [--json]
  dg stats [--cost] [--timing] [--project <dir>] [--fork <id>] [--days 14] [--db <path>] [--json]
  dg checkpoint create --worktree <path> --run-id <id> [--repo <dir>] [--name <wtName>] [--checkpoint-root <dir>] [--json]
  dg checkpoint verify --dir <checkpointDir> [--json]
  dg checkpoint restore --dir <checkpointDir> --target <worktreeDir> [--json]
  dg worktree remove --worktree <path> [--repo <dir>] [--run-id <id>] [--name <wtName>] [--checkpoint-root <dir>] [--force] [--json]
  dg report [--days 14] [--project <dir>] [--out <path>] [--repo <dir>] [--db <path>] [--json]

라우트 r: file_select|tool_select|retry_or_abort|delegate_swarm
공용: --db <path>는 DGATE_DB_PATH·DECISION_ORCHESTRATOR_DB_PATH·GEMINI_TRICK_DB_PATH보다 우선. --roster <path>/--profile <name> 명시 시
route·gate에 roster 기반 동적 θ_sharp 적용 (미지정 시 0.70).
Decision API: DECISION_API=off|shadow|on + GEMINI_DECISION_API_KEY (키 부재 시 off 강등).
--decision-api는 env를 덮어쓰고, --context/--api-eval은 measured 기반에서도 평가를 강제한다.
DB 경로: DGATE_DB_PATH 환경변수(레거시 별칭 DECISION_ORCHESTRATOR_DB_PATH·GEMINI_TRICK_DB_PATH) 또는 기본 ~/.local/state/dgate/decision.db`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${HELP}\n`);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const cmd = argv[0]!;
  if (!['route', 'gate', 'close', 'touch', 'record', 'backprop', 'attempt', 'retro', 'settle-orphans', 'wrap', 'compact', 'stats', 'checkpoint', 'worktree', 'report'].includes(cmd)) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}\n`);
    process.exit(2);
  }
  let args: ParsedArgs;
  let json = false;
  try {
    // checkpoint/worktree는 2단 서브커맹 — 동사를 먼저 떼고 나머지를 플래그로 파싱한다
    const sub = cmd === 'checkpoint' || cmd === 'worktree' ? argv[1] : undefined;
    args = parseArgs(sub !== undefined ? argv.slice(2) : argv.slice(1));
    json = optionalFlag(args, 'json') === '1';
    switch (cmd) {
      case 'route':
        await cmdRoute(args, json);
        break;
      case 'gate':
        await cmdGate(args, json);
        break;
      case 'close':
        cmdClose(args, json);
        break;
      case 'touch':
        cmdTouch(args, json);
        break;
      case 'record':
        cmdRecord(args, json);
        break;
      case 'backprop': {
        const code = cmdBackprop(args, json);
        if (typeof code === 'number') process.exit(code);
        break;
      }
      case 'attempt':
        cmdAttempt(args, json);
        break;
      case 'retro':
        cmdRetro(args, json);
        break;
      case 'settle-orphans':
        cmdSettleOrphans(args, json);
        break;
      case 'wrap': {
        // 비동기 래핑 — 자식 감시 루프 완료 후 promise 핸들러가 exit 수행
        cmdWrap(args, json).then(
          (code) => process.exit(code),
          (err) => {
            if (err instanceof UsageError) {
              process.stderr.write(`[dg] ${(err as Error).message}\n`);
              process.exit(2);
            }
            process.stderr.write(`[dg wrap] fatal: ${(err as Error).message}\n`);
            process.exit(1);
          }
        );
        return;
      }
      case 'compact':
        cmdCompact(args, json);
        break;
      case 'stats':
        cmdStats(args, json);
        break;
      case 'checkpoint':
        process.exit(cmdCheckpoint(sub, args, json));
        break;
      case 'worktree':
        process.exit(cmdWorktree(sub, args, json));
        break;
      case 'report':
        process.exit(cmdReport(args, json));
        break;
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`[dg] ${err.message}\n`);
      process.exit(2);
    }
    // 안전 폴백(§3.5): stderr 경고 + 안전 JSON + exit 0
    process.stderr.write(`[dg] db fallback: ${(err as Error).message}\n`);
    try {
      process.stdout.write(`${JSON.stringify(fallbackJson(cmd, err as Error, args!))}\n`);
    } catch {
      /* args 파싱 실패 시 폴백 본문 생략 */
    }
    process.exit(0);
  }
}

main().catch((err) => {
  process.stderr.write(`[dg] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
