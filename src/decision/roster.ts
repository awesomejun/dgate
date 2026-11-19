/**
 * `src/decision/roster.ts` — 역할↔모델 외부 설정(`roster.json`) 로더·워커 커맨드 어셈블러 (W3.5).
 *
 * 목적: 5개 역할 슬롯(lead·explore·coder·verifier·advisor)의 CLI·모델·권한·쿼터
 * 버킷을 코드 하드코딩에서 분리해, 구독/결제 상황 변화를 설정 파일 교체만으로
 * 반영하게 한다. `scripts/dispatch.ts`·`scripts/herdr-quad-launch.ts`가 함께 사용한다.
 *
 * 외부 연결:
 * - 설정 탐색 우선순위: ① 명시 `rosterPath`(`--roster`) ② `HERDR_ROSTER_PATH`
 *   ③ `<repo>/.herdr/roster.json`(프로젝트 오버라이드) ④ `<XDG_CONFIG_HOME|~/.config>
 *   /herdr-quad/roster.json`(로컬 전체 전역 기본) ⑤ 내장 기본값(quota-saver·agy-quad).
 * - 파일 프로필은 내장 기본 프로필과 **필드 단위 안전 병합**된다(부분 오버라이드 허용,
 *   미지정 슬롯은 내장 기본 상속). 깨진 JSON·스키마 위반은 stderr 경고 후 내장 폴백.
 *
 * 주의:
 * - `tsconfig` `erasableSyntaxOnly` — enum·클래스 파라미터 프로퍼티 금지, type/interface만 사용.
 * - `agy` 커맨드는 프롬프트를 반드시 `-i <prompt>`로 전달한다(`--system-prompt`·
 *   `--print` 미사용 — 기존 세션 계약 유지).
 * - 모든 `pi` 커맨드는 `--no-extensions --no-mcp --no-approve`를 항상 포함한다.
 * - 워커 실행 파일 경로는 하드코딩하지 않는다 — `resolveWorkerBin`이 설정(`bin`)·
 *   환경변수·PATH·포터블 폴백 순으로 기계 독립적으로 해석한다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type RoleSlot = 'lead' | 'explore' | 'coder' | 'verifier' | 'advisor';
export type WorkerCliKind = 'pi' | 'devin' | 'agy' | 'claude' | 'custom';

export const ROLE_SLOTS: readonly RoleSlot[] = ['lead', 'explore', 'coder', 'verifier', 'advisor'];

export interface RoleSlotInfo {
  slot: RoleSlot;
  /** `HERDR_ROLE` env 값 — advisor 슬롯은 기존 carbon 역할 이름을 그대로 쓴다. */
  herdrRole: string;
  /** `.herdr/roles/<file>` 역할 계약서 파일명 (coder는 임무 브리프 기반이므로 null) */
  contractFile: string | null;
}

export const ROLE_SLOT_INFO: Record<RoleSlot, RoleSlotInfo> = {
  lead: { slot: 'lead', herdrRole: 'lead', contractFile: 'lead.md' },
  explore: { slot: 'explore', herdrRole: 'explore', contractFile: 'explore.md' },
  coder: { slot: 'coder', herdrRole: 'coder', contractFile: null },
  verifier: { slot: 'verifier', herdrRole: 'verifier', contractFile: 'verifier.md' },
  advisor: { slot: 'advisor', herdrRole: 'carbon', contractFile: 'carbon.md' },
};

export interface RoleWorkerSpec {
  cli: WorkerCliKind;
  /** 실행 파일 절대경로. 미지정 시 `resolveWorkerBin`이 env·PATH·폴백 순으로 해석. */
  bin?: string;
  /** 예: 'opencodex' (pi 전용) */
  provider?: string;
  /** 예: 'glm-zcode/glm-5.3', 'gemini-4-hydrogen-xhigh' */
  model?: string;
  /** 예: 'max' | 'high' | 'medium' (pi 전용) */
  thinking?: string;
  /** 예: 'auto' | 'plan' | 'dangerous' — devin(claude도 사용), agy는 --mode로 매핑 */
  permissionMode?: string;
  /** true면 읽기전용 도구 제한 자동 적용 (pi: --tools read,grep,find,ls / agy: --mode plan) */
  readonly?: boolean;
  /** true면 상시 대기 세션 없이 필요 시 1회성 기동 (Carbon 관문 등) */
  onDemand?: boolean;
  extraArgs?: string[];
  /** 쿼터 버킷 (예: 'agy', 'devin', 'opencodex'). 미지정 시 cli 종류로 추론. */
  quotaBucket?: string;
}

