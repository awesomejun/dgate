#!/usr/bin/env node
/**
 * `scripts/herdr-quad-launch.ts` — Herdr Quad/Orchestration 런처.
 *
 * 목적: ① 기존 `--mode demo|live|watch` 4분할 관제 런처를 그대로 유지하고,
 * ② `--mode orchestrate`(plan-r2.1 §6.1·§6.5)로 실제 5계층 `herdr+hc` 워커 체계의
 * 세션 계획 산출·`--dry-run` 검증·실기동을 담당한다.
 *
 * 외부 연결:
 * - `dispatch.ts`의 `planDispatch`/`generateRunId`/`checkHcNameCollisions`를 재사용한다.
 * - `--dry-run`은 실제 모델·프로세스·`hc run` 기동 0회로 계획·계약 검증만 출력한다.
 * - `resolveEffectiveProfile`은 `agy_budget` 초과 시 `agy-quad → quota-saver` 자동
 *   강등을 판정한다(B2/§6.4) — 단위 테스트용으로 export한다.
 * - W3.5: 역할 슬롯 CLI·모델은 `--roster <path>`(roster.json)로 교체 가능하고,
 *   `--repo <path>`로 이 Mac의 어느 로컬 저장소에서도 실행된다. `dg.ts`·`cli.ts`·
 *   역할 계약서는 오케스트레이터 루트(`ORCHESTRATOR_ROOT`) 기준, 작업 cwd·worktree·
 *   project_id는 `--repo` 기준으로 해석한다.
 *
 * 주의:
 * - `quota-saver`(기본): `standing_agy_sessions=0`, `max_ondemand_agy=0` — agy 사용 0,
 *   Carbon 관문 자문도 `pi`(glm-5.3) 온디맨드 1회만 생존 후 `hc kill; hc rm`.
 * - 모든 `pi` 명령은 `--no-approve` 포함(추가1: Trust 대화상자 blocked 방지).
 * - 모든 `hc run --name`은 `^[a-z0-9_-]{1,32}$`(N12) — `$RUN_ID` 접미 적용.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkHcNameCollisions,
  generateRunId,
  planDispatch,
  sessionNameOk,
  ORCHESTRATOR_ROOT,
  MAX_CONCURRENT_CODING,
  MAX_CONCURRENT_EXPLORE,
} from './dispatch.ts';
import { getAgyBudget, openDbSafe, resolveDbPath } from '../src/decision/db.ts';
import {
  buildWorkerCommand,
  builtinRosterConfig,
  countMaxOndemandByBucket,
  countStandingSessionsByBucket,
  effectiveQuotaBucket,
  loadRosterConfig,
  resolveRosterProfile,
  resolveRoleContractPath,
  resolveWorkerBin,
  ROLE_SLOT_INFO,
  ROLE_SLOTS,
  type RoleSlot,
  type RoleWorkerSpec,
} from '../src/decision/roster.ts';

export { checkHcNameCollisions, generateRunId } from './dispatch.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const AGY_BIN_FALLBACK = path.join(os.homedir(), '.local/bin/agy');
const HC_BIN_FALLBACK = path.join(os.homedir(), '.local/bin/hc');
const DEVIN_BIN_FALLBACK = path.join(os.homedir(), '.local/bin/devin');

/** 실행 파일 해석: 환경변수 → PATH(`which`) → 관례적 설치 위치 → 명령 이름. */
function resolveBinary(name: string, fallback: string, envKey?: string): string {
  if (envKey) {
    const v = process.env[envKey]?.trim();
    if (v) return v;
  }
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return name;
}

const HERDR_APP = resolveBinary('herdr-app', path.join(os.homedir(), '.local/bin/herdr-app'));
const HC_BIN = resolveBinary('hc', HC_BIN_FALLBACK, 'HC_BIN');
const AGY_BIN = resolveBinary('agy', AGY_BIN_FALLBACK, 'AGY_BIN');
const DEVIN_BIN = resolveBinary('devin', DEVIN_BIN_FALLBACK, 'DEVIN_BIN');
/** pi 실행 파일 — `resolveWorkerBin`(spec.bin·`PI_BIN`·PATH·`~/.bun/bin` 순)과 동일 규칙. */
const PI_BIN = resolveWorkerBin('pi');

// ---------- 프로필 체계 (B2/§6.1·§6.4 — W3.5 roster 기반 동적 계산) ----------

export type LauncherProfile = 'quota-saver' | 'agy-quad';

export interface ProfileSpec {
  profile: string;
  standingAgySessions: number;
  maxOndemandAgy: number;
}

const BUILTIN_PROFILE_BASE = builtinRosterConfig();

