#!/usr/bin/env node
/**
 * `scripts/dispatch.ts` — Layer 0 Pre-Lead 디스패처 (plan-r2.1 §2.0·§6.1·§6.4).
 *
 * 목적: 태스크(`task_kind` 7종)를 `src/decision` 엔진으로 평가해 `sharp` fast-path
 * (읽기전용 `pi` 탐색 워커 직행 — 리드 0턴) 또는 `split`(리드 승격)으로 분기하는
 * 실행 계획(`hc run`·`git worktree` argv)을 산출한다. LLM 턴을 쓰지 않는다.
 *
 * 외부 연결:
 * - CLI: `node ./scripts/dispatch.ts --task-kind <k> --repo <dir> [--roster <path>] [--db <path>] [--dry-run] [--json]`.
 * - `herdr-quad-launch.ts --mode orchestrate`가 `planDispatch`·`checkHcNameCollisions`
 *   를 import해 dry-run 리허설과 N12 충돌 점검에 재사용한다.
 * - sharp 경로는 `dg wrap --fork <id> -- pi … --tools read,grep,find,ls --no-approve`
 *   로 래핑돼 종료코드가 SSOT에 직접 기록된다(B6).
 * - W3.5: 역할 슬롯 CLI·모델은 `src/decision/roster.ts`(roster.json)에서 해석하고,
 *   `dg.ts`·역할 계약서는 `ORCHESTRATOR_ROOT`(스크립트 위치 기준)에서 해석해
 *   `--repo <타 저장소>`로 실행해도 정상 동작한다(작업 cwd·project_id는 --repo 기준).
 *
 * 주의:
 * - `--dry-run`은 임시 `:memory:` DB에서 리허설해 기본 사용자 DB를 오염하지 않는다.
 *   `dbPath`가 명시돼도 읽기전용으로만 조회하고 fork는 `fk_dry_*` 가명을 쓴다.
 * - `hc run --name`은 `^[a-z0-9_-]{1,32}$` 제약 — `generateRunId`가 6자리 hex라
 *   모든 세션명이 32자를 초과하지 않는다(N-NEW-4·N12).
 * - 동시 탐색 ≤ 4 (`MAX_CONCURRENT_EXPLORE`), 코딩 ≤ 2 (`MAX_CONCURRENT_CODING`).
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { getAgyBudget, openDbSafe, resolveDbPath, resolveProjectIdentity } from '../src/decision/db.ts';
import {
  applyDecisionApi,
  createDecisionAdapter,
  isDecisionApiMode,
  parseDecisionApiMode,
  type DecisionApiAudit,
  type DecisionApiMode,
} from '../src/decision/adapter.ts';
import {
  acquireScopeLease,
  escalateRisk,
  evaluateRoute,
  issueFork,
  priorP0,
  settleOrphans,
  SHARP_P_THRESHOLD,
  taskKindSpec,
  TTL_EXPLORE_MS,
  type ForcedState,
  type PosteriorResult,
  type RiskLevel,
  type RouteId,
} from '../src/decision/engine.ts';
import { computeDynamicSharpThreshold } from '../src/decision/stats.ts';
import {
  buildWorkerCommand,
  loadRosterConfig,
  resolveRosterProfile,
  resolveRoleContractPath,
  resolveWorkerBin,
  ROLE_SLOT_INFO,
  ROLE_SLOTS,
} from '../src/decision/roster.ts';

/** 오케스트레이터 루트 — `dg.ts`·`.herdr/roles/*.md`는 여기 기준으로 해석한다(--repo와 무관). */
export const ORCHESTRATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAX_CONCURRENT_EXPLORE = 4;
export const MAX_CONCURRENT_CODING = 2;
const HC_NAME_RE = /^[a-z0-9_-]{1,32}$/;

// ---------- run id / session name (N-NEW-4·N12) ----------

/** 6자리 hex — 모든 `hc --name`이 32자를 초과하지 않도록 보장한다. */
export function generateRunId(): string {
  return randomBytes(3).toString('hex');
}

export function sessionNameOk(name: string): boolean {
  return HC_NAME_RE.test(name);
}