export interface RosterProfile {
  description?: string;
  /** 일일 턴 예산 초과 시 강등할 프로필 (예: agy-quad → quota-saver) */
  fallbackProfile?: string;
  /** 버킷별 일일 턴 예산 (예: { agy: 20 }) */
  dailyTurnBudgets?: Record<string, number>;
  roles: Record<RoleSlot, RoleWorkerSpec>;
}

export interface RosterConfig {
  defaultProfile: string;
  profiles: Record<string, RosterProfile>;
}

// ---------- 워커 실행 파일 동적 해석 (기계 고유 경로 하드코딩 금지) ----------

/** CLI별 실행 파일 오버라이드 환경변수 (우선순위 순). */
const WORKER_BIN_ENV_KEYS: Partial<Record<WorkerCliKind, readonly string[]>> = {
  pi: ['PI_BIN', 'HERDR_PI_BIN'],
  devin: ['DEVIN_BIN'],
  agy: ['AGY_BIN'],
  claude: ['CLAUDE_BIN'],
};

/** `which` 탐색 결과 캐시 — 프로세스 수명 동안 PATH는 불변이라 가정한다. */
const whichCache = new Map<string, string | null>();

function whichBin(name: string): string | null {
  if (whichCache.has(name)) return whichCache.get(name) ?? null;
  const res = spawnSync('which', [name], { encoding: 'utf8' });
  const found = res.status === 0 && res.stdout.trim() ? res.stdout.trim().split('\n')[0]! : null;
  whichCache.set(name, found);
  return found;
}

/** 포터블 기본 폴백 — 관례적 설치 위치에 실재하면 절대경로, 아니면 PATH에 맡긴다. */
function portableDefaultBin(cli: WorkerCliKind): string {
  if (cli === 'pi') {
    const b = path.join(os.homedir(), '.bun', 'bin', 'pi');
    return fs.existsSync(b) ? b : 'pi';
  }
  if (cli === 'agy') {
    const b = path.join(os.homedir(), '.local', 'bin', 'agy');
    return fs.existsSync(b) ? b : 'agy';
  }
  return cli; // devin·claude
}

/**
 * 워커 CLI 실행 파일 해석 — 우선순위:
 * ① `specBin`(roster.json `bin` 필드) ② 환경변수(`PI_BIN`/`HERDR_PI_BIN`·`DEVIN_BIN`·
 * `AGY_BIN`·`CLAUDE_BIN`) ③ PATH 탐색(`which`) ④ 포터블 기본 폴백(`~/.bun/bin/pi`
 * 등 관례 위치 실재 시 사용, 아니면 명령 이름 그대로).
 * `custom`은 해석 대상이 아니므로 호출자가 `spec.bin ?? 'true'`를 유지한다.
 */
export function resolveWorkerBin(cli: WorkerCliKind, specBin?: string): string {
  if (specBin && specBin.trim()) return specBin;
  for (const key of WORKER_BIN_ENV_KEYS[cli] ?? []) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  const onPath = whichBin(cli);
  if (onPath) return onPath;
  return portableDefaultBin(cli);
}

// ---------- 내장 기본 프로필 (기존 하드코딩 동작의 SSOT) ----------

function builtinQuotaSaver(): RosterProfile {
  return {
    description: '기본 프로필 — agy 상시 0, Lead/Verifier는 pi, Carbon(advisor)은 온디맨드 1회성',
    dailyTurnBudgets: { agy: 20 },
    roles: {
      lead: { cli: 'pi', provider: 'opencodex', model: 'glm-zcode/glm-5.3', thinking: 'max' },
      explore: { cli: 'pi', provider: 'opencodex', model: 'command-code/deepseek-deepseek-v4.1-flash', thinking: 'medium', readonly: true },
      coder: { cli: 'devin', permissionMode: 'auto' },
      verifier: { cli: 'pi', provider: 'opencodex', model: 'command-code/deepseek-deepseek-v4.1-flash', thinking: 'max', readonly: true },
      advisor: { cli: 'agy', model: 'gemini-4-hydrogen-xhigh', readonly: true, onDemand: true },
    },
  };
}

function builtinAgyQuad(): RosterProfile {
  return {
    description: '선택 프로필 — Argon(lead)/Carbon(advisor)/Neon(verifier) agy 3세션 상시',
    fallbackProfile: 'quota-saver',
    dailyTurnBudgets: { agy: 20 },
    roles: {
      lead: { cli: 'agy', model: 'gemini-4-argon-high', permissionMode: 'auto' },
      explore: { cli: 'pi', provider: 'opencodex', model: 'command-code/deepseek-deepseek-v4.1-flash', thinking: 'medium', readonly: true },
      coder: { cli: 'devin', permissionMode: 'auto' },
      verifier: { cli: 'agy', model: 'gemini-4-neon-high', readonly: true },
      advisor: { cli: 'agy', model: 'gemini-4-carbon-high', readonly: true },
    },
  };
}