/** 내장 프로필 스펙 — 하드코딩이 아니라 roster roles에서 동적 계산된 값. */
export const PROFILE_SPECS: Record<string, ProfileSpec> = {
  'quota-saver': {
    profile: 'quota-saver',
    standingAgySessions: countStandingSessionsByBucket(BUILTIN_PROFILE_BASE.profiles['quota-saver']!, 'agy'),
    maxOndemandAgy: countMaxOndemandByBucket(BUILTIN_PROFILE_BASE.profiles['quota-saver']!, 'agy'),
  },
  'agy-quad': {
    profile: 'agy-quad',
    standingAgySessions: countStandingSessionsByBucket(BUILTIN_PROFILE_BASE.profiles['agy-quad']!, 'agy'),
    maxOndemandAgy: countMaxOndemandByBucket(BUILTIN_PROFILE_BASE.profiles['agy-quad']!, 'agy'),
  },
};

export interface EffectiveProfile {
  requested: string;
  effective: string;
  downgraded: boolean;
  turnsUsed: number;
  turnBudget: number;
}

/**
 * §6.4 예산 강등: 요청 프로필이 `agy-quad`이고 일일 `agy` 턴 사용량이 예산
 * (`HERDR_AGY_TURN_BUDGET`, 기본 20)을 초과했으면 `quota-saver`로 자동 강등한다.
 * 진행 중 세션은 정상 완료까지 허용되므로 판정은 "신규 기동" 관점이다.
 */
export function resolveEffectiveProfile(
  requested: LauncherProfile,
  turnsUsed: number,
  turnBudget = Number(process.env.HERDR_AGY_TURN_BUDGET ?? 20)
): EffectiveProfile {
  const budget = Number.isFinite(turnBudget) && turnBudget > 0 ? Math.floor(turnBudget) : 20;
  const downgraded = requested === 'agy-quad' && turnsUsed >= budget;
  return {
    requested,
    effective: downgraded ? 'quota-saver' : requested,
    downgraded,
    turnsUsed,
    turnBudget: budget,
  };
}

// ---------- orchestrate 계획 ----------

interface LaunchOptions {
  mode: 'demo' | 'live' | 'watch' | 'orchestrate';
  prompt: string | null;
  folder: string;
  tabName: string;
  dryRun: boolean;
  profile: string;
  /** `--profile` 명시 여부 — 미지정 시 roster `defaultProfile`을 따른다. */
  profileExplicit: boolean;
  rosterPath: string | null;
  runId: string | null;
  showWorkers: boolean;
  dbPath: string | null;
}

interface OrchCommand {
  label: string;
  session: string | null;
  argv: string[];
  display: string;
  kind: 'hc' | 'worktree' | 'tab' | 'note';
}

interface OrchestratePlan {
  runId: string;
  repoDir: string;
  dbPath: string;
  eff: EffectiveProfile;
  spec: ProfileSpec;
  commands: OrchCommand[];
  warnings: string[];
  rosterSource: string;
  rosterSourcePath: string | null;
  rosterWarnings: string[];
  roleSummary: Record<string, string>;
}

function argDisplay(argv: string[]): string {
  return argv.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

function hcRunDisplay(argv: string[]): string {
  return `hc ${argDisplay(argv)}`;
}

/** B2(§6.1 Layer 3): argv의 `--tools` 목록에 bash가 포함됐는지 검사한다. */
function argvToolsIncludeBash(argv: readonly string[]): boolean {
  const i = argv.indexOf('--tools');
  return i >= 0 && (argv[i + 1] ?? '').split(',').map((s) => s.trim()).includes('bash');
}

function summarizeRoles(roles: Record<string, RoleWorkerSpec | undefined>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const slot of ROLE_SLOTS) {
    const s = roles[slot] ?? { cli: 'custom' as const };
    summary[slot] = `${s.cli}:${s.model ?? '-'}${s.onDemand === true ? ' (on-demand)' : ''}`;
  }
  return summary;
}

