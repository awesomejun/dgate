#!/usr/bin/env node
/**
 * `dg` CLI — Decision 게이트 명령 체계 (plan-r2.1 §4.7, 9종).
 *
 * 목적: `route | gate | close | touch | record | backprop | settle-orphans | wrap | compact`
 * 명령으로 태스크 단위 선별 라우팅(LLM 턴 0)·Fork 생명주기·표본 수집을 제어한다.
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
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDbSafe, resolveProjectIdentity } from './db.ts';
import {
  backpropFork,
  closeFork,
  compactDb,
  evaluateForced,
  getFork,
  getPosterior,
  isEventSource,
  isRouteId,
  issueFork,
  recordToolOutcome,
  sampleSources,
  settleOrphans,
  taskKindSpec,
  escalateRisk,
  touchFork,
  TTL_CODING_MS,
  TTL_EXPLORE_MS,
  type CloseOutcome,
  type EventSource,
  type RiskLevel,
  type RouteId,
} from './engine.ts';

class UsageError extends Error {}

/** 값 없이 단독으로 쓰는 불리언 플래그 */
const BOOL_FLAGS = new Set(['json', 'is-retry']);

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

function openWriter(): DatabaseSync {
  const db = openDbSafe(undefined, { busyTimeoutMs: 5000 });
  if (!db) throw new Error('decision db unavailable');
  return db;
}

// ---------- route ----------

function cmdRoute(args: ParsedArgs, json: boolean): void {
  const taskKindRaw = requireFlag(args, 'task-kind');
  const spec = taskKindSpec(taskKindRaw);
  if (!spec) {
    throw new UsageError(
      `invalid --task-kind "${taskKindRaw}" (allowed: explore_read|code_search|static_check|single_edit|multi_edit|test_or_deploy|swarm_fanout)`
    );
  }
  const riskOverride = parseRisk(optionalFlag(args, 'risk'));
  const title = optionalFlag(args, 'title') ?? null;
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const db = openWriter();
  try {
    settleOrphans(db);
    const risk = escalateRisk(spec.defaultRisk, riskOverride);
    const post = getPosterior(db, identity.projectId, spec.route, spec.toolClass);
    const forced = evaluateForced(db, identity.projectId, spec.route, spec.toolClass, null);
    let decision: 'sharp' | 'split';
    if (forced.forcedSplit) {
      decision = 'split';
    } else {
      // §2.0 sharp 패스트패스 4조건 (전부 만족 시에만)
      decision =
        spec.sharpEligible && !spec.requiresWrite && risk === 'low' && post.p >= 0.7 && post.consecutiveErrors < 2
          ? 'sharp'
          : 'split';
    }
    const forkId = issueFork(db, {
      projectId: identity.projectId,
      projectLabel: identity.projectLabel,
      route: spec.route,
      toolClass: spec.toolClass,
      decision,
      pAtGate: post.p,
      basisAtGate: post.basis,
      forcedSplit: forced.forcedSplit,
      ttlMs: TTL_EXPLORE_MS,
      title,
    });
    emit(
      json,
      () =>
        `[route] ${spec.taskKind} → ${decision.toUpperCase()} (${spec.route}/${spec.toolClass}) p=${post.p.toFixed(3)} (${post.basis}, n=${post.samples}) fork=${forkId}`,
      {
        fork_id: forkId,
        task_kind: spec.taskKind,
        route: spec.route,
        tool_class: spec.toolClass,
        requires_write: spec.requiresWrite,
        risk_level: risk,
        p: post.p,
        basis: post.basis,
        samples: post.samples,
        consecutive_errors: post.consecutiveErrors,
        session_consec_err: 0,
        decision,
        forced_split: forced.forcedSplit,
        forced_reason: forced.forcedReason,
        escalate_carbon: forced.escalateCarbon,
        ttl_ms: TTL_EXPLORE_MS,
        project_id: identity.projectId,
        sample_sources: sampleSources(db, identity.projectId, spec.route, spec.toolClass),
      }
    );
  } finally {
    db.close();
  }
}

// ---------- gate ----------