/** 내장 기본 설정(딥카피 — 호출자 mutation 으로 내부 상태 오염 방지). */
export function builtinRosterConfig(): RosterConfig {
  return {
    defaultProfile: 'quota-saver',
    profiles: {
      'quota-saver': builtinQuotaSaver(),
      'agy-quad': builtinAgyQuad(),
    },
  };
}

// ---------- 로딩·병합 ----------

export type RosterSourceKind = 'flag' | 'env' | 'project' | 'global' | 'builtin';

export interface LoadedRoster {
  config: RosterConfig;
  source: RosterSourceKind;
  sourcePath: string | null;
  /** 비치명 문제(깨진 JSON·스키마 위반·프로필 부재 등) — dry-run 경고로 노출 */
  warnings: string[];
}

/** 전역 기본 roster 경로: `$XDG_CONFIG_HOME/herdr-quad/roster.json` (없으면 `~/.config/...`). */
export function globalRosterPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'herdr-quad', 'roster.json');
}

function mergeSpec(base: RoleWorkerSpec, over: RoleWorkerSpec): RoleWorkerSpec {
  const out: RoleWorkerSpec = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined && value !== null) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function mergeProfile(base: RosterProfile, over: RosterProfile): RosterProfile {
  const roles = { ...base.roles };
  for (const slot of ROLE_SLOTS) {
    const overSpec = over.roles?.[slot];
    if (overSpec) {
      roles[slot] = mergeSpec(roles[slot] ?? { cli: 'custom' }, overSpec);
    }
  }
  return {
    description: Object.hasOwn(over, 'description') ? over.description : base.description,
    fallbackProfile: Object.hasOwn(over, 'fallbackProfile') ? over.fallbackProfile : base.fallbackProfile,
    dailyTurnBudgets: { ...base.dailyTurnBudgets, ...over.dailyTurnBudgets },
    roles,
  };
}

function emptyProfile(): RosterProfile {
  return { roles: { lead: { cli: 'custom' }, explore: { cli: 'custom' }, coder: { cli: 'custom' }, verifier: { cli: 'custom' }, advisor: { cli: 'custom' } } };
}

/**
 * 파일 프로필을 내장 기본 위에 병합: 동일 이름 프로필은 필드 단위 오버라이드,
 * 새 이름 프로필은 내장 `defaultProfile`(quota-saver)을 베이스로 상속한다.
 */
function mergeRosterFile(builtin: RosterConfig, file: Record<string, unknown>, sourcePath: string, warnings: string[]): RosterConfig {
  const merged: Record<string, RosterProfile> = { ...builtin.profiles };
  const inheritBase = builtin.profiles[builtin.defaultProfile] ?? emptyProfile();

  const fileProfiles = (file['profiles'] ?? {}) as Record<string, unknown>;
  if (typeof fileProfiles !== 'object' || fileProfiles === null || Array.isArray(fileProfiles)) {
    throw new Error(`profiles must be an object (got ${Array.isArray(fileProfiles) ? 'array' : typeof fileProfiles})`);
  }
  for (const [name, raw] of Object.entries(fileProfiles)) {
    if (typeof raw !== 'object' || raw === null) {
      warnings.push(`roster profile "${name}" is not an object — skipped (${sourcePath})`);
      continue;
    }
    const over = raw as Partial<RosterProfile>;
    const rolesInput = (over.roles ?? {}) as Record<string, unknown>;
    const roles: Partial<Record<RoleSlot, RoleWorkerSpec>> = {};
    for (const slot of ROLE_SLOTS) {
      const spec = rolesInput[slot];
      if (typeof spec === 'object' && spec !== null) {
        roles[slot] = spec as RoleWorkerSpec;
      }
    }
    if (Object.keys(roles).length === 0) {
      warnings.push(`roster profile "${name}" has no valid role slots — quota-saver defaults inherited (${sourcePath})`);
    }
    merged[name] = mergeProfile(merged[name] ?? inheritBase, { ...over, roles: roles as Record<RoleSlot, RoleWorkerSpec> });
  }

  let defaultProfile = builtin.defaultProfile;
  const fileDefault = file['defaultProfile'];
  if (typeof fileDefault === 'string' && fileDefault.trim()) {
    if (merged[fileDefault]) {
      defaultProfile = fileDefault;
    } else {
      warnings.push(`roster defaultProfile "${fileDefault}" not defined — builtin "${builtin.defaultProfile}" kept (${sourcePath})`);
    }
  }
  return { defaultProfile, profiles: merged };
}