function buildOrchestratePlan(opts: LaunchOptions): OrchestratePlan {
  const runId = opts.runId ?? generateRunId();
  const repoDir = opts.folder;
  const dbPath = resolveDbPath(opts.dbPath);

  // W3.5 — roster 해석: --roster > HERDR_ROSTER_PATH > <repo>/.herdr/roster.json > 전역 > 내장
  const loadedRoster = loadRosterConfig({ rosterPath: opts.rosterPath, repoDir });
  const warnings: string[] = [...loadedRoster.warnings];

  // agy 일일 예산 사용량 — dbPath 존재 시 읽기전용 조회(생성 금지), 없으면 0
  let turnsUsed = 0;
  if (fs.existsSync(dbPath)) {
    const db = openDbSafe(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
    if (db) {
      try {
        turnsUsed = getAgyBudget(db)?.turnsUsed ?? 0;
      } finally {
        try {
          db.close();
        } catch {
          /* 무시 */
        }
      }
    }
  }

  const requestedProfile = opts.profileExplicit ? opts.profile : loadedRoster.config.defaultProfile;
  const requestedResolved = resolveRosterProfile(loadedRoster.config, requestedProfile);
  if (requestedResolved.fallbackUsed) {
    warnings.push(`roster profile "${requestedProfile}" not defined — using "${requestedResolved.name}"`);
  }
  let profileName = requestedResolved.name;
  let profile = requestedResolved.profile;

  // §6.4 예산 강등 — 프로필이 agy 역할을 갖고 일일 예산 초과 시 fallbackProfile 강등.
  // 진행 중 세션은 정상 완료까지 허용되므로 판정은 "신규 기동" 관점이다.
  const hasAgyRoles = countMaxOndemandByBucket(profile, 'agy') > 0;
  const rawBudget = profile.dailyTurnBudgets?.agy ?? Number(process.env.HERDR_AGY_TURN_BUDGET ?? 20);
  const turnBudget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : 20;
  let downgraded = false;
  if (hasAgyRoles && profile.fallbackProfile && profile.fallbackProfile !== profileName && turnsUsed >= turnBudget) {
    const fallback = loadedRoster.config.profiles[profile.fallbackProfile];
    if (fallback) {
      warnings.push(
        `agy_budget ${turnsUsed} >= HERDR_AGY_TURN_BUDGET ${turnBudget} — profile ${profileName} → ${profile.fallbackProfile} 자동 강등 (진행 중 agy 세션은 정상 완료 허용)`
      );
      profileName = profile.fallbackProfile;
      profile = fallback;
      downgraded = true;
    }
  }

  const spec: ProfileSpec = {
    profile: profileName,
    standingAgySessions: countStandingSessionsByBucket(profile, 'agy'),
    maxOndemandAgy: countMaxOndemandByBucket(profile, 'agy'),
  };
  const eff: EffectiveProfile = { requested: requestedProfile, effective: profileName, downgraded, turnsUsed, turnBudget };

  const commands: OrchCommand[] = [];
  const monitorName = `mon-${runId}`;
  const cliAbs = path.join(ORCHESTRATOR_ROOT, 'src', 'cli.ts');
  commands.push({
    label: 'Tab1 monitor',
    session: monitorName,
    argv: ['node', cliAbs, '--watch-db', dbPath, '--watch'],
    display: `node ${cliAbs} --watch-db ${dbPath} --watch`,
    kind: 'tab',
  });

  // 상시 세션 — lead·advisor·verifier 슬롯 중 onDemand가 아닌 것 (explore/coder는
  // 디스패처가 관리하는 온디맨드 패턴). agy 슬롯은 기존 세션명(argon/carbon/neon) 유지.
  const STANDING_SLOTS: RoleSlot[] = ['lead', 'advisor', 'verifier'];
  const AGY_SESSION_PREFIX: Partial<Record<RoleSlot, string>> = { lead: 'argon', advisor: 'carbon', verifier: 'neon' };
  for (const slot of STANDING_SLOTS) {
    const roleSpec = profile.roles[slot];
    if (!roleSpec || roleSpec.onDemand === true) continue;
    const isAgy = effectiveQuotaBucket(roleSpec) === 'agy';
    const prefix = isAgy ? AGY_SESSION_PREFIX[slot] ?? slot : slot === 'verifier' ? 'verify' : slot;
    const name = `${prefix}-${runId}`;
    const info = ROLE_SLOT_INFO[slot];
    const contract = resolveRoleContractPath(repoDir, ORCHESTRATOR_ROOT, slot) ?? `.herdr/roles/${info.contractFile ?? `${slot}.md`}`;
    const prompt =
      slot === 'verifier'
        ? `역할계약서 ${contract} 를 읽고 검증 요청(.herdr/verify/<fork_id>-brief.md)을 대기하라`
        : `역할계약서 ${contract} 를 읽고 대기/수행하라`;
    const argv = [
      'run', '--bg', '--name', name, '--cwd', repoDir, '--',
      'env', `HERDR_ROLE=${info.herdrRole}`, 'HERDR_DELEGATE_MODE=hc',
      slot === 'lead' ? 'HERDR_DB_WRITE=1' : 'HERDR_READONLY=1',
      ...buildWorkerCommand(roleSpec, { prompt }),
    ];
    commands.push({ label: name, session: name, argv, display: hcRunDisplay(argv), kind: 'hc' });
  }

  // 코딩 워커 예시 (온디맨드 — 동시 최대 2, disjoint Write Scope)
  const coderName = `coder1-${runId}`;
  const wtDir = `.herdr/worktrees/${coderName}`;
  worktreeCommands(commands, repoDir, wtDir, `feat/${coderName}`, coderName, profile.roles.coder ?? { cli: 'devin' });

  // Carbon Gate 온디맨드 템플릿 — advisor 슬롯 스펙 사용
  // (quota-saver: agy 최대 0 — pi 자문 / agy-quad: 최대 3 — roster에서 동적 재계산)
  // 이름은 Gate 1 예시 — 실기동 시 관문 번호로 치환(gate1/gate2/…)해 계약을 유지한다.
  const advisorSpec = profile.roles.advisor ?? { cli: 'pi', onDemand: true };
  const carbonArgv = [
    'run', '--bg', '--name', `carbon-gate1-${runId}`, '--cwd', repoDir, '--',
    'env', 'HERDR_ROLE=carbon', 'HERDR_READONLY=1',
    ...buildWorkerCommand(advisorSpec, { prompt: '관문 N 검토: .herdr/advice/gate<N>-<id>.md 읽고 자문을 출력하라' }),
  ];
  commands.push({
    label: 'carbon on-demand',
    session: `carbon-gate1-${runId}`,
    argv: carbonArgv,
    display: `${hcRunDisplay(carbonArgv)}  → hc wait → hc read → hc kill; hc rm (온디맨드 최대 ${spec.maxOndemandAgy}, gate 번호 치환)`,
    kind: 'note',
  });

  return {
    runId, repoDir, dbPath, eff, spec, commands, warnings,
    rosterSource: loadedRoster.source,
    rosterSourcePath: loadedRoster.sourcePath,
    rosterWarnings: loadedRoster.warnings,
    roleSummary: summarizeRoles(profile.roles),
  };
}

function worktreeCommands(
  commands: OrchCommand[],
  repoDir: string,
  wtDir: string,
  branch: string,
  coderName: string,
  coderSpec: RoleWorkerSpec
): void {
  const wtArgv = ['git', 'worktree', 'add', wtDir, '-b', branch];
  commands.push({
    label: coderName,
    session: null,
    argv: wtArgv,
    display: `${wtArgv.join(' ')}  (코딩 워커 동시 최대 ${MAX_CONCURRENT_CODING})`,
    kind: 'worktree',
  });
  const coderArgv = [
    'run', '--bg', '--name', coderName, '--cwd', path.join(repoDir, wtDir), '--',
    ...buildWorkerCommand(coderSpec, { prompt: '(임무요약. 상세: $BRIEF_PATH)' }),
  ];
  commands.push({ label: coderName, session: coderName, argv: coderArgv, display: hcRunDisplay(coderArgv), kind: 'hc' });
}

// ---------- dry-run 출력 (§6.5) ----------

interface BinaryCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function checkBinaries(): BinaryCheck[] {
  const checks: BinaryCheck[] = [];
  const [major, minor] = process.versions.node!.split('.').map(Number);
  checks.push({
    name: 'node',
    ok: major! > 22 || (major === 22 && minor! >= 6),
    detail: `${process.execPath} (v${process.versions.node}, need >=22.6)`,
  });
  const sqliteCheck = spawnSync(process.execPath, ['-e', "require('node:sqlite'); console.log('ok')"], {
    encoding: 'utf8',
  });
  checks.push({
    name: 'node:sqlite',
    ok: sqliteCheck.status === 0 && sqliteCheck.stdout.trim() === 'ok',
    detail: sqliteCheck.status === 0 ? 'DatabaseSync available' : (sqliteCheck.stderr || 'unavailable').trim(),
  });
  const agyOk = spawnSync('which', ['agy'], { encoding: 'utf8' }).status === 0 || fs.existsSync(AGY_BIN_FALLBACK) || Boolean(process.env.AGY_BIN?.trim());
  checks.push({ name: 'agy', ok: agyOk, detail: agyOk ? AGY_BIN : 'not found' });
  const hcOk = spawnSync('which', ['hc'], { encoding: 'utf8' }).status === 0 || fs.existsSync(HC_BIN_FALLBACK) || Boolean(process.env.HC_BIN?.trim());
  checks.push({ name: 'hc', ok: hcOk, detail: hcOk ? HC_BIN : 'not found' });
  checks.push({ name: 'pi', ok: fs.existsSync(PI_BIN) || spawnSync('which', [PI_BIN], { encoding: 'utf8' }).status === 0, detail: PI_BIN });
  const devinOk = spawnSync('which', ['devin'], { encoding: 'utf8' }).status === 0 || fs.existsSync(DEVIN_BIN_FALLBACK);
  checks.push({ name: 'devin', ok: devinOk, detail: devinOk ? DEVIN_BIN : 'not found' });
  return checks;
}

interface ContractCheck {
  path: string;
  ok: boolean;
  detail: string;
}

function checkContracts(repoDir: string): ContractCheck[] {
  const out: ContractCheck[] = [];
  for (const role of ['lead', 'explore', 'verifier', 'carbon']) {
    const rel = `.herdr/roles/${role}.md`;
    const local = path.join(repoDir, '.herdr', 'roles', `${role}.md`);
    const orch = path.join(ORCHESTRATOR_ROOT, '.herdr', 'roles', `${role}.md`);
    const localOk = fs.existsSync(local);
    const orchOk = fs.existsSync(orch);
    out.push({
      path: rel,
      ok: localOk || orchOk,
      detail: localOk ? 'present' : orchOk ? 'present (orchestrator fallback)' : 'MISSING',
    });
  }
  const hooksPath = path.join(repoDir, '.agents', 'hooks.json');
  let hooksOk = false;
  let hooksDetail = 'MISSING';
  if (fs.existsSync(hooksPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as Record<string, any>;
      const g = cfg['dg-guard']?.PreToolUse?.[0];
      const c = cfg['dg-collect']?.PostToolUse?.[0];
      hooksOk =
        g?.matcher === '*' &&
        g?.hooks?.[0]?.timeout === 3 &&
        g?.hooks?.[0]?.command === 'node hooks/dg-hook.ts --guard' &&
        c?.matcher === '*' &&
        c?.hooks?.[0]?.timeout === 3 &&
        c?.hooks?.[0]?.command === 'node hooks/dg-hook.ts --collect';
      hooksDetail = hooksOk
        ? 'dg-guard(PreToolUse)+dg-collect(PostToolUse), matcher *, timeout 3, node hooks/dg-hook.ts (N-NEW-1)'
        : 'schema/command mismatch';
    } catch (err) {
      hooksDetail = `parse error: ${(err as Error).message}`;
    }
  }
  out.push({ path: '.agents/hooks.json', ok: hooksOk, detail: hooksDetail });
  return out;
}

function dryRunOrchestrate(opts: LaunchOptions): number {
  const plan = buildOrchestratePlan(opts);
  const lines: string[] = [];
  lines.push('[DRY-RUN] herdr orchestrate plan — 실제 모델/프로세스/hc run 기동 0회');
  lines.push(`run_id=${plan.runId}`);
  lines.push(`profile_requested=${plan.eff.requested}`);
  lines.push(`profile=${plan.eff.effective}`);
  lines.push(`effective_profile=${plan.eff.effective}`);
  lines.push(`downgraded=${plan.eff.downgraded}`);
  lines.push(`standing_agy_sessions=${plan.spec.standingAgySessions}`);
  lines.push(`max_ondemand_agy=${plan.spec.maxOndemandAgy}`);
  lines.push(`agy_budget=used:${plan.eff.turnsUsed}/max:${plan.eff.turnBudget} (HERDR_AGY_TURN_BUDGET)`);
  lines.push(`run_id_source=${opts.runId ? '--run-id' : 'generateRunId() 6-hex'}`);
  lines.push(`db=${plan.dbPath}`);
  lines.push(`target_repo=${plan.repoDir}`);
  lines.push(`roster_source=${plan.rosterSource}${plan.rosterSourcePath ? ` (${plan.rosterSourcePath})` : ''}`);
  lines.push(`explore_concurrency<=${MAX_CONCURRENT_EXPLORE} coding_concurrency<=${MAX_CONCURRENT_CODING}`);
  lines.push('');

  lines.push('[roster roles]');
  for (const [slot, summary] of Object.entries(plan.roleSummary)) {
    lines.push(`  ${slot}=${summary}`);
  }
  for (const w of plan.rosterWarnings) lines.push(`  WARNING: ${w}`);

  const bins = checkBinaries();
  lines.push('[binaries]');
  for (const b of bins) {
    lines.push(`  ${b.name}=${b.ok ? 'OK' : 'MISSING'} ${b.detail}`);
  }

  lines.push('');
  lines.push('[rehearsal] dg route 리허설 — 임시 :memory: DB (기본 사용자 DB 오염 0)');
  const rehearsal = planDispatch({ taskKind: 'explore_read', repoDir: plan.repoDir, runId: plan.runId, dryRun: true, taskFile: 'TASK.md', rosterPath: opts.rosterPath });
  lines.push(
    `  explore_read → ${rehearsal.decision} (${rehearsal.route}/${rehearsal.toolClass}) p=${rehearsal.p?.toFixed(3)} (${rehearsal.basis}) fork=${rehearsal.forkId}`
  );
  for (const argv of rehearsal.hcCommands) {
    lines.push(`  hc ${argDisplay(argv)}`);
  }
  const rehearsal2 = planDispatch({ taskKind: 'single_edit', repoDir: plan.repoDir, runId: plan.runId, dryRun: true });
  lines.push(`  single_edit → ${rehearsal2.decision} (requires_write=${rehearsal2.requiresWrite}, risk=${rehearsal2.riskLevel})`);

  const contracts = checkContracts(plan.repoDir);
  lines.push('');
  lines.push('[contracts]');
  for (const c of contracts) {
    lines.push(`  ${c.path} ${c.ok ? 'OK' : 'FAIL'} — ${c.detail}`);
  }

  lines.push('');
  lines.push('[hc ls collision check — N12]');
  const wanted = plan.commands.map((c) => c.session).filter((n): n is string => n !== null && !n.includes('<'));
  const coll = checkHcNameCollisions(wanted);
  if (coll.liveNames.length === 0) {
    lines.push('  hc ls unavailable or no live terminals — collision check skipped (pre-flight will re-check)');
  }
  lines.push(`  wanted: ${wanted.join(', ')}`);
  lines.push(`  collisions: ${coll.collisions.length === 0 ? 'none' : coll.collisions.join(', ')}`);

  lines.push('');
  lines.push('[planned commands]');
  for (const c of plan.commands) {
    lines.push(`  [${c.kind}:${c.label}] ${c.display}`);
  }
  if (opts.showWorkers) {
    lines.push('  [--show-workers] worker panes: 2x2 layout for hc sessions (display only in dry-run)');
  }

  // 검증: 모든 pi 명령에 --no-approve, 모든 세션명 계약 준수
  const cmdStrs = plan.commands.map((c) => c.display);
  const piCmds = cmdStrs.filter((s) => s.includes('/pi ') || s.includes(`${PI_BIN} `));
  const piMissing = piCmds.filter((s) => !s.includes('--no-approve'));
  const allNames = plan.commands.map((c) => c.session).filter((n): n is string => n !== null);
  const validNames = allNames.filter((n) => !n.includes('<'));
  const badNames = validNames.filter((n) => !sessionNameOk(n));
  lines.push('');
  lines.push('[checks]');
  lines.push('  pi commands with --no-approve: ' + (piMissing.length === 0 ? `OK (${piCmds.length}/${piCmds.length})` : `FAIL ${piMissing.join(' | ')}`));
  lines.push(`  session names ^[a-z0-9_-]{1,32}$: ${badNames.length === 0 ? `OK (${validNames.length})` : `FAIL ${badNames.join(', ')}`}`);
  // B2: 읽기전용 세션(HERDR_READONLY=1)의 --tools에 bash가 있으면 격리 위반
  const readonlyBashSessions = plan.commands.filter(
    (c) => c.kind === 'hc' && c.argv.includes('HERDR_READONLY=1') && argvToolsIncludeBash(c.argv)
  );
  lines.push(
    `  readonly sessions without bash (§6.1 Layer 3): ${readonlyBashSessions.length === 0 ? 'OK' : `FAIL ${readonlyBashSessions.map((c) => c.label).join(', ')}`}`
  );
  const missingBins = bins.filter((b) => !b.ok);
  const missingContracts = contracts.filter((c) => !c.ok);
  for (const w of plan.warnings) lines.push(`  WARNING: ${w}`);
  for (const b of missingBins) lines.push(`  WARNING: binary missing — ${b.name}`);
  for (const c of missingContracts) lines.push(`  WARNING: contract fail — ${c.path}`);
  for (const c of readonlyBashSessions) lines.push(`  WARNING: readonly session includes bash — ${c.label}`);
  lines.push('');
  lines.push(
    `DRY-RUN complete — sessions_would_start=${validNames.length}, agy_turns_today=${plan.eff.turnsUsed}, model_calls=0, warnings=${plan.warnings.length + missingBins.length + missingContracts.length + readonlyBashSessions.length}`
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

// ---------- 실기동 (게이트 B — 사용자 승인 후) ----------

function runOrchestrate(opts: LaunchOptions): number {
  const plan = buildOrchestratePlan(opts);
  const wanted = plan.commands.map((c) => c.session).filter((n): n is string => n !== null && !n.includes('<'));
  const coll = checkHcNameCollisions(wanted);
  if (coll.collisions.length > 0) {
    process.stderr.write(`[orchestrate] hc name collisions: ${coll.collisions.join(', ')} — abort\n`);
    return 2;
  }
  for (const w of plan.warnings) process.stderr.write(`[orchestrate] WARNING: ${w}\n`);
  for (const c of plan.commands) {
    if (c.kind === 'hc') {
      const res = spawnSync(HC_BIN, c.argv, { stdio: 'inherit' });
      if (res.status !== 0) {
        process.stderr.write(`[orchestrate] hc ${c.argv.join(' ')} failed (exit ${res.status})\n`);
        return res.status ?? 1;
      }
    } else if (c.kind === 'worktree') {
      const res = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: plan.repoDir, stdio: 'inherit' });
      if (res.status !== 0) {
        process.stderr.write(`[orchestrate] ${c.display} failed (exit ${res.status})\n`);
        return res.status ?? 1;
      }
    } else {
      process.stdout.write(`[skip:${c.kind}] ${c.display}\n`);
    }
  }
  process.stdout.write(`[orchestrate] launched profile=${plan.eff.effective} run_id=${plan.runId}\n`);
  return 0;
}

// ---------- 기존 demo|live|watch 런처 (변경 없음) ----------

function parseArgs(argv: string[]): LaunchOptions {
  const opts: LaunchOptions = {
    mode: 'demo',
    prompt: null,
    folder: process.cwd(),
    tabName: 'Gemini Quad (Argon·Carbon·Neon·Hydrogen)',
    dryRun: false,
    profile: 'quota-saver',
    profileExplicit: false,
    rosterPath: null,
    runId: null,
    showWorkers: false,
    dbPath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--mode': {
        const m = argv[++i];
        if (m === 'demo' || m === 'live' || m === 'watch' || m === 'orchestrate') {
          opts.mode = m;
        }
        break;
      }
      case '--live':
      case '--agy':
        opts.mode = 'live';
        break;
      case '--demo':
        opts.mode = 'demo';
        break;
      case '--watch':
        opts.mode = 'watch';
        break;
      case '--orchestrate':
        opts.mode = 'orchestrate';
        break;
      case '--profile': {
        const p = argv[++i];
        if (p && p.trim()) {
          opts.profile = p.trim();
          opts.profileExplicit = true;
        }
        break;
      }
      case '--roster': {
        const r = argv[++i];
        if (r) opts.rosterPath = r;
        break;
      }
      case '--run-id':
        opts.runId = argv[++i] ?? null;
        break;
      case '--show-workers':
        opts.showWorkers = true;
        break;
      case '--db':
        opts.dbPath = argv[++i] ?? null;
        break;
      case '--prompt':
      case '-p':
        opts.prompt = argv[++i] ?? null;
        if (opts.mode === 'demo') opts.mode = 'live';
        break;
      case '--folder':
      case '--cwd':
      case '--repo': {
        const r = argv[++i];
        if (r) opts.folder = path.resolve(r);
        break;
      }
      case '--name':
      case '--tab':
        opts.tabName = argv[++i] ?? opts.tabName;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Herdr Gemini Quad Orchestrator Launcher
=======================================
Herdr App 창을 자동으로 4분할하여 Argon, Carbon, Neon, Hydrogen 패널을 실행·오케스트레이션합니다.

사용법:
  node ./scripts/herdr-quad-launch.ts [옵션]

옵션:
  --mode <demo|live|watch|orchestrate>   실행 모드 (기본: demo)
  --live                     실제 Antigravity(agy)/Gemini API 연동 모드
  --demo                     40초 멀티 에이전트 시나리오 데모 (기본값)
  --watch                    현재 실행 중인 agy 세션 트랜스크립트 실시간 관제
  --orchestrate              5계층 herdr+hc 워커 체계 실기동 (게이트 B 승인 필요)
  --repo <path>              작업 대상 저장소 (기본: 현재 cwd) — dg/역할 계약서는 오케스트레이터 루트에서 해석
  --roster <path>            역할↔모델 roster.json (우선순위: --roster > HERDR_ROSTER_PATH > <repo>/.herdr/roster.json > ~/.config/herdr-quad/roster.json > 내장)
  --profile <name>           오케스트레이션 프로필 (기본: roster defaultProfile — 내장 quota-saver)
  --run-id <id>              세션 접미 RUN_ID (기본: generateRunId() 6자리 hex)
  --db <path>                결정 DB 경로 (기본: DECISION_ORCHESTRATOR_DB_PATH > GEMINI_TRICK_DB_PATH(레거시) > ~/.local/state/decision-orchestrator/decision.db)
  --show-workers             워커 세션을 2x2 패인으로 표시 (orchestrate)
  --prompt, -p <text>        초기 프롬프트 (지정 시 --live 자동 전환)
  --folder <path>            작업 디렉터리 (--repo 별칭)
  --name <title>             새 탭 이름
  --dry-run                  실행하지 않고 명령어·계획만 출력 후 exit 0
`);
        process.exit(0);
    }
  }
  return opts;
}

function runJson(bin: string, args: string[], dryRun: boolean): any {
  if (dryRun) {
    console.log(`[DRY-RUN] ${bin} ${args.join(' ')}`);
    return { pane: 'p_mock', terminal: 't_mock', focused_pane: 'p_mock' };
  }
  const out = execFileSync(bin, args, { encoding: 'utf8' });
  try {
    return JSON.parse(out);
  } catch {
    return out.trim();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureHerdrRunning(dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const check = spawnSync(HERDR_APP, ['status'], { encoding: 'utf8' });
  if (check.status === 0) return;

  console.log('🚀 Herdr App이 실행 중이지 않아 시작합니다...');
  spawnSync('open', ['-a', 'Herdr'], { encoding: 'utf8' });
  for (let i = 0; i < 15; i++) {
    await sleep(500);
    const retry = spawnSync(HERDR_APP, ['status'], { encoding: 'utf8' });
    if (retry.status === 0) return;
  }
  throw new Error('Herdr App 상태를 확인할 수 없습니다. Herdr가 설치되어 실행 중인지 확인하세요.');
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'orchestrate') {
    const code = opts.dryRun ? dryRunOrchestrate(opts) : runOrchestrate(opts);
    process.exit(code);
  }

  await ensureHerdrRunning(opts.dryRun);

  console.log(`\n📐 Herdr 4분할(Quad) 패널을 생성합니다 (${opts.mode} 모드)...`);

  // 1. 새 탭 생성 (Top-Left: Argon)
  const tabRes = runJson(
    HERDR_APP,
    ['do', 'tab.new', '--name', opts.tabName, '--folder', opts.folder],
    opts.dryRun
  );
  const tTL = tabRes.terminal as string;

  const statusRes = runJson(HERDR_APP, ['status'], opts.dryRun);
  const pTL = (statusRes.focused_pane as string) || 'p_tl';

  // 2. 우측 분할 (Top-Right: Carbon)
  const splitRightRes = runJson(
    HERDR_APP,
    ['do', 'pane.split', '--pane', pTL, '--direction', 'right'],
    opts.dryRun
  );
  const pTR = splitRightRes.pane as string;
  const tTR = splitRightRes.terminal as string;

  // 3. 좌측 하단 분할 (Bottom-Left: Neon)
  const splitLeftDownRes = runJson(
    HERDR_APP,
    ['do', 'pane.split', '--pane', pTL, '--direction', 'down'],
    opts.dryRun
  );
  const pBL = splitLeftDownRes.pane as string;
  const tBL = splitLeftDownRes.terminal as string;

  // 4. 우측 하단 분할 (Bottom-Right: Hydrogen)
  const splitRightDownRes = runJson(
    HERDR_APP,
    ['do', 'pane.split', '--pane', pTR, '--direction', 'down'],
    opts.dryRun
  );
  const pBR = splitRightDownRes.pane as string;
  const tBR = splitRightDownRes.terminal as string;

  // 5. 터미널 라벨 부여
  const labels: Array<[string, string[]]> = [
    [tTL, ['name=Argon', 'role=lead', 'model=gemini-4-argon-high']],
    [tTR, ['name=Carbon', 'role=advisor', 'model=gemini-4-carbon-high']],
    [tBL, ['name=Neon', 'role=verifier', 'model=gemini-4-neon-high']],
    [tBR, ['name=Hydrogen', 'role=swarm', 'model=gemini-4-hydrogen-high']],
  ];
  for (const [term, kv] of labels) {
    if (!opts.dryRun) {
      spawnSync(HC_BIN, ['label', term, ...kv], { encoding: 'utf8' });
    }
  }

  // 6. 각 패널별 실행 명령 조립
  const modeFlag = `--${opts.mode}`;
  const promptArg = opts.prompt ? ` --prompt ${shellEscape(opts.prompt)}` : '';
  const cdPrefix = `cd ${shellEscape(PROJECT_ROOT)} && `;

  const cmdArgon = `${cdPrefix}node ./src/cli.ts --quad --role argon --hub ${modeFlag}${promptArg}`;
  const cmdCarbon = `${cdPrefix}node ./src/cli.ts --quad --role carbon ${modeFlag}`;
  const cmdNeon = `${cdPrefix}node ./src/cli.ts --quad --role neon ${modeFlag}`;
  const cmdHydrogen = `${cdPrefix}node ./src/cli.ts --quad --role hydrogen ${modeFlag}`;

  // 7. Hub(Argon) 먼저 실행 후 클라이언트 패널 실행
  console.log(`  ◈ [Top-Left]     Argon    (${tTL} / ${pTL}) -> Lead Orchestrator`);
  runJson(HC_BIN, ['send', tTL, cmdArgon], opts.dryRun);

  await sleep(350);

  console.log(`  ⬡ [Top-Right]    Carbon   (${tTR} / ${pTR}) -> Strategic Advisor`);
  runJson(HC_BIN, ['send', tTR, cmdCarbon], opts.dryRun);

  console.log(`  ✦ [Bottom-Left]  Neon     (${tBL} / ${pBL}) -> Cross-Verifier`);
  runJson(HC_BIN, ['send', tBL, cmdNeon], opts.dryRun);

  console.log(`  ❖ [Bottom-Right] Hydrogen (${tBR} / ${pBR}) -> Swarm Fleet`);
  runJson(HC_BIN, ['send', tBR, cmdHydrogen], opts.dryRun);

  // 8. Argon 패널로 포커스 복귀
  runJson(HERDR_APP, ['do', 'pane.focus', '--pane', pTL], opts.dryRun);

  console.log(`\n✅ Herdr 4분할 Gemini 오케스트레이션 화면 구성 완료!`);
  console.log(`   - 탭: ${opts.tabName}`);
  console.log(`   - 패널 배치:`);
  console.log(`     ┌──────────────────────┬──────────────────────┐`);
  console.log(`     │ ◈ Argon (Lead)       │ ⬡ Carbon (Advisor)   │`);
  console.log(`     ├──────────────────────┼──────────────────────┤`);
  console.log(`     │ ✦ Neon (Verifier)    │ ❖ Hydrogen (Swarm)   │`);
  console.log(`     └──────────────────────┴──────────────────────┘\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === __filename) {
  main().catch((err) => {
    console.error('❌ 오류:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