function cmdGate(args: ParsedArgs, json: boolean): void {
  const route = parseRoute(requireFlag(args, 'route'));
  const toolClass = requireFlag(args, 'tool-class');
  const riskOverride = parseRisk(optionalFlag(args, 'risk'));
  const conversation = optionalFlag(args, 'conversation') ?? null;
  const forkOpt = optionalFlag(args, 'fork');
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const db = openWriter();
  try {
    settleOrphans(db);
    const post = getPosterior(db, identity.projectId, route, toolClass);
    const forced = evaluateForced(db, identity.projectId, route, toolClass, conversation);
    const decision: 'sharp' | 'split' = forced.forcedSplit ? 'split' : post.p >= 0.7 ? 'sharp' : 'split';
    let forkId: string;
    if (forkOpt) {
      const fork = getFork(db, forkOpt);
      if (!fork) throw new UsageError(`fork not found: ${forkOpt}`);
      if (fork.status !== 'open') throw new UsageError(`fork ${forkOpt} not open (status=${fork.status})`);
      forkId = forkOpt;
    } else {
      forkId = issueFork(db, {
        projectId: identity.projectId,
        projectLabel: identity.projectLabel,
        route,
        toolClass,
        decision,
        pAtGate: post.p,
        basisAtGate: post.basis,
        forcedSplit: forced.forcedSplit,
        conversationId: conversation,
        ttlMs: TTL_CODING_MS,
      });
    }
    emit(
      json,
      () =>
        `[gate] ${route}/${toolClass} → ${decision.toUpperCase()}${forced.forcedSplit ? ' (forced)' : ''} p=${post.p.toFixed(3)} (${post.basis}, n=${post.samples}) fork=${forkId}`,
      {
        fork_id: forkId,
        route,
        tool_class: toolClass,
        p: post.p,
        basis: post.basis,
        samples: post.samples,
        consecutive_errors: forced.keyConsecutiveErrors,
        session_consec_err: forced.sessionConsecErr,
        decision,
        forced_split: forced.forcedSplit,
        forced_reason: forced.forcedReason,
        escalate_carbon: forced.escalateCarbon,
        ttl_ms: TTL_CODING_MS,
        project_id: identity.projectId,
        sample_sources: sampleSources(db, identity.projectId, route, toolClass),
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
  const db = openWriter();
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (fork.status !== 'open') throw new UsageError(`fork ${forkId} already closed (status=${fork.status})`);
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
  const db = openWriter();
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (fork.status !== 'open') throw new UsageError(`fork ${forkId} not open (status=${fork.status})`);
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
  const db = openWriter();
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

function cmdBackprop(args: ParsedArgs, json: boolean): void {
  const forkId = requireFlag(args, 'fork');
  const penalty = parseFloatFlag(args, 'penalty', 2.0);
  const reason = optionalFlag(args, 'reason') ?? null;
  const db = openWriter();
  try {
    settleOrphans(db);
    const fork = getFork(db, forkId);
    if (!fork) throw new UsageError(`fork not found: ${forkId}`);
    if (fork.status !== 'open' && fork.status !== 'ok') {
      throw new UsageError(`fork ${forkId} cannot backprop (status=${fork.status})`);
    }
    const res = backpropFork(db, forkId, penalty, reason);
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

// ---------- settle-orphans ----------

function cmdSettleOrphans(args: ParsedArgs, json: boolean): void {
  const db = openWriter();
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

function cmdWrap(args: ParsedArgs, json: boolean): number {
  const route = parseRoute(requireFlag(args, 'route'));
  const toolClass = requireFlag(args, 'tool-class');
  const forkOpt = optionalFlag(args, 'fork');
  const source = parseSource(optionalFlag(args, 'source') ?? 'wrap');
  const identity = resolveIdentity(optionalFlag(args, 'project'));
  const command = args.rest;
  if (command.length === 0) throw new UsageError('missing child command after "--"');

  let forkId: string | null = null;
  let db: DatabaseSync | null = null;
  try {
    db = openWriter();
    settleOrphans(db);
    if (forkOpt) {
      const fork = getFork(db, forkOpt);
      if (!fork) throw new UsageError(`fork not found: ${forkOpt}`);
      if (fork.status !== 'open') throw new UsageError(`fork ${forkOpt} not open (status=${fork.status})`);
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
    forkId = forkId ?? fallbackForkId();
  }

  const startedMs = Date.now();
  const child = spawnSync(command[0]!, command.slice(1), { stdio: ['inherit', 'inherit', 'inherit'] });
  const durationMs = Date.now() - startedMs;
  const exitCode = child.status ?? 1;
  const ok = child.status === 0;

  let recorded = false;
  let closed = false;
  if (db) {
    try {
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
        commandLine: command.join(' '), // B6 자기 호출 제외 판정 대상
      });
      recorded = res.recorded;
      if (forkId && !forkId.startsWith('fk_fallback_')) {
        closeFork(db, forkId, ok ? 'ok' : 'fail', 'worker', `exit_code=${exitCode}`, { recordStats: false });
        closed = true;
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
  const summary = {
    fork_id: forkId,
    exit_code: exitCode,
    ok: ok ? 1 : 0,
    duration_ms: durationMs,
    recorded,
    closed,
  };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  return exitCode;
}

// ---------- compact ----------

function cmdCompact(args: ParsedArgs, json: boolean): void {
  const maxEvents = parseIntFlag(args, 'max-events', 50_000);
  const days = parseIntFlag(args, 'days', 30);
  const db = openWriter();
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
  return fork ? { ...base, fork_id: fork } : base;
}

const HELP = `dg — decision gate CLI (plan-r2.1 §4.7)

사용법:
  dg route --task-kind <explore_read|code_search|static_check|single_edit|multi_edit|test_or_deploy|swarm_fanout> [--project <dir>] [--title <text>] [--json]
  dg gate --route <r> --tool-class <c> [--fork <id>] [--risk <low|medium|high>] [--conversation <id>] [--project <dir>] [--json]
  dg close --fork <id> --outcome <ok|fail|rerouted> [--ok 0|1] [--by dispatcher|lead|worker|ttl|verifier] [--reason <text>] [--json]
  dg touch --fork <id> [--ttl-ms <n>] [--json]
  dg record --route <r> --tool-class <c> --tool <name> --ok <0|1> [--weight 1.0] [--is-retry] [--conversation <id>] [--source <hook|agy_stream|transcript|rest_api|cli|wrap|ttl_orphan|neon_backprop>] [--target-hash <h>] [--error <snippet>] [--step <n>] [--command <text>] [--dedupe <key>] [--fork <id>] [--project <dir>] [--json]
  dg backprop --fork <id> [--penalty 2.0] [--reason <text>] [--json]
  dg settle-orphans [--json]
  dg wrap --route <r> --tool-class <c> [--fork <id>] [--source wrap] [--json] -- <cmd…>
  dg compact [--max-events 50000] [--days 30] [--json]

라우트 r: file_select|tool_select|retry_or_abort|delegate_swarm
DB 경로: GEMINI_TRICK_DB_PATH 환경변수 또는 기본 ~/.local/state/gemini-trick/decision.db`;

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${HELP}\n`);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const cmd = argv[0]!;
  if (!['route', 'gate', 'close', 'touch', 'record', 'backprop', 'settle-orphans', 'wrap', 'compact'].includes(cmd)) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}\n`);
    process.exit(2);
  }
  let args: ParsedArgs;
  let json = false;
  try {
    args = parseArgs(argv.slice(1));
    json = optionalFlag(args, 'json') === '1';
    switch (cmd) {
      case 'route':
        cmdRoute(args, json);
        break;
      case 'gate':
        cmdGate(args, json);
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
      case 'backprop':
        cmdBackprop(args, json);
        break;
      case 'settle-orphans':
        cmdSettleOrphans(args, json);
        break;
      case 'wrap': {
        const code = cmdWrap(args, json);
        process.exit(code);
        break;
      }
      case 'compact':
        cmdCompact(args, json);
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

main();