/**
 * roster 설정 로딩(우선순위 탐색 + 내장 병합 + 안전 폴백).
 * - 존재하는 후보가 깨졌으면(파싱·스키마 실패) stderr 경고 후 **내장 기본값으로 즉시 폴백**.
 * - 경로가 지정됐지만 파일이 없으면 경고만 남기고 다음 후보로 진행한다.
 */
export function loadRosterConfig(opts: { rosterPath?: string | null; repoDir?: string | null } = {}): LoadedRoster {
  const warnings: string[] = [];
  const builtin = builtinRosterConfig();
  const candidates: Array<{ kind: RosterSourceKind; p: string | null }> = [
    { kind: 'flag', p: opts.rosterPath?.trim() ? path.resolve(opts.rosterPath.trim()) : null },
    { kind: 'env', p: process.env.HERDR_ROSTER_PATH?.trim() ? path.resolve(process.env.HERDR_ROSTER_PATH.trim()) : null },
    { kind: 'project', p: opts.repoDir ? path.join(opts.repoDir, '.herdr', 'roster.json') : null },
    { kind: 'global', p: globalRosterPath() },
  ];

  for (const cand of candidates) {
    if (!cand.p || !fs.existsSync(cand.p)) {
      if (cand.p && (cand.kind === 'flag' || cand.kind === 'env')) {
        warnings.push(`roster path not found (${cand.kind}): ${cand.p}`);
      }
      continue;
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(cand.p, 'utf8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`root must be an object (got ${Array.isArray(raw) ? 'array' : typeof raw})`);
      }
      const config = mergeRosterFile(builtin, raw as Record<string, unknown>, cand.p, warnings);
      return { config, source: cand.kind, sourcePath: cand.p, warnings };
    } catch (err) {
      const msg = `roster load failed (${cand.kind}: ${cand.p}): ${(err as Error).message} — falling back to builtin defaults`;
      warnings.push(msg);
      process.stderr.write(`[roster] ${msg}\n`);
      return { config: builtin, source: 'builtin', sourcePath: cand.p, warnings };
    }
  }
  return { config: builtin, source: 'builtin', sourcePath: null, warnings };
}

/** 프로필 이름 해석 — 부재 시 defaultProfile → 내장 quota-saver 순으로 폴백. */
export function resolveRosterProfile(config: RosterConfig, name: string): { name: string; profile: RosterProfile; fallbackUsed: boolean } {
  if (config.profiles[name]) return { name, profile: config.profiles[name]!, fallbackUsed: false };
  const def = config.profiles[config.defaultProfile];
  if (def) return { name: config.defaultProfile, profile: def, fallbackUsed: true };
  return { name: 'quota-saver', profile: builtinRosterConfig().profiles['quota-saver']!, fallbackUsed: true };
}

// ---------- 쿼터 버킷 집계 (하드코딩 제거 — 실제 roles에서 동적 계산) ----------

/** 스펙의 실효 쿼터 버킷: 명시 우선, 없으면 cli 종류로 추론(pi→opencodex, custom→미정). */
export function effectiveQuotaBucket(spec: RoleWorkerSpec): string | undefined {
  if (spec.quotaBucket) return spec.quotaBucket;
  if (spec.cli === 'pi') return 'opencodex';
  if (spec.cli === 'custom') return undefined;
  return spec.cli;
}

/** 상시 대기 세션 수 = 버킷 소속 역할 중 `onDemand !== true` 개수. */
export function countStandingSessionsByBucket(profile: RosterProfile, bucket: string): number {
  let n = 0;
  for (const slot of ROLE_SLOTS) {
    const spec = profile.roles[slot];
    if (spec && effectiveQuotaBucket(spec) === bucket && spec.onDemand !== true) n++;
  }
  return n;
}

/** 버킷 최대 동시(온디맨드 포함) 한도 = 버킷 소속 역할 총 개수. */
export function countMaxOndemandByBucket(profile: RosterProfile, bucket: string): number {
  let n = 0;
  for (const slot of ROLE_SLOTS) {
    const spec = profile.roles[slot];
    if (spec && effectiveQuotaBucket(spec) === bucket) n++;
  }
  return n;
}

// ---------- 워커 커맨드 어셈블리 ----------

export interface BuildWorkerCommandOptions {
  prompt: string;
  /** 프롬프트의 `{brief}` 플레이스홀더를 이 경로로 치환한다. */
  roleBriefPath?: string;
  /** true면 초기 프롬프트 없이 대기형 세션으로 기동(기본 false). */
  interactive?: boolean;
}