// ---------- hc ls 충돌 점검 (N12) ----------

interface HcLsTerminal {
  address?: string;
  name?: string;
  state?: string;
}

/**
 * `hc ls --json` 출력에서 live 터미널 식별자(name·address)를 수집한다.
 * `hcLsJson`에는 파싱된 객체 또는 raw JSON 문자열을 넘길 수 있다(테스트 주입용).
 * 생략 시 실제 `hc ls --json`을 실행하고, 실패하면 빈 목록을 반환한다.
 */
export function listHcLiveNames(hcLsJson?: unknown): string[] {
  let data: unknown = hcLsJson;
  if (data === undefined) {
    const res = spawnSync('hc', ['ls', '--json'], { encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return [];
    try {
      data = JSON.parse(res.stdout);
    } catch {
      return [];
    }
  } else if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const terminals = (data as { terminals?: unknown }).terminals;
  if (!Array.isArray(terminals)) return [];
  const names: string[] = [];
  for (const t of terminals as HcLsTerminal[]) {
    if (typeof t?.name === 'string' && t.name) names.push(t.name);
    if (typeof t?.address === 'string' && t.address) names.push(t.address);
  }
  return names;
}

export interface HcCollisionResult {
  collisions: string[];
  liveNames: string[];
}

export function checkHcNameCollisions(wanted: string[], hcLsJson?: unknown): HcCollisionResult {
  const liveNames = listHcLiveNames(hcLsJson);
  const live = new Set(liveNames);
  return { collisions: wanted.filter((n) => live.has(n)), liveNames };
}

// ---------- planDispatch ----------

export interface PlanDispatchInput {
  taskKind: string;
  risk?: RiskLevel;
  repoDir: string;
  dbPath?: string;
  runId?: string;
  dryRun?: boolean;
  taskFile?: string;
  idx?: number;
  activeExplore?: number;
  activeCoding?: number;
  /** `--roster` 명시 경로 (미지정 시 roster.ts 우선순위 탐색: env → project → global → 내장) */
  rosterPath?: string | null;
}

export interface DispatchPlan {
  ok: boolean;
  deferred: boolean;
  reason: string | null;
  forkId: string | null;
  taskKind: string | null;
  route: RouteId | null;
  toolClass: string | null;
  requiresWrite: boolean | null;
  riskLevel: RiskLevel | null;
  p: number | null;
  basis: 'prior' | 'measured' | null;
  samples: number;
  consecutiveErrors: number;
  decision: 'sharp' | 'split' | null;
  forcedSplit: boolean;
  escalateCarbon: boolean;
  ttlMs: number;
  sessionName: string | null;
  /** `hc` 뒤에 붙는 argv 배열 목록 (예: ['run','--bg','--name',…,'--',<cmd…>]) */
  hcCommands: string[][];
  worktreeCommands: string[][];
  carbonBriefPath: string | null;
  dbPath: string;
  runId: string;
  /** W3.5 — 작업 대상 저장소(= `--repo`)와 roster 해석 출처 */
  targetRepo: string;
  rosterSource: string;
  rosterSourcePath: string | null;
  rosterWarnings: string[];
  /** 역할 슬롯별 해석 결과 요약 (예: lead → `pi:glm-zcode/glm-5.3`) */
  roleSummary: Record<string, string>;
  /** PB-2A — 프로필 비용·쿼터 기반 동적 sharp 임계치 θ_sharp */
  sharp_threshold: number;
  /** Decision API 감사 — shadow/on 경로에서 API 평가가 실제 수행됐을 때만 존재 */
  decision_api?: DecisionApiAudit;
}

function emptyPlan(runId: string, dbPath: string): DispatchPlan {
  return {
    ok: false,
    deferred: false,
    reason: null,
    forkId: null,
    taskKind: null,
    route: null,
    toolClass: null,
    requiresWrite: null,
    riskLevel: null,
    p: null,
    basis: null,
    samples: 0,
    consecutiveErrors: 0,
    decision: null,
    forcedSplit: false,
    escalateCarbon: false,
    ttlMs: TTL_EXPLORE_MS,
    sessionName: null,
    hcCommands: [],
    worktreeCommands: [],
    carbonBriefPath: null,
    dbPath,
    runId,
    targetRepo: '',
    rosterSource: 'builtin',
    rosterSourcePath: null,
    rosterWarnings: [],
    roleSummary: {},
    sharp_threshold: SHARP_P_THRESHOLD,
  };
}

function priorOnly(spec: { route: RouteId; toolClass: string }): PosteriorResult {
  return {
    p: priorP0(spec.route, spec.toolClass),
    basis: 'prior',
    samples: 0,
    consecutiveErrors: 0,
    lambda: 0,
    pHier: priorP0(spec.route, spec.toolClass),
    ewmaSuccess: 0,
    ewmaFail: 0,
  };
}

const NO_FORCED: ForcedState = {
  forcedSplit: false,
  forcedReason: null,
  escalateCarbon: false,
  keyConsecutiveErrors: 0,
  sessionConsecErr: 0,
};

/**
 * 태스크 단위 디스패치 계획 산출.
 * - `dryRun`: `:memory:` DB(또는 명시 dbPath의 읽기전용)에서 리허설 — 기본 DB 미오염,
 *   fork는 `fk_dry_<runId>` 가명, 실제 `forks` 행 미기록.
 * - 실행 모드: `resolveDbPath()`(또는 명시 dbPath)에 `settleOrphans` 후 fork를 발행한다.
 */
export function planDispatch(input: PlanDispatchInput): DispatchPlan {
  return planDispatchInner(input, null);
}

/** Decision API 오버라이드 — applyDecisionApi 결과를 계획 산출에 주입한다 */
interface ApiOverride {
  decision: 'sharp' | 'split';
  p: number;
  risk: RiskLevel;
  audit: DecisionApiAudit | null;
}

function planDispatchInner(input: PlanDispatchInput, api: ApiOverride | null): DispatchPlan {
  const runId = input.runId ?? generateRunId();
  const dryRun = input.dryRun === true;
  const repoDir = input.repoDir;
  const dbPath = input.dbPath ?? (dryRun ? ':memory:' : resolveDbPath());
  const plan = emptyPlan(runId, dbPath);

  const spec = taskKindSpec(input.taskKind);
  if (!spec) {
    plan.reason = `invalid task_kind: ${input.taskKind}`;
    plan.targetRepo = repoDir;
    return plan;
  }
  let risk = escalateRisk(spec.defaultRisk, input.risk);
  const identity = resolveProjectIdentity(repoDir);

  // W3.5 — 역할↔모델 바인딩을 roster.json에서 해석 (dispatch는 기본 프로필 사용)
  const loadedRoster = loadRosterConfig({ rosterPath: input.rosterPath, repoDir });
  const resolvedProfile = resolveRosterProfile(loadedRoster.config, loadedRoster.config.defaultProfile);
  const rosterProfile = resolvedProfile.profile;

  let post: PosteriorResult = priorOnly(spec);
  let forced: ForcedState = NO_FORCED;
  let forkId: string | null = null;
  let decision: 'sharp' | 'split' = 'split';

  let db: DatabaseSync | null = null;
  if (dryRun) {
    // 리허설: 명시 dbPath는 읽기전용 조회, 없으면 :memory: 임시 DB (기본 사용자 DB 미오염)
    db = input.dbPath
      ? openDbSafe(input.dbPath, { readOnly: true, busyTimeoutMs: 1000 })
      : openDbSafe(':memory:', { busyTimeoutMs: 250 });
  } else {
    db = openDbSafe(dbPath, { busyTimeoutMs: 5000 });
  }

  // PB-2A: roster 프로필 비용 + agy_budget 오늘 사용량(읽기전용 조회, dry-run은 0)으로
  // 동적 θ_sharp를 산출한다. 계산 실패는 fail-safe — 기본 0.70(= SHARP_P_THRESHOLD) 유지.
  const bucketUsage: Record<string, number> = {};
  if (db && !dryRun) {
    try {
      const budget = getAgyBudget(db);
      if (budget) bucketUsage['agy'] = budget.turnsUsed;
    } catch {
      /* 예산 조회 실패 — 사용량 0(κ=1.0)으로 진행 */
    }
  }
  const dyn = computeDynamicSharpThreshold({ profile: rosterProfile, bucketUsage });
  const sharpThreshold = dyn.threshold;

  try {
    if (db) {
      if (!dryRun) settleOrphans(db);
      const ev = evaluateRoute(db, {
        projectId: identity.projectId,
        taskKind: spec.taskKind,
        risk,
        sharpThreshold,
      });
      if (ev) {
        post = ev.post;
        forced = ev.forced;
        decision = ev.decision;
      }
    }
  } catch {
    db = null; // §3.5 휴리스틱 폴백 — post/forced는 prior 유지
  }

  if (db === null) {
    // §2.0 sharp 패스트패스 4조건 + 강제 split (dg.ts cmdRoute와 동일 판정)
    decision = forced.forcedSplit
      ? 'split'
      : spec.sharpEligible && !spec.requiresWrite && risk === 'low' && post.p >= sharpThreshold && post.consecutiveErrors < 2
        ? 'sharp'
        : 'split';
  }

  // Decision API 오버라이드 — on+applied 판정만 decision/p/risk에 반영.
  // shadow·실패·미실행 경로는 로컬 결과를 절대 건드리지 않는다.
  if (api?.audit) {
    plan.decision_api = api.audit;
    if (api.audit.applied) {
      decision = api.decision;
      post = { ...post, p: api.p };
      risk = api.risk;
    }
  }

  const idx = input.idx ?? 0;
  // 동시성 상한 (§6.4): 탐색 ≤4, 코딩 ≤2
  const expectedSession = decision === 'sharp' ? `exp-${idx}-${runId}` : `lead-${runId}`;
  let deferred = false;
  let reason: string | null = null;
  if (decision === 'sharp' && (input.activeExplore ?? 0) >= MAX_CONCURRENT_EXPLORE) {
    deferred = true;
    reason = `explore concurrency cap (${MAX_CONCURRENT_EXPLORE}) reached`;
  } else if (spec.requiresWrite && (input.activeCoding ?? 0) >= MAX_CONCURRENT_CODING) {
    deferred = true;
    reason = `coding concurrency cap (${MAX_CONCURRENT_CODING}) reached`;
  }
  // PR-A2 Cooperative Lease (§2.4): 동일 repo_scope를 살아있는 세션이 점유 중이면
  // deferred — dry-run은 fork 미기록이므로 검사하지 않는다. hc 조회 실패는 fail-open.
  if (!deferred && !dryRun && db) {
    try {
      const lease = acquireScopeLease(db, {
        repoScope: repoDir,
        leaseOwner: expectedSession,
        liveSessions: listHcLiveNames(),
      });
      if (!lease.acquired) {
        deferred = true;
        reason = lease.reason ?? `scope lease held by ${lease.holder ?? 'unknown'}`;
      }
    } catch {
      /* 리스 조회 실패 — fail-open, 리드 승격 판단에 위임 */
    }
  }

  if (!dryRun && db) {
    try {
      forkId = issueFork(db, {
        projectId: identity.projectId,
        projectLabel: identity.projectLabel,
        route: spec.route,
        toolClass: spec.toolClass,
        decision,
        pAtGate: post.p,
        basisAtGate: post.basis,
        forcedSplit: forced.forcedSplit,
        ttlMs: TTL_EXPLORE_MS,
        title: input.taskFile ?? null,
        // 점유 리스는 실제 디스패치(비 deferred) 때만 기록 — deferred fork는 스코프를 홀드하지 않는다
        metadata:
          deferred && !api?.audit
            ? undefined
            : {
                ...(deferred
                  ? {}
                  : {
                      repo_scope: repoDir,
                      lease_owner: expectedSession,
                      lease_until_ms: Date.now() + TTL_EXPLORE_MS,
                    }),
                ...(api?.audit ? { decision_api: api.audit } : {}),
              },
      });
    } catch {
      forkId = null;
    }
  }
  forkId ??= `fk_dry_${runId}`;

  let sessionName: string | null = null;
  const hcCommands: string[][] = [];
  const worktreeCommands: string[][] = [];
  let carbonBriefPath: string | null = null;

  if (!deferred && decision === 'sharp') {
    sessionName = expectedSession;
    const prompt = `임무파일 ${input.taskFile ?? 'TASK.md'} 를 읽고 조사 결과를 최종 메시지로 출력하라`;
    hcCommands.push([
      'run',
      '--bg',
      '--name',
      sessionName,
      '--cwd',
      repoDir,
      '--',
      'node',
      path.join(ORCHESTRATOR_ROOT, 'src', 'decision', 'dg.ts'),
      'wrap',
      '--route',
      spec.route,
      '--tool-class',
      spec.toolClass,
      '--fork',
      forkId,
      '--require-stdout-nonempty',
      '--stall-ms',
      '120000',
      '--',
      ...buildWorkerCommand(rosterProfile.roles.explore, { prompt }),
    ]);
  } else if (!deferred) {
    // split → 리드 승격 (§6.1 Layer 1) — 역할 계약서는 repo 우선, 없으면 오케스트레이터 폴백
    sessionName = expectedSession;
    const leadContract = resolveRoleContractPath(repoDir, ORCHESTRATOR_ROOT, 'lead') ?? '.herdr/roles/lead.md';
    hcCommands.push([
      'run',
      '--bg',
      '--name',
      sessionName,
      '--cwd',
      repoDir,
      '--',
      'env',
      `HERDR_ROLE=${ROLE_SLOT_INFO.lead.herdrRole}`,
      'HERDR_DELEGATE_MODE=hc',
      'HERDR_DB_WRITE=1',
      ...buildWorkerCommand(rosterProfile.roles.lead, {
        prompt: `역할계약서 ${leadContract} 를 읽고 대기/수행하라`,
      }),
    ]);
    if (forced.escalateCarbon) {
      carbonBriefPath = `.herdr/advice/gate1-${runId}.md`;
    }
  }

  if (db) {
    try {
      db.close();
    } catch {
      /* 무시 */
    }
  }

  plan.ok = true;
  plan.deferred = deferred;
  plan.reason = reason;
  plan.forkId = forkId;
  plan.taskKind = spec.taskKind;
  plan.route = spec.route;
  plan.toolClass = spec.toolClass;
  plan.requiresWrite = spec.requiresWrite;
  plan.riskLevel = risk;
  plan.p = post.p;
  plan.basis = post.basis;
  plan.samples = post.samples;
  plan.consecutiveErrors = post.consecutiveErrors;
  plan.decision = decision;
  plan.forcedSplit = forced.forcedSplit;
  plan.escalateCarbon = forced.escalateCarbon;
  plan.ttlMs = TTL_EXPLORE_MS;
  plan.sessionName = sessionName;
  plan.hcCommands = hcCommands;
  plan.worktreeCommands = worktreeCommands;
  plan.carbonBriefPath = carbonBriefPath;
  plan.targetRepo = repoDir;
  plan.rosterSource = loadedRoster.source;
  plan.rosterSourcePath = loadedRoster.sourcePath;
  plan.rosterWarnings = loadedRoster.warnings;
  const summary: Record<string, string> = {};
  for (const slot of ROLE_SLOTS) {
    const s = rosterProfile.roles[slot] ?? { cli: 'custom' };
    summary[slot] = `${s.cli}:${s.model ?? '-'}`;
  }
  plan.roleSummary = summary;
  plan.sharp_threshold = sharpThreshold;
  if (sessionName && !sessionNameOk(sessionName)) {
    plan.ok = false;
    plan.reason = `session name violates hc --name contract: ${sessionName}`;
  }
  return plan;
}

// ---------- Decision API 디스패치 ----------

export interface PlanDispatchWithApiInput extends PlanDispatchInput {
  /** 모드 오버라이드 — 생략 시 `DECISION_API` env. `off`면 planDispatch와 바이트 동등 */
  decisionApi?: DecisionApiMode;
  /** 작업 배경 스니펫 — API 프롬프트에 리댁션 후 포함 */
  context?: string;
  /** measured 기반에서도 API 평가 강제 (--api-eval) */
  apiEval?: boolean;
  /** 모드·어댑터 설정에 사용할 env — 생략 시 process.env */
  env?: Record<string, string | undefined>;
}

interface LocalDispatchEval {
  spec: NonNullable<ReturnType<typeof taskKindSpec>>;
  risk: RiskLevel;
  post: PosteriorResult;
  forced: ForcedState;
  localDecision: 'sharp' | 'split';
  sharpThreshold: number;
  basis: 'prior' | 'measured';
}

/**
 * planDispatchInner와 동일한 로컬 판정만 재계산 — 쓰기·fork 발행·리스 없이
 * Decision API 입력을 조립하기 위한 읽기 전용 프로브.
 */
function probeDispatchLocal(input: PlanDispatchWithApiInput): LocalDispatchEval | null {
  const spec = taskKindSpec(input.taskKind);
  if (!spec) return null;
  const risk = escalateRisk(spec.defaultRisk, input.risk);
  const repoDir = input.repoDir;
  const dryRun = input.dryRun === true;
  const dbPath = input.dbPath ?? (dryRun ? ':memory:' : resolveDbPath());
  const identity = resolveProjectIdentity(repoDir);
  const loadedRoster = loadRosterConfig({ rosterPath: input.rosterPath, repoDir });
  const rosterProfile = resolveRosterProfile(loadedRoster.config, loadedRoster.config.defaultProfile).profile;

  let db: DatabaseSync | null = null;
  try {
    db = input.dbPath
      ? openDbSafe(input.dbPath, { readOnly: true, busyTimeoutMs: 1000 })
      : dryRun
        ? openDbSafe(':memory:', { busyTimeoutMs: 250 })
        : openDbSafe(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  } catch {
    db = null;
  }

  const bucketUsage: Record<string, number> = {};
  if (db && !dryRun) {
    try {
      const budget = getAgyBudget(db);
      if (budget) bucketUsage['agy'] = budget.turnsUsed;
    } catch {
      /* 예산 조회 실패 — 사용량 0으로 진행 */
    }
  }
  const sharpThreshold = computeDynamicSharpThreshold({ profile: rosterProfile, bucketUsage }).threshold;

  let post: PosteriorResult = priorOnly(spec);
  let forced: ForcedState = NO_FORCED;
  if (db) {
    try {
      const ev = evaluateRoute(db, {
        projectId: identity.projectId,
        taskKind: spec.taskKind,
        risk,
        sharpThreshold,
      });
      if (ev) {
        post = ev.post;
        forced = ev.forced;
      }
    } catch {
      /* 조회 실패 — prior 폴백 */
    }
    try {
      db.close();
    } catch {
      /* 무시 */
    }
  }
  const localDecision = forced.forcedSplit
    ? 'split'
    : spec.sharpEligible && !spec.requiresWrite && risk === 'low' && post.p >= sharpThreshold && post.consecutiveErrors < 2
      ? 'sharp'
      : 'split';
  return { spec, risk, post, forced, localDecision, sharpThreshold, basis: post.basis };
}

/**
 * Decision API 적용 디스패치 — `off`는 `planDispatch`와 완전 동일 결과.
 * `dryRun: true`는 어떤 모드에서도 HTTP 0·DB 쓰기 0이다(프로브마저 생략).
 */
export async function planDispatchWithDecisionApi(input: PlanDispatchWithApiInput): Promise<DispatchPlan> {
  const env = input.env ?? process.env;
  const mode = parseDecisionApiMode(env, input.decisionApi);
  if (mode === 'off' || input.dryRun === true) {
    return planDispatch(input);
  }
  const probe = probeDispatchLocal(input);
  if (probe === null) return planDispatch(input);
  const identity = resolveProjectIdentity(input.repoDir);
  const api = await applyDecisionApi({
    mode,
    adapter: createDecisionAdapter(mode, env),
    localDecision: probe.localDecision,
    pLocal: probe.post.p,
    sharpThreshold: probe.sharpThreshold,
    basis: probe.basis,
    sharpEligible: probe.spec.sharpEligible,
    localRisk: probe.risk,
    forcedSplit: probe.forced.forcedSplit,
    forceApiEval: input.apiEval === true || (input.context?.trim() ?? '') !== '',
    adapterInput: {
      projectId: identity.projectId,
      route: probe.spec.route,
      toolClass: probe.spec.toolClass,
      basis: probe.basis,
      pLocal: probe.post.p,
      taskKind: probe.spec.taskKind,
      requiresWrite: probe.spec.requiresWrite,
      riskLevel: probe.risk,
      samples: probe.post.samples,
      consecutiveErrors: probe.post.consecutiveErrors,
      title: input.taskFile ?? null,
      context: input.context ?? null,
    },
  });
  return planDispatchInner(input, { decision: api.decision, p: api.p, risk: api.risk, audit: api.audit });
}

// ---------- CLI ----------

function parseCli(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run' || arg === '--json' || arg === '--api-eval') {
      out[arg.slice(2)] = '1';
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = argv[++i] ?? '';
      }
    }
  }
  return out;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

function renderPlan(plan: DispatchPlan, flags: Record<string, string>): number {
  if (flags.json === '1') {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else {
    const head = `[dispatch] ${plan.taskKind ?? '?'} → ${(plan.decision ?? 'ERR').toString().toUpperCase()}${plan.deferred ? ' (deferred)' : ''} p=${plan.p?.toFixed(3) ?? '-'} θ_sharp=${plan.sharp_threshold.toFixed(4)} fork=${plan.forkId ?? '-'}`;
    process.stdout.write(`${head}\n`);
    process.stdout.write(`  target_repo=${plan.targetRepo}\n`);
    process.stdout.write(`  roster_source=${plan.rosterSource}${plan.rosterSourcePath ? ` (${plan.rosterSourcePath})` : ''}\n`);
    process.stdout.write(`  roles: ${Object.entries(plan.roleSummary).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
    for (const w of plan.rosterWarnings) process.stdout.write(`  roster warning: ${w}\n`);
    for (const argv of plan.hcCommands) {
      process.stdout.write(`  hc ${argv.join(' ')}\n`);
    }
    for (const argv of plan.worktreeCommands) {
      process.stdout.write(`  ${argv.join(' ')}\n`);
    }
    if (plan.carbonBriefPath) process.stdout.write(`  carbon brief: ${plan.carbonBriefPath}\n`);
    if (plan.decision_api) {
      const a = plan.decision_api;
      process.stdout.write(
        `  decision_api: ${a.mode} ${a.ok ? `p_api=${a.p_api?.toFixed(3)} ${a.applied ? 'applied' : a.disagreed ? 'disagreed' : 'agreed'}` : 'fallback'}\n`
      );
    }
    if (plan.reason) process.stdout.write(`  reason: ${plan.reason}\n`);
  }
  return plan.ok ? 0 : 2;
}

if (isMainModule()) {
  const flags = parseCli(process.argv.slice(2));
  const rawMode = flags['decision-api'];
  if (rawMode !== undefined && !isDecisionApiMode(rawMode)) {
    process.stderr.write(`[dispatch] invalid --decision-api "${rawMode}" (allowed: off|shadow|on)\n`);
    process.exit(2);
  }
  const input: PlanDispatchWithApiInput = {
    taskKind: flags['task-kind'] ?? '',
    risk: flags.risk as RiskLevel | undefined,
    repoDir: flags.repo ?? flags.project ?? process.cwd(),
    dbPath: flags.db,
    runId: flags['run-id'],
    dryRun: flags['dry-run'] === '1',
    taskFile: flags['task-file'],
    idx: flags.idx !== undefined ? Number(flags.idx) : undefined,
    activeExplore: flags['active-explore'] !== undefined ? Number(flags['active-explore']) : undefined,
    activeCoding: flags['active-coding'] !== undefined ? Number(flags['active-coding']) : undefined,
    rosterPath: flags.roster,
    decisionApi: rawMode as DecisionApiMode | undefined,
    context: flags.context,
    apiEval: flags['api-eval'] === '1',
  };
  void planDispatchWithDecisionApi(input)
    .then((plan) => process.exit(renderPlan(plan, flags)))
    .catch((err) => {
      process.stderr.write(`[dispatch] fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