function effectivePrompt(spec: RoleWorkerSpec, opts: BuildWorkerCommandOptions): string {
  if (opts.interactive === true) return '';
  if (opts.roleBriefPath !== undefined && opts.prompt.includes('{brief}')) {
    return opts.prompt.replaceAll('{brief}', opts.roleBriefPath);
  }
  return opts.prompt;
}

/**
 * 역할 스펙 → 워커 CLI argv.
 * - `pi`: `--no-extensions --no-mcp --no-approve` 항상 포함. `readonly`면
 *   `--tools read,grep,find,ls` 자동 적용(§6.1 Layer 3 — 기본 verifier는 bash
 *   미포함, B2). 사용자 roster가 `extraArgs`로 임의 `--tools`를 지정하면 그 값을
 *   존중하되 `--exclude-tools edit,write`를 자동 붙인다.
 * - `devin`: 기본 `--permission-mode auto`, `--` 뒤에 프롬프트.
 * - `agy`: `--model <m> --mode <plan|auto>` (`readonly`면 plan), 프롬프트는 `-i`로만.
 * - `claude`/`custom`: bin + model + extraArgs + 프롬프트 순서로 조립.
 */
export function buildWorkerCommand(spec: RoleWorkerSpec, opts: BuildWorkerCommandOptions): string[] {
  const prompt = effectivePrompt(spec, opts);
  const extras = spec.extraArgs ?? [];

  if (spec.cli === 'pi') {
    const argv = [resolveWorkerBin('pi', spec.bin)];
    if (spec.provider) argv.push('--provider', spec.provider);
    if (spec.model) argv.push('--model', spec.model);
    if (spec.thinking) argv.push('--thinking', spec.thinking);
    const hasTools = extras.includes('--tools');
    if (spec.readonly && !hasTools) {
      argv.push('--tools', 'read,grep,find,ls');
    }
    argv.push(...extras);
    if (spec.readonly && hasTools && !extras.includes('--exclude-tools')) {
      argv.push('--exclude-tools', 'edit,write');
    }
    argv.push('--no-extensions', '--no-mcp', '--no-approve');
    if (prompt) argv.push(prompt);
    return argv;
  }

  if (spec.cli === 'devin') {
    const argv = [resolveWorkerBin('devin', spec.bin)];
    argv.push('--permission-mode', spec.permissionMode ?? 'auto');
    argv.push(...extras);
    argv.push('--');
    if (prompt) argv.push(prompt);
    return argv;
  }

  if (spec.cli === 'agy') {
    const argv = [resolveWorkerBin('agy', spec.bin)];
    if (spec.model) argv.push('--model', spec.model);
    const mode = spec.readonly ? 'plan' : spec.permissionMode === 'plan' ? 'plan' : 'auto';
    argv.push('--mode', mode, '--dangerously-skip-permissions');
    argv.push(...extras);
    argv.push('-i');
    if (prompt) argv.push(prompt);
    return argv;
  }

  if (spec.cli === 'claude') {
    const argv = [resolveWorkerBin('claude', spec.bin)];
    if (spec.model) argv.push('--model', spec.model);
    if (spec.permissionMode) argv.push('--permission-mode', spec.permissionMode);
    argv.push(...extras);
    if (prompt) argv.push(prompt);
    return argv;
  }

  // custom
  const argv = [spec.bin ?? 'true'];
  if (spec.model) argv.push('--model', spec.model);
  if (spec.permissionMode) argv.push('--permission-mode', spec.permissionMode);
  argv.push(...extras);
  if (prompt) argv.push(prompt);
  return argv;
}

// ---------- 역할 계약서 경로 해석 (--repo 일반화) ----------

/**
 * 역할 계약서 경로: `<repo>/.herdr/roles/<file>` 우선, 없으면 오케스트레이터 루트
 * 기본 `.herdr/roles/<file>`로 폴백. repo 로컬이면 상대경로 표기(기존 출력 호환),
 * 폴백이면 오케스트레이터 절대경로를 반환한다.
 */
export function resolveRoleContractPath(repoDir: string, orchestratorRoot: string, slot: RoleSlot): string | null {
  const info = ROLE_SLOT_INFO[slot];
  if (!info.contractFile) return null;
  const local = path.join(repoDir, '.herdr', 'roles', info.contractFile);
  if (fs.existsSync(local)) return `.herdr/roles/${info.contractFile}`;
  const orch = path.join(orchestratorRoot, '.herdr', 'roles', info.contractFile);
  if (fs.existsSync(orch)) return orch;
  return `.herdr/roles/${info.contractFile}`;
}
