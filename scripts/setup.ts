#!/usr/bin/env node
/**
 * `scripts/setup.ts` — 환경 감지 대화형 온보딩 위저드 & 읽기전용 진단 도구 (brief-setup-wizard·setup-v2).
 *
 * 목적: 첫 사용자 머신(macOS/Linux)의 런타임·코딩 CLI·에이전트 스킬 디렉터리·선택
 * 도구를 자동 감지해, 실제 설치 조합에 맞는 roster 프로필을 결정적으로 추천한다.
 * v2 추가: 설치 CLI의 로컬 설정·카탈로그에서 사용 가능 모델을 발견(0 네트워크/토큰)해
 * 역할별 적합 가이드와 함께 보여주고, 대화형 피커로 역할별 CLI·모델을 직접 고를 수 있다.
 * 대화형(TTY)일 때만 opt-in 확인 후 맞춤 `roster.json` 생성·`dgate`
 * 스킬 심볼릭 링크·타깃 프로젝트 훅 설치를 수행하고, 비TTY에서는 절대 행하지 않고
 * 진단 요약으로 폴백한다(CI에서 행 금지).
 * v3 추가: 동반 스킬(mistology·neverstuck·todo-flow·effort-router)을 설치 여부·
 * 현재 환경(CLI·git·cargo·추천 모드)과 비교해 개별 verdict로 추천(`companionAdvice`)하고,
 * 위저드에서 cargo 자동 설치·로컬 폴더/Git URL 검증·심볼릭 링크 연결을 대행한다.
 * v4 추가: 동반 스킬·본 저장소의 검증된 공식 GitHub 주소(repoSlug·repoUrl)를 노출하고,
 * 스킬 설치·연결 직후와 위저드 마지막에 opt-in GitHub 스타 응원을 제안한다
 * (`starGithubRepo` — `y/yes` 명시 동의 시에만 `gh api` argv 실행, 실패 시 조용히 폴백).
 *
 * 외부 연결:
 * - `node ./scripts/setup.ts`                  대화형 위저드 (비TTY → 진단 요약 폴백)
 * - `node ./scripts/setup.ts --check`          읽기전용 진단 리포트 (0 writes/0 prompts)
 * - `node ./scripts/setup.ts --check --json`   기계판독 JSON 진단 (에이전트 퍼스트런 검사용)
 * - `node ./scripts/setup.ts --repo <dir>`     훅 설치 대상 프로젝트 지정
 * - 생성 `roster.json`은 `src/decision/roster.ts` `loadRosterConfig` 병합 규약을 따른다
 *   (빈 문자열 필드는 내장 quota-saver 기본 상속을 차단하기 위한 의도적 오버라이드).
 * - 훅 설치 = canonical `.agents/hooks.json` 복사 + `hooks/dg-hook.ts` 심볼릭 링크
 *   (symlink라 import가 오케스트레이터 `src/`로 해석됨) + `.git/info/exclude` 추가.
 *
 * 주의:
 * - 외부 npm 의존성 0, Node >=22.6 네이티브 TS. `erasableSyntaxOnly` — enum 금지.
 * - `GEMINI_DECISION_API_KEY`는 존재 여부만 보고 — 값은 절대 읽거나 출력하지 않는다.
 * - `agy`는 감지되지만 쿼터 한도로 어떤 추천에도 자동 선택되지 않는다(`agy: 0` 고정).
 * - 모든 헬퍼는 `deps`/`env`/`homeDir` 주입 가능 — 테스트가 실제 `$HOME`을 건드리지 않는다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type {
  RoleSlot,
  RoleWorkerSpec,
  RosterConfig,
  RosterProfile,
} from '../src/decision/roster.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROLE_SLOT_LIST: readonly RoleSlot[] = ['lead', 'explore', 'coder', 'verifier', 'advisor'];

export const CLI_IDS = ['claude', 'codex', 'devin', 'pi', 'gemini', 'agy', 'hc', 'cargo'] as const;
export type CliId = (typeof CLI_IDS)[number];
/** 멀티CLI 워커로 인정되는 CLI — agy·hc·cargo는 워커 슬롯에 자동 배정되지 않는다. */
export const WORKER_CLI_IDS = ['claude', 'codex', 'devin', 'pi', 'gemini'] as const;

export const COMPANION_IDS = [
  'mistology',
  'todo-flow',
  'effort-router',
  'neverstuck',
  'hc',
  'gemini-decision-api-key',
] as const;
export type CompanionId = (typeof COMPANION_IDS)[number];

/** PATH 미검출 시 추가로 찾는 관례적 설치 위치 (homeDir 기준 상대경로 — 기계 독립). */
const HOME_FALLBACK_BIN_DIRS = ['.local/bin', '.bun/bin', '.cargo/bin'] as const;
const DEFAULT_SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] as const;

export const AGENT_SKILL_DIRS = [
  { id: 'claude', dir: '.claude' },
  { id: 'gemini', dir: '.gemini' },
  { id: 'codex', dir: '.codex' },
  { id: 'agents', dir: '.agents' },
  { id: 'pi', dir: '.pi/agent' },
  { id: 'cursor', dir: '.cursor' },
] as const;

/** todo-flow·effort-router·neverstuck 스킬을 찾는 에이전트 부모 디렉터리. */
const SKILL_COMPANION_DIRS = ['.agents', '.gemini', '.claude', '.codex'] as const;
/** mistology 스킬을 찾는 에이전트 부모 디렉터리 (brief §2.5 — .agents/.gemini만). */
const MISTOLOGY_SKILL_DIRS = ['.agents', '.gemini'] as const;

const MISTOLOGY_INSTALL_CMD =
  'cargo install --git https://github.com/chldbwnstm/mistology --locked && mistology setup';
const MISTOLOGY_GUIDE_URL = 'https://github.com/chldbwnstm/mistology';
const DECISION_API_KEY_ENV = 'GEMINI_DECISION_API_KEY';

/** 본 저장소의 검증된 공식 GitHub 주소 (안내·opt-in 스타 전용). */
export const SELF_REPO_SLUG = 'insightflo/dgate';
export const SELF_REPO_URL = `https://github.com/${SELF_REPO_SLUG}`;

/** 동반 스킬별 검증된 공식 GitHub 저장소 — 가짜·미검증 URL 발명 금지. */
const COMPANION_REPOS: Record<CompanionSkillId, { repoSlug: string; repoUrl: string }> = {
  mistology: {
    repoSlug: 'chldbwnstm/mistology',
    repoUrl: 'https://github.com/chldbwnstm/mistology',
  },
  neverstuck: {
    repoSlug: 'chldbwnstm/NeverStuck',
    repoUrl: 'https://github.com/chldbwnstm/NeverStuck',
  },
  'todo-flow': {
    repoSlug: 'JakeB-5/todo-flow',
    repoUrl: 'https://github.com/JakeB-5/todo-flow',
  },
  'effort-router': {
    repoSlug: 'acc0mplish/Effort-Router',
    repoUrl: 'https://github.com/acc0mplish/Effort-Router',
  },
};

// ---------- 타입 ----------

export interface CliDetection {
  installed: boolean;
  path: string | null;
}

export interface AgentDirStatus {
  id: string;
  dir: string;
  exists: boolean;
  /** `<dir>/skills/dgate/SKILL.md` 링크 여부 */
  skillLinked: boolean;
}

export interface CompanionStatus {
  id: CompanionId;
  installed: boolean;
  required: false;
  /** 1-line Korean role description */
  role: string;
  /** 감지된 경로 또는 '미설치' */
  detail: string;
  installHint: string | null;
  guideUrl: string | null;
}

export type CompanionSkillId = 'mistology' | 'neverstuck' | 'todo-flow' | 'effort-router';

export type CompanionVerdict = 'already_installed' | 'recommended' | 'optional' | 'skip_overlap';

/** 동반 스킬 1개의 환경 비교 판정 — 무조건 전부 권하지 않고 실제 환경과 비교한다. */
export interface CompanionAdvice {
  id: CompanionSkillId;
  name: string;
  verdict: CompanionVerdict;
  /** 이 사용자 환경과 비교한 1줄 한국어 이유 */
  reason: string;
  /** 설치 후 1줄 한국어 사용법 */
  howToUse: string;
  /** 위저드가 지금 자동 설치를 실행할 수 있는지 (mistology+cargo만 true) */
  canAutoInstall: boolean;
  /** 실제 검증된 설치 명령 — 없으면 null (가짜 URL 발명 금지) */
  installCommand: string | null;
  /** 수동 설치 한국어 안내 */
  installGuide: string;
  /** 검증된 공식 GitHub 저장소 `owner/repo` (opt-in 스타·안내 전용) */
  repoSlug: string;
  /** 검증된 공식 GitHub 저장소 URL */
  repoUrl: string;
}

export interface SecretsStatus {
  envSet: boolean;
  secretsFileExists: boolean;
  configured: boolean;
  path: string;
}

export interface DbStatus {
  path: string;
  exists: boolean;
  source: 'DGATE_DB_PATH' | 'DECISION_ORCHESTRATOR_DB_PATH' | 'GEMINI_TRICK_DB_PATH' | 'default';
}

export interface RosterFileStatus {
  path: string;
  exists: boolean;
  validJson: boolean;
}

export interface RepoHooksStatus {
  repoDir: string;
  repoDirExists: boolean;
  hooksJson: boolean;
  hookSymlink: boolean;
  excluded: boolean;
}

export type SetupMode = 'standalone' | 'multi-cli';

export interface RosterRecommendation {
  mode: SetupMode;
  profileName: string | null;
  /** 표시용 역할→CLI 라벨 맵 */
  roles: Record<RoleSlot, string>;
  reason: string;
  /** 추천 agy 일일 턴 예산 — 항상 0 (agy는 사용자 명시 선택 시에만) */
  agy: number;
}

/** 로컬 설정·카탈로그에서 발견된 사용 가능 모델 (100% 로컬 — 네트워크·토큰 비용 0). */
export interface DiscoveredModel {
  cli: 'pi' | 'claude' | 'codex' | 'devin' | 'gemini';
  provider?: string;
  model: string;
  source: 'local_config' | 'catalog';
  tier: 'fast' | 'balanced' | 'strong' | 'coding_agent';
  tierLabel: string;
}

export interface EnvironmentReport {
  ok: boolean;
  node: { version: string; major: number; minor: number; ok: boolean };
  nodeSqlite: { ok: boolean };
  git: CliDetection;
  clis: Record<CliId, CliDetection>;
  agents: AgentDirStatus[];
  roster: RosterFileStatus;
  db: DbStatus;
  secrets: SecretsStatus;
  companions: Record<CompanionId, CompanionStatus>;
  recommendation: RosterRecommendation;
  discoveredModels: DiscoveredModel[];
  /** 동반 스킬 4종 환경 비교 추천 (`--check --json`에도 포함) */
  companionAdvice: CompanionAdvice[];
  repoHooks: RepoHooksStatus | null;
  /** Claude Code 내장 Explore 서브에이전트 경량 오버라이드 (`~/.claude/agents/Explore.md`) 상태 */
  claudeExploreOverride: { installed: boolean; path: string };
}

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** 지정 시 PATH 대신 이 디렉터리 목록으로 바이너리를 찾는다 (테스트 주입용). */
  pathDirs?: string[];
  /** 시스템 관례 bin 디렉터리 (기본: homebrew/usr/local/usr/bin/bin). */
  systemDirs?: string[];
  nodeVersion?: string;
  nodeSqliteOk?: boolean;
  /** `--repo` 대상 — 지정 시 hooks 설치 상태를 함께 진단한다. */
  repoDir?: string | null;
  orchestratorRoot?: string;
}

// ---------- 파일시스템·환경 유틸 ----------

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `which`와 동일한 의미론 — 검색 디렉터리를 순서대로 훑어 첫 실행 가능 파일을 반환. */
export function findOnPath(name: string, searchDirs: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const cand = path.join(dir, name);
    if (isExecutableFile(cand)) return cand;
  }
  return null;
}

function detectBin(name: string, searchDirs: readonly string[]): CliDetection {
  const found = findOnPath(name, searchDirs);
  return { installed: found !== null, path: found };
}

function splitPathList(v: string | undefined): string[] {
  return (v ?? '').split(':').filter((s) => s.trim().length > 0);
}

function parseNodeVersion(v: string): { version: string; major: number; minor: number; ok: boolean } {
  const m = /^v?(\d+)\.(\d+)/.exec(v.trim());
  const major = m ? Number.parseInt(m[1]!, 10) : 0;
  const minor = m ? Number.parseInt(m[2]!, 10) : 0;
  return { version: v, major, minor, ok: major > 22 || (major === 22 && minor >= 6) };
}

function probeNodeSqlite(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: unknown };
    return typeof mod.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

function skillFileIn(homeDir: string, skill: string, parents: readonly string[]): string | null {
  for (const parent of parents) {
    const p = path.join(homeDir, parent, 'skills', skill, 'SKILL.md');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** JSON 파일을 읽어 객체로 반환 — 부재·깨짐·비객체는 null. */
function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    const j: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof j === 'object' && j !== null && !Array.isArray(j)
      ? (j as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------- Step 1: 환경 자동 감지 ----------

export function detectEnvironment(deps: DetectDeps = {}): EnvironmentReport {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const orchRoot = deps.orchestratorRoot ?? REPO_ROOT;
  const pathDirs = deps.pathDirs ?? splitPathList(env.PATH);
  const systemDirs = deps.systemDirs ?? DEFAULT_SYSTEM_BIN_DIRS;
  const searchDirs = [
    ...pathDirs,
    ...HOME_FALLBACK_BIN_DIRS.map((d) => path.join(homeDir, d)),
    ...systemDirs,
  ];

  const node = parseNodeVersion(deps.nodeVersion ?? process.version);
  const nodeSqlite = { ok: deps.nodeSqliteOk ?? probeNodeSqlite() };
  const git = detectBin('git', searchDirs);

  const clis = {} as Record<CliId, CliDetection>;
  for (const id of CLI_IDS) clis[id] = detectBin(id, searchDirs);

  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, '.config');
  const xdgState = env.XDG_STATE_HOME?.trim() || path.join(homeDir, '.local', 'state');

  const agents: AgentDirStatus[] = AGENT_SKILL_DIRS.map((a) => {
    const dir = path.join(homeDir, a.dir);
    return {
      id: a.id,
      dir,
      exists: fs.existsSync(dir),
      skillLinked: fs.existsSync(path.join(dir, 'skills', 'dgate', 'SKILL.md')),
    };
  });

  const rosterPath = path.join(xdgConfig, 'herdr-quad', 'roster.json');
  let rosterValidJson = false;
  if (fs.existsSync(rosterPath)) {
    try {
      JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
      rosterValidJson = true;
    } catch {
      rosterValidJson = false;
    }
  }

  const dgateDb = env.DGATE_DB_PATH?.trim();
  const envDb = env.DECISION_ORCHESTRATOR_DB_PATH?.trim();
  const legacyDb = env.GEMINI_TRICK_DB_PATH?.trim();
  const db: DbStatus = dgateDb
    ? { path: dgateDb, exists: fs.existsSync(dgateDb), source: 'DGATE_DB_PATH' }
    : envDb
      ? { path: envDb, exists: fs.existsSync(envDb), source: 'DECISION_ORCHESTRATOR_DB_PATH' }
      : legacyDb
        ? { path: legacyDb, exists: fs.existsSync(legacyDb), source: 'GEMINI_TRICK_DB_PATH' }
        : {
            path: path.join(xdgState, 'dgate', 'decision.db'),
            exists: fs.existsSync(path.join(xdgState, 'dgate', 'decision.db')),
            source: 'default',
          };

  const secretsPath = path.join(xdgConfig, 'herdr-quad', 'secrets.env');
  const envSet = Boolean(env[DECISION_API_KEY_ENV]?.trim());
  const secretsFileExists = fs.existsSync(secretsPath);
  const secrets: SecretsStatus = {
    envSet,
    secretsFileExists,
    configured: envSet || secretsFileExists,
    path: secretsPath,
  };

  const mistologyBin = findOnPath('mistology', searchDirs);
  const mistologySkill = skillFileIn(homeDir, 'mistology', MISTOLOGY_SKILL_DIRS);
  const companions = {} as Record<CompanionId, CompanionStatus>;
  companions['mistology'] = {
    id: 'mistology',
    installed: mistologyBin !== null || mistologySkill !== null,
    required: false,
    role: '저장소별 과거 코드 실수·2-hop 연관 모듈 브리핑 (Rust CLI + 스킬)',
    detail: mistologyBin ?? mistologySkill ?? '미설치',
    installHint: MISTOLOGY_INSTALL_CMD,
    guideUrl: MISTOLOGY_GUIDE_URL,
  };

  const skillCompanions: Array<{ id: CompanionId; skill: string; role: string; hint: string }> = [
    {
      id: 'todo-flow',
      skill: 'todo',
      role: '요구사항 조사·할 일 트랙·완료조건(Acceptance) 문서 관리 스킬',
      hint: '각 에이전트의 skills/todo/ 에 todo 스킬 폴더를 배치하거나 심볼릭 링크',
    },
    {
      id: 'effort-router',
      skill: 'effort-router',
      role: '작업 티어(S/M/L/XL) 판정 및 단일 세션 단계·증거번들 계획 스킬',
      hint: '각 에이전트의 skills/effort-router/ 에 스킬 폴더를 배치하거나 심볼릭 링크',
    },
    {
      id: 'neverstuck',
      skill: 'neverstuck',
      role: '같은 오류 3회+ 반복 시 원인 진단·프롬프트 재설계 탈출 스킬',
      hint: '각 에이전트의 skills/neverstuck/ 에 스킬 폴더를 배치하거나 심볼릭 링크',
    },
  ];
  for (const c of skillCompanions) {
    const found = skillFileIn(homeDir, c.skill, SKILL_COMPANION_DIRS);
    companions[c.id] = {
      id: c.id,
      installed: found !== null,
      required: false,
      role: c.role,
      detail: found ?? '미설치',
      installHint: c.hint,
      guideUrl: null,
    };
  }
  companions['hc'] = {
    id: 'hc',
    installed: clis.hc.installed,
    required: false,
    role: '여러 코딩 CLI 워커를 백그라운드 터미널로 병렬 배차·제어하는 런처',
    detail: clis.hc.path ?? '미설치',
    installHint: 'Herdr 런처(hc) 설치 — 배포 문서의 설치 절차를 따른 뒤 `hc run`/`hc send`로 워커 배차',
    guideUrl: null,
  };
  companions['gemini-decision-api-key'] = {
    id: 'gemini-decision-api-key',
    installed: secrets.configured,
    required: false,
    role: '선택적 `gemini-decision-1` Shadow/On 확률 보정 API (미설정 시 로컬 무료 통계로 동작)',
    detail: envSet
      ? '환경변수 설정됨'
      : secretsFileExists
        ? 'secrets.env 존재'
        : '미설정 (기본 off — 완전 무료 로컬 통계)',
    installHint: `~/.config/herdr-quad/secrets.env 에 ${DECISION_API_KEY_ENV} 저장 후 chmod 600`,
    guideUrl: null,
  };

  const recommendation = recommendRosterProfile(clis);
  const discoveredModels = discoverAvailableModels(homeDir, clis);
  const companionAdvice = recommendCompanionTools({ clis, git, companions, recommendation });
  const repoHooks = deps.repoDir ? inspectRepoHooks(deps.repoDir, orchRoot) : null;
  const claudeExplorePath = path.join(homeDir, '.claude', 'agents', 'Explore.md');
  const claudeExploreOverride = {
    installed: fs.existsSync(claudeExplorePath),
    path: claudeExplorePath,
  };

  return {
    ok: node.ok && nodeSqlite.ok && git.installed,
    node,
    nodeSqlite,
    git,
    clis,
    agents,
    roster: { path: rosterPath, exists: fs.existsSync(rosterPath), validJson: rosterValidJson },
    db,
    secrets,
    companions,
    recommendation,
    discoveredModels,
    companionAdvice,
    repoHooks,
    claudeExploreOverride,
  };
}

// ---------- Step 2: 맞춤 roster 추천·생성 ----------

const STANDALONE_REASON =
  '단독 모드 — 추가 CLI 없이 `dg route`/`dg wrap`/`dg stats`/`dg report` + TUI 바로 사용';

/**
 * mergeSpec은 `undefined`/`null`만 스킵하므로, 파일 프로필이 내장 quota-saver 위에
 * 병합될 때 pi 전용 필드(model·provider·thinking·quotaBucket)가 비-pi 스펙으로 새어
 * 나가는 것을 빈 문자열 오버라이드로 차단한다.
 */
function blockInherit<T extends RoleWorkerSpec>(spec: T): T {
  const out = { ...spec } as Record<string, unknown>;
  for (const k of ['model', 'provider', 'thinking']) {
    if (out[k] === undefined) out[k] = '';
  }
  return out as T;
}

function specPiLead(): RoleWorkerSpec {
  return { cli: 'pi', provider: 'opencodex', model: 'glm-zcode/glm-5.3', thinking: 'max', pricing: { relativeCost: 5.0 } };
}
function specPiExplore(): RoleWorkerSpec {
  return { cli: 'pi', provider: 'opencodex', model: 'command-code/deepseek-deepseek-v4.1-flash', thinking: 'medium', readonly: true, pricing: { relativeCost: 1.0 } };
}
function specPiVerifier(): RoleWorkerSpec {
  return { cli: 'pi', provider: 'opencodex', model: 'command-code/deepseek-deepseek-v4.1-flash', thinking: 'max', readonly: true, pricing: { relativeCost: 1.5 } };
}
function specPiCoder(): RoleWorkerSpec {
  return { cli: 'pi', provider: 'opencodex', model: 'glm-zcode/glm-5.3', thinking: 'high', pricing: { relativeCost: 3.0 } };
}
function specPiAdvisor(): RoleWorkerSpec {
  return { cli: 'pi', provider: 'opencodex', model: 'glm-zcode/glm-5.3', thinking: 'high', readonly: true, onDemand: true, quotaBucket: 'pi' };
}
function specClaude(role: 'lead' | 'coder' | 'ro' | 'advisor'): RoleWorkerSpec {
  const base: RoleWorkerSpec = { cli: 'claude', permissionMode: 'auto', quotaBucket: 'claude' };
  if (role === 'lead') return blockInherit({ ...base, pricing: { relativeCost: 5.0 } });
  if (role === 'coder') return blockInherit({ ...base, pricing: { relativeCost: 3.0 } });
  if (role === 'ro') return blockInherit({ ...base, readonly: true, pricing: { relativeCost: 1.5 } });
  return blockInherit({ ...base, readonly: true, onDemand: true, pricing: { relativeCost: 8.0 } });
}
function specDevin(role: 'coder' | 'ro' | 'advisor' | 'lead'): RoleWorkerSpec {
  const base: RoleWorkerSpec = { cli: 'devin', permissionMode: 'auto', quotaBucket: 'devin' };
  if (role === 'lead') return blockInherit({ ...base, pricing: { relativeCost: 5.0 } });
  if (role === 'coder') return blockInherit({ ...base, pricing: { relativeCost: 3.0 } });
  if (role === 'ro') return blockInherit({ ...base, readonly: true, pricing: { relativeCost: 1.5 } });
  return blockInherit({ ...base, readonly: true, onDemand: true, pricing: { relativeCost: 8.0 } });
}
/** codex·gemini 등 WorkerCliKind에 없는 CLI — roster 규약상 `custom` + 명시 bin. */
function specCustomCli(bin: string, role: 'lead' | 'coder' | 'ro' | 'advisor'): RoleWorkerSpec {
  const base: RoleWorkerSpec = { cli: 'custom', bin, quotaBucket: bin };
  if (role === 'lead') return blockInherit({ ...base, pricing: { relativeCost: 5.0 } });
  if (role === 'coder') return blockInherit({ ...base, pricing: { relativeCost: 3.0 } });
  if (role === 'ro') return blockInherit({ ...base, readonly: true, pricing: { relativeCost: 1.5 } });
  return blockInherit({ ...base, readonly: true, onDemand: true, pricing: { relativeCost: 8.0 } });
}

function allSlots(make: (role: 'lead' | 'coder' | 'ro' | 'advisor') => RoleWorkerSpec): Record<RoleSlot, RoleWorkerSpec> {
  return {
    lead: make('lead'),
    explore: make('ro'),
    coder: make('coder'),
    verifier: make('ro'),
    advisor: make('advisor'),
  };
}

const PROFILE_BUILDERS: Record<string, { reason: string; build: () => RosterProfile }> = {
  'zero-agy': {
    reason: 'hc + pi + devin 감지 — Lead/Advisor pi, Explore/Verifier pi(readonly), Coder devin (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (zero-agy): Lead·Advisor pi / Explore·Verifier pi readonly / Coder devin, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: { lead: specPiLead(), explore: specPiExplore(), coder: specDevin('coder'), verifier: specPiVerifier(), advisor: specPiAdvisor() },
    }),
  },
  'claude-codex': {
    reason: 'hc + claude + codex 감지 — Lead/Verifier claude, Coder/Explore codex (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (claude-codex): Lead·Verifier·Advisor claude / Coder·Explore codex, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: {
        lead: specClaude('lead'),
        explore: specCustomCli('codex', 'ro'),
        coder: specCustomCli('codex', 'coder'),
        verifier: specClaude('ro'),
        advisor: specClaude('advisor'),
      },
    }),
  },
  'claude-only': {
    reason: 'hc + claude 감지 — 모든 역할 claude (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (claude-only): 모든 역할 claude, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: allSlots((r) => specClaude(r)),
    }),
  },
  'codex-only': {
    reason: 'hc + codex 감지 — 모든 역할 codex (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (codex-only): 모든 역할 codex, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: allSlots((r) => specCustomCli('codex', r)),
    }),
  },
  'devin-only': {
    reason: 'hc + devin 감지 — 모든 역할 devin (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (devin-only): 모든 역할 devin, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: allSlots((r) => specDevin(r)),
    }),
  },
  'pi-only': {
    reason: 'hc + pi 감지 — 모든 역할 pi (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (pi-only): 모든 역할 pi, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: { lead: specPiLead(), explore: specPiExplore(), coder: specPiCoder(), verifier: specPiVerifier(), advisor: specPiAdvisor() },
    }),
  },
  'gemini-only': {
    reason: 'hc + gemini 감지 — 모든 역할 gemini (agy: 0)',
    build: () => ({
      description: '설치 CLI 맞춤 (gemini-only): 모든 역할 gemini, agy=0',
      dailyTurnBudgets: { agy: 0 },
      roles: allSlots((r) => specCustomCli('gemini', r)),
    }),
  },
};

export const TAILORED_PROFILE_NAMES = Object.keys(PROFILE_BUILDERS);

function specLabel(spec: RoleWorkerSpec): string {
  const base = spec.cli === 'custom' ? (spec.bin ?? 'custom') : spec.cli;
  const tags = [spec.readonly ? 'readonly' : '', spec.onDemand ? 'onDemand' : ''].filter(Boolean);
  return tags.length ? `${base} (${tags.join('·')})` : base;
}

/**
 * 감지된 CLI 조합으로 최적 설정을 결정적으로 추천한다.
 * 규칙: ① `agy`는 절대 자동 선택되지 않는다 ② 미설치 CLI는 절대 추천되지 않는다
 * ③ `hc` 부재 또는 워커 CLI 0개 → standalone.
 */
export function recommendRosterProfile(
  clis: Partial<Record<CliId, CliDetection>>
): RosterRecommendation {
  const has = (id: CliId): boolean => clis[id]?.installed === true;
  const workerCount = WORKER_CLI_IDS.filter((id) => has(id)).length;

  if (!has('hc') || workerCount === 0) {
    const roles = {} as Record<RoleSlot, string>;
    for (const slot of ROLE_SLOT_LIST) roles[slot] = '—';
    return { mode: 'standalone', profileName: null, roles, reason: STANDALONE_REASON, agy: 0 };
  }

  const profileName =
    has('pi') && has('devin')
      ? 'zero-agy'
      : has('claude') && has('codex')
        ? 'claude-codex'
        : has('claude')
          ? 'claude-only'
          : has('codex')
            ? 'codex-only'
            : has('devin')
              ? 'devin-only'
              : has('pi')
                ? 'pi-only'
                : 'gemini-only';

  const profile = PROFILE_BUILDERS[profileName]!.build();
  const roles = {} as Record<RoleSlot, string>;
  for (const slot of ROLE_SLOT_LIST) roles[slot] = specLabel(profile.roles[slot]);
  return {
    mode: 'multi-cli',
    profileName,
    roles,
    reason: PROFILE_BUILDERS[profileName]!.reason,
    agy: 0,
  };
}

/** 추천(또는 프로필 이름)으로 `loadRosterConfig` 호환 RosterConfig를 만든다. */
export function buildTailoredRosterConfig(
  rec: RosterRecommendation | string
): RosterConfig | null {
  const name = typeof rec === 'string' ? rec : rec.profileName;
  const builder = name ? PROFILE_BUILDERS[name] : undefined;
  if (!name || !builder) return null;
  return { defaultProfile: name, profiles: { [name]: builder.build() } };
}

// ---------- Step 2c: 동반 스킬 환경 비교 추천 (companion advisor) ----------

const COMPANION_HOW_TO_USE: Record<CompanionSkillId, string> = {
  mistology:
    '작업 착수 전에 "과거 실수·연관 모듈 확인해줘"라고 하면 저장소별 브리핑을 자동 조회하고, 완료 전 결합 파급도 점검합니다.',
  neverstuck:
    '같은 오류가 3회 이상 반복될 때 "neverstuck으로 탈출해줘"라고 하면 원인 진단·프롬프트 재설계로 막힘 루프를 끊습니다.',
  'todo-flow':
    '중대형 작업 전에 "할 일 트랙으로 잡아줘"라고 하면 요구사항·완료 조건을 문서로 먼저 고정해 방향 이탈을 막습니다.',
  'effort-router':
    '작업을 맡길 때 "작업 크기 판정해줘"라고 하면 S/M/L/XL 티어와 단계별 모델·추론 강도 계획을 세워줍니다.',
};

const MISTOLOGY_MANUAL_GUIDE = `Rust(rustup)를 먼저 설치한 뒤 다음을 실행하세요: ${MISTOLOGY_INSTALL_CMD} — 또는 ${MISTOLOGY_GUIDE_URL} 에서 릴리스 다운로드`;

function skillFolderGuide(skill: string, contents: string, repoUrl: string): string {
  return `${skill} 스킬 폴더(${contents} 포함)를 감지된 에이전트 스킬 디렉터리(~/.claude/skills, ~/.agents/skills 등)에 배치하거나 심볼릭 링크하세요. 위저드의 동반 스킬 단계에서 로컬 폴더 경로나 Git URL(${repoUrl})을 입력하면 검증 후 자동 연결됩니다.`;
}

/**
 * 동반 스킬 4종을 실제 감지 환경과 비교해 개별 verdict로 추천한다.
 * 절대 "전부 설치"를 권하지 않는다 — 설치됨/환경 유리/선택/중복 생략을 구분한다.
 */
export function recommendCompanionTools(
  report: Pick<EnvironmentReport, 'clis' | 'git' | 'companions' | 'recommendation'>
): CompanionAdvice[] {
  const cliInstalled = (id: CliId): boolean => report.clis[id]?.installed === true;
  /** 코딩 에이전트 CLI 수 — hc(런처)·cargo(빌드)는 코딩 CLI로 세지 않는다. */
  const codingCliCount = [...WORKER_CLI_IDS, 'agy' as const].filter(cliInstalled).length;
  const multiCli = report.recommendation.mode === 'multi-cli';
  const installed = (id: CompanionId): boolean => report.companions[id]?.installed === true;
  const out: CompanionAdvice[] = [];

  // 1) mistology — Git 기반 저장소에서 체감 효과 최대, cargo가 있으면 자동 설치 가능
  if (installed('mistology')) {
    out.push({
      id: 'mistology',
      name: 'mistology',
      verdict: 'already_installed',
      reason: '이미 설치됨 — 작업 전 과거 코드 실수·연관 모듈을 자동 브리핑합니다.',
      howToUse: COMPANION_HOW_TO_USE.mistology,
      canAutoInstall: false,
      installCommand: null,
      installGuide: '',
      ...COMPANION_REPOS.mistology,
    });
  } else if (report.git.installed) {
    const cargo = cliInstalled('cargo');
    out.push({
      id: 'mistology',
      name: 'mistology',
      verdict: 'recommended',
      reason: 'Git 기반 코드 작업 환경에서 반복 실수와 연관 모듈 깨짐을 줄이는 체감 효과가 가장 큽니다.',
      howToUse: COMPANION_HOW_TO_USE.mistology,
      canAutoInstall: cargo,
      installCommand: cargo ? MISTOLOGY_INSTALL_CMD : null,
      installGuide: cargo
        ? `다음 명령으로 설치합니다: ${MISTOLOGY_INSTALL_CMD} — 가이드: ${MISTOLOGY_GUIDE_URL}`
        : MISTOLOGY_MANUAL_GUIDE,
      ...COMPANION_REPOS.mistology,
    });
  } else {
    out.push({
      id: 'mistology',
      name: 'mistology',
      verdict: 'optional',
      reason: 'Git이 감지되지 않아 저장소 연관 추적 효과가 제한적입니다 — Git 기반 작업을 시작하면 도입하세요.',
      howToUse: COMPANION_HOW_TO_USE.mistology,
      canAutoInstall: false,
      installCommand: null,
      installGuide: MISTOLOGY_MANUAL_GUIDE,
      ...COMPANION_REPOS.mistology,
    });
  }

  // 2) neverstuck — 코딩 에이전트가 있는 환경에서 막힘 루프 차단
  const neverstuckGuide = skillFolderGuide('neverstuck', 'SKILL.md·PROTOCOL.md', COMPANION_REPOS.neverstuck.repoUrl);
  if (installed('neverstuck')) {
    out.push({
      id: 'neverstuck',
      name: 'neverstuck',
      verdict: 'already_installed',
      reason: '이미 설치됨 — 같은 오류 반복 시 막힘 탈출 프로토콜이 적용됩니다.',
      howToUse: COMPANION_HOW_TO_USE.neverstuck,
      canAutoInstall: false,
      installCommand: null,
      installGuide: '',
      ...COMPANION_REPOS.neverstuck,
    });
  } else {
    out.push({
      id: 'neverstuck',
      name: 'neverstuck',
      verdict: codingCliCount >= 1 ? 'recommended' : 'optional',
      reason:
        codingCliCount >= 1
          ? '코딩 에이전트가 같은 오류를 3회 이상 반복할 때 프롬프트를 재설계해 막힘 루프를 끊어줍니다.'
          : '설치된 코딩 CLI가 없어 아직 필요 없습니다 — 코딩 에이전트 사용을 시작하면 도입하세요.',
      howToUse: COMPANION_HOW_TO_USE.neverstuck,
      canAutoInstall: false,
      installCommand: null,
      installGuide: neverstuckGuide,
      ...COMPANION_REPOS.neverstuck,
    });
  }

  // 3) todo-flow — 멀티 워커·중대형 작업 전 요구사항 문서화
  const todoGuide = skillFolderGuide('todo', 'SKILL.md', COMPANION_REPOS['todo-flow'].repoUrl);
  if (installed('todo-flow')) {
    out.push({
      id: 'todo-flow',
      name: 'todo-flow',
      verdict: 'already_installed',
      reason: '이미 설치됨 — 할 일 트랙 문서로 요구사항·완료 조건을 관리합니다.',
      howToUse: COMPANION_HOW_TO_USE['todo-flow'],
      canAutoInstall: false,
      installCommand: null,
      installGuide: '',
      ...COMPANION_REPOS['todo-flow'],
    });
  } else {
    const useful = multiCli || codingCliCount >= 2;
    out.push({
      id: 'todo-flow',
      name: 'todo-flow',
      verdict: useful ? 'recommended' : 'optional',
      reason: useful
        ? '멀티 워커·중대형 기능 개발 전에 요구사항과 완료 조건을 문서로 먼저 고정해 방향 이탈을 막아줍니다.'
        : '단독 소규모 작업이면 생략 가능하며, 프로젝트가 커질 때 도입하면 좋습니다.',
      howToUse: COMPANION_HOW_TO_USE['todo-flow'],
      canAutoInstall: false,
      installCommand: null,
      installGuide: todoGuide,
      ...COMPANION_REPOS['todo-flow'],
    });
  }

  // 4) effort-router — 단일 세션 중심 환경에서 작업 크기·추론 강도 체계화
  const effortGuide = skillFolderGuide('effort-router', 'SKILL.md', COMPANION_REPOS['effort-router'].repoUrl);
  if (installed('effort-router')) {
    out.push({
      id: 'effort-router',
      name: 'effort-router',
      verdict: 'already_installed',
      reason: '이미 설치됨 — 작업 크기별 모델·추론 강도를 체계화합니다.',
      howToUse: COMPANION_HOW_TO_USE['effort-router'],
      canAutoInstall: false,
      installCommand: null,
      installGuide: '',
      ...COMPANION_REPOS['effort-router'],
    });
  } else if (multiCli) {
    out.push({
      id: 'effort-router',
      name: 'effort-router',
      verdict: 'optional',
      reason: '이미 `dgate` 멀티워커 배차가 가능하므로, 단일 세션 단계 계획·증거번들이 추가로 필요할 때만 선택하세요 (중복 라우팅 주의).',
      howToUse: COMPANION_HOW_TO_USE['effort-router'],
      canAutoInstall: false,
      installCommand: null,
      installGuide: effortGuide,
      ...COMPANION_REPOS['effort-router'],
    });
  } else if (codingCliCount >= 1) {
    out.push({
      id: 'effort-router',
      name: 'effort-router',
      verdict: 'recommended',
      reason: '단일 채팅 세션 중심 환경이라 작업 크기(S/M/L/XL)별 모델·추론 강도를 체계화하는 데 유리합니다.',
      howToUse: COMPANION_HOW_TO_USE['effort-router'],
      canAutoInstall: false,
      installCommand: null,
      installGuide: effortGuide,
      ...COMPANION_REPOS['effort-router'],
    });
  } else {
    out.push({
      id: 'effort-router',
      name: 'effort-router',
      verdict: 'skip_overlap',
      reason: '설치된 코딩 CLI가 없어 현재 활용할 세션이 없습니다 — 코딩 CLI 설치 후 다시 확인하세요.',
      howToUse: COMPANION_HOW_TO_USE['effort-router'],
      canAutoInstall: false,
      installCommand: null,
      installGuide: effortGuide,
      ...COMPANION_REPOS['effort-router'],
    });
  }

  return out;
}

// ---------- Step 2b: 로컬 모델 발견·역할 적합 가이드 (setup v2) ----------
//
// 100% 로컬 파일만 읽는다 — 네트워크 I/O·토큰 비용 0.
// SECURITY: `apiKey`/`key`/`token`/`secret`/`env`/`webhook` 계열 필드는
// 절대 읽지·복사하지·출력하지 않는다 — providers[*].models·toml의 `model =`
// 라인·settings.json 최상위 `model` 문자열만 추출한다.

const TIER_LABELS: Record<DiscoveredModel['tier'], string> = {
  fast: '빠름·저비용',
  balanced: '균형',
  strong: '고성능·추론',
  coding_agent: '코딩 에이전트',
};

/**
 * 모델명 휴리스틱으로 비용·성능 티어를 분류한다 (devin은 항상 코딩 에이전트).
 * fast 키워드는 `/ - _ .`·숫자·문자열 경계로 구분된 토큰일 때만 매칭한다 —
 * 'gemini-2.5-pro'의 'gemini' 안 'mini' 오탐을 막는다.
 */
export function classifyModelTier(
  cli: string,
  model: string
): { tier: DiscoveredModel['tier']; tierLabel: string } {
  const tier: DiscoveredModel['tier'] =
    cli === 'devin'
      ? 'coding_agent'
      : /(?:^|[\/\-_.0-9])(?:flash|mini|haiku|small|lite|nano|exaone)(?:[\/\-_.0-9]|$)/i.test(model)
        ? 'fast'
        : /opus|pro|max|glm-5|gpt-6|o3|r1|reasoning|high/i.test(model)
          ? 'strong'
          : 'balanced';
  return { tier, tierLabel: TIER_LABELS[tier] };
}

/**
 * 설치된 CLI의 로컬 설정·내장 카탈로그에서 사용 가능 모델을 수집한다.
 * - pi: `~/.pi/agent/models.json`의 `providers[*].models` (문자열·`{id}` 항목)
 * - codex: `~/.codex/config.toml`의 `model = "..."` 라인, 없으면 카탈로그
 * - claude: `~/.claude/settings.json` 최상위 `model` + 표준 카탈로그 3종
 * - devin·gemini: 카탈로그 항목
 * - `agy`는 어떤 경우에도 자동 포함하지 않는다 (zero-agy 기본 보존).
 */
export function discoverAvailableModels(
  homeDir: string,
  clis: Record<string, CliDetection>
): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  const push = (
    cli: DiscoveredModel['cli'],
    model: string,
    source: DiscoveredModel['source'],
    provider?: string
  ): void => {
    const key = `${cli} ${provider ?? ''} ${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { tier, tierLabel } = classifyModelTier(cli, model);
    out.push(provider ? { cli, provider, model, source, tier, tierLabel } : { cli, model, source, tier, tierLabel });
  };

  if (clis.pi?.installed) {
    const providers = readJsonSafe(path.join(homeDir, '.pi', 'agent', 'models.json'))?.providers;
    if (typeof providers === 'object' && providers !== null && !Array.isArray(providers)) {
      for (const [providerName, provObj] of Object.entries(providers as Record<string, unknown>)) {
        // apiKey·baseUrl 등 다른 키는 절대 열지 않는다 — models 배열만 추출.
        const models = (provObj as { models?: unknown }).models;
        if (!Array.isArray(models)) continue;
        for (const m of models) {
          const id =
            typeof m === 'string'
              ? m
              : typeof (m as { id?: unknown } | null)?.id === 'string'
                ? (m as { id: string }).id
                : null;
          if (id) push('pi', id, 'local_config', providerName);
        }
      }
    }
  }

  if (clis.codex?.installed) {
    let found = 0;
    try {
      const text = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
      for (const line of text.split('\n')) {
        const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
        if (m) {
          push('codex', m[1]!, 'local_config');
          found++;
        }
      }
    } catch {
      // config.toml 부재 — 카탈로그 폴백으로 진행
    }
    if (found === 0) push('codex', 'gpt-5-codex', 'catalog');
  }

  if (clis.claude?.installed) {
    const j = readJsonSafe(path.join(homeDir, '.claude', 'settings.json'));
    if (typeof j?.model === 'string' && j.model.trim()) push('claude', j.model, 'local_config');
    for (const cat of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']) {
      push('claude', cat, 'catalog');
    }
  }

  if (clis.devin?.installed) push('devin', 'default', 'catalog');

  if (clis.gemini?.installed) {
    push('gemini', 'gemini-2.5-flash', 'catalog');
    push('gemini', 'gemini-2.5-pro', 'catalog');
  }

  return out;
}

/** 역할 슬롯별 적합 모델 가이드 — 피커에서 티어 힌트로 노출. */
export const ROLE_FIT_GUIDES: Record<RoleSlot, { label: string; recommendedTier: string; summary: string }> = {
  lead: {
    label: '리드',
    recommendedTier: '고성능·추론 또는 균형',
    summary: '계획·작업 분해·최종 통합 — 고성능·추론 또는 균형 모델 권장',
  },
  explore: {
    label: '탐색',
    recommendedTier: '빠름·저비용',
    summary: '읽기전용 코드 탐색 — 빠름·저비용 모델 권장',
  },
  coder: {
    label: '코더',
    recommendedTier: '코딩 에이전트 또는 강한 코딩 CLI',
    summary: '파일 수정·테스트 반복 — 코딩 에이전트(devin) 또는 강한 코딩 CLI 권장',
  },
  verifier: {
    label: '검증',
    recommendedTier: '리드·코더와 다른 모델 계열',
    summary: '독립 교차검증(읽기전용) — 리드·코더와 다른 모델 계열 권장',
  },
  advisor: {
    label: '자문',
    recommendedTier: '고성능·추론',
    summary: '고난도 설계·막힘 해결(온디맨드) — 고성능·추론 모델 권장',
  },
};

const MODEL_FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|sonnet|opus|haiku|anthropic/i, 'claude'],
  [/glm|chatglm|zhipu/i, 'glm'],
  [/deepseek/i, 'deepseek'],
  [/exaone/i, 'exaone'],
  [/gpt|codex|openai|o[0-9]/i, 'gpt'],
  [/gemini/i, 'gemini'],
  [/qwen|qwq/i, 'qwen'],
  [/llama/i, 'llama'],
  [/mistral|mixtral/i, 'mistral'],
  [/devin/i, 'devin'],
];

/**
 * 역할 스펙의 모델 계열을 정규화한다 — `spec.model`을 우선 보고, 없으면
 * `spec.cli`(custom은 `bin`)로 추정한다. 어느 쪽에도 힌트가 없으면 cli 자체를 반환.
 */
export function extractModelFamily(spec: RoleWorkerSpec | undefined): string | null {
  if (!spec) return null;
  const identity = spec.cli === 'custom' ? (spec.bin ?? '') : spec.cli;
  for (const hay of [spec.model ?? '', identity]) {
    if (!hay) continue;
    for (const [re, family] of MODEL_FAMILY_PATTERNS) {
      if (re.test(hay)) return family;
    }
  }
  const fallback = identity.trim().toLowerCase();
  return fallback ? fallback : null;
}

/**
 * 독립 교차검증 다양성 점검 — verifier가 lead·coder와 정확히 같은 모델 계열이면
 * 비차단 한국어 경고를 반환한다 (사용자 선택을 절대 막지 않는다).
 */
export function checkCrossVerificationDiversity(
  roles: Partial<Record<RoleSlot, RoleWorkerSpec>>
): string[] {
  const warnings: string[] = [];
  const verifier = extractModelFamily(roles.verifier);
  if (!verifier) return warnings;
  const lead = extractModelFamily(roles.lead);
  const coder = extractModelFamily(roles.coder);
  if (lead && lead === verifier) {
    warnings.push(`⚠ 리드와 검증이 같은 모델 계열(${verifier})입니다. 독립 교차검증을 위해 다른 계열을 권장합니다.`);
  }
  if (coder && coder === verifier) {
    warnings.push(`⚠ 코더와 검증이 같은 모델 계열(${verifier})입니다. 독립 교차검증을 위해 다른 계열을 권장합니다.`);
  }
  return warnings;
}

/**
 * 피커에서 고른 `DiscoveredModel`을 역할 슬롯용 `RoleWorkerSpec`으로 변환한다.
 * - explore·verifier·advisor는 readonly, advisor는 onDemand.
 * - codex·gemini는 `WorkerCliKind`에 없으므로 `custom` + 명시 `bin`.
 * - 비-pi 스펙은 `blockInherit`으로 pi 전용 필드(provider·thinking·model) 상속을
 *   차단해 `mergeSpec` 병합 시 quota-saver pi 값이 새지 않게 한다.
 */
export function modelChoiceToRoleSpec(choice: DiscoveredModel, slot: RoleSlot): RoleWorkerSpec {
  const flags: Pick<RoleWorkerSpec, 'readonly' | 'onDemand'> = {};
  if (slot === 'explore' || slot === 'verifier' || slot === 'advisor') flags.readonly = true;
  if (slot === 'advisor') flags.onDemand = true;

  if (choice.cli === 'pi') {
    return blockInherit({
      cli: 'pi',
      provider: choice.provider ?? '',
      model: choice.model,
      thinking: slot === 'explore' ? 'low' : 'medium',
      permissionMode: '',
      ...flags,
    });
  }
  if (choice.cli === 'claude') {
    return blockInherit({
      cli: 'claude',
      model: choice.model,
      permissionMode: slot === 'verifier' || slot === 'advisor' ? 'plan' : 'auto',
      quotaBucket: 'claude',
      ...flags,
    });
  }
  if (choice.cli === 'devin') {
    return blockInherit({
      cli: 'devin',
      permissionMode: 'auto',
      quotaBucket: 'devin',
      ...flags,
    });
  }
  // codex·gemini — custom + 명시 bin, pi 전용 필드 상속 차단
  return blockInherit({
    cli: 'custom',
    bin: choice.cli,
    model: choice.model,
    permissionMode: '',
    quotaBucket: choice.cli,
    ...flags,
  });
}

// ---------- 설치 헬퍼 (opt-in, 멱등) ----------

export interface SkillLinkResult {
  linked: string[];
  skipped: Array<{ dir: string; reason: string }>;
}

/**
 * `<agent>/skills/dgate` → `<repoDir>/skills/dgate`
 * 심볼릭 링크 생성. 존재하는 에이전트 디렉터리에만 만들고, 기존 경로는 절대 덮어쓰지 않는다.
 */
export function installSkillLinks(opts: {
  homeDir?: string;
  repoDir?: string;
  onlyAgentIds?: readonly string[];
} = {}): SkillLinkResult {
  const homeDir = opts.homeDir ?? os.homedir();
  const repoDir = opts.repoDir ?? REPO_ROOT;
  const source = path.join(repoDir, 'skills', 'dgate');
  const res: SkillLinkResult = { linked: [], skipped: [] };

  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    for (const a of AGENT_SKILL_DIRS) {
      res.skipped.push({ dir: path.join(homeDir, a.dir), reason: 'source-skill-missing' });
    }
    return res;
  }

  for (const a of AGENT_SKILL_DIRS) {
    if (opts.onlyAgentIds && !opts.onlyAgentIds.includes(a.id)) continue;
    const agentDir = path.join(homeDir, a.dir);
    if (!fs.existsSync(agentDir)) {
      res.skipped.push({ dir: agentDir, reason: 'agent-dir-absent' });
      continue;
    }
    const skillsDir = path.join(agentDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const target = path.join(skillsDir, 'dgate');
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(target);
    } catch {
      lst = null;
    }
    if (lst) {
      const already =
        lst.isSymbolicLink() && fs.readlinkSync(target) === source;
      res.skipped.push({ dir: agentDir, reason: already ? 'already-linked' : 'conflict-existing-path' });
      continue;
    }
    fs.symlinkSync(source, target, 'dir');
    res.linked.push(agentDir);
  }
  return res;
}

export interface ExternalSkillLinkResult {
  /** 소스 검증 통과 여부 — false면 어떤 타깃도 건드리지 않는다 */
  ok: boolean;
  /** ok=false일 때 한국어 거부 사유 */
  error: string | null;
  /** 심볼릭 링크를 만든 스킬 디렉터리 */
  linked: string[];
  skipped: Array<{ dir: string; reason: string }>;
}

/**
 * 외부 스킬 폴더(neverstuck·todo·effort-router 등)를 감지된 에이전트 스킬
 * 디렉터리에 심볼릭 링크로 연결한다.
 * - `sourceDir`에 `SKILL.md`가 있어야 한다 — 없으면 ok:false로 깔끔 거부.
 * - `skillName`은 경로 구분자·상위 경로를 허용하지 않는다 (디렉터리 탈출 방지).
 * - 기존 경로는 절대 덮어쓰지 않고, 같은 소스 링크는 멱등으로 건너뛴다.
 * - URL의 임의 쉘 스크립트는 절대 실행하지 않는다 (git clone은 위저드에서만 opt-in).
 */
export function installExternalSkillFromLocalPath(
  sourceDir: string,
  skillName: string,
  targetSkillDirs: readonly string[]
): ExternalSkillLinkResult {
  const res: ExternalSkillLinkResult = { ok: false, error: null, linked: [], skipped: [] };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillName)) {
    res.error = `잘못된 스킬 이름 "${skillName}" — 영문·숫자·._- 만 허용되며 경로 구분자는 안 됩니다.`;
    return res;
  }
  const src = path.resolve(sourceDir);
  let st: fs.Stats;
  try {
    st = fs.statSync(src);
  } catch {
    res.error = `경로가 존재하지 않습니다: ${src}`;
    return res;
  }
  if (!st.isDirectory()) {
    res.error = `디렉터리가 아닙니다: ${src}`;
    return res;
  }
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    res.error = `SKILL.md가 없습니다: ${src} — 스킬 폴더(SKILL.md 포함)를 지정하세요.`;
    return res;
  }
  res.ok = true;
  for (const dir of targetSkillDirs) {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, skillName);
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(target);
    } catch {
      lst = null;
    }
    if (lst) {
      const already = lst.isSymbolicLink() && fs.readlinkSync(target) === src;
      res.skipped.push({ dir, reason: already ? 'already-linked' : 'conflict-existing-path' });
      continue;
    }
    fs.symlinkSync(src, target, 'dir');
    res.linked.push(dir);
  }
  return res;
}

export interface RepoHooksResult {
  repoDir: string;
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
}

function inspectRepoHooks(repoDir: string, orchestratorRoot: string): RepoHooksStatus {
  const agentsDir = path.join(repoDir, '.agents');
  const hookLink = path.join(agentsDir, 'hooks', 'dg-hook.ts');
  const srcHook = path.join(orchestratorRoot, '.agents', 'hooks', 'dg-hook.ts');
  let hookSymlink = false;
  try {
    const st = fs.lstatSync(hookLink);
    hookSymlink = st.isSymbolicLink() && fs.readlinkSync(hookLink) === srcHook;
  } catch {
    hookSymlink = false;
  }
  let excluded = false;
  const excludePath = path.join(repoDir, '.git', 'info', 'exclude');
  if (fs.existsSync(excludePath)) {
    const lines = fs
      .readFileSync(excludePath, 'utf8')
      .split('\n')
      .map((l) => l.trim());
    excluded = lines.includes('.agents/hooks.json') && lines.includes('.agents/hooks/');
  }
  return {
    repoDir,
    repoDirExists: fs.existsSync(repoDir),
    hooksJson: fs.existsSync(path.join(agentsDir, 'hooks.json')),
    hookSymlink,
    excluded,
  };
}

const GIT_EXCLUDE_ENTRIES = ['.agents/hooks.json', '.agents/hooks/'] as const;

/**
 * 타깃 프로젝트에 `.agents/hooks.json`(canonical 복사) + `hooks/dg-hook.ts`
 * (오케스트레이터 심볼릭 링크)를 설치하고 `.git/info/exclude`에 두 경로를 추가해
 * `git status`를 깨끗하게 유지한다. 기존 파일·다른 내용은 절대 덮어쓰지 않는다.
 */
export function installRepoHooks(opts: {
  repoDir: string;
  orchestratorRoot?: string;
}): RepoHooksResult {
  const repoDir = opts.repoDir;
  const orch = opts.orchestratorRoot ?? REPO_ROOT;
  const res: RepoHooksResult = { repoDir, written: [], skipped: [] };
  const srcJson = path.join(orch, '.agents', 'hooks.json');
  const srcHook = path.join(orch, '.agents', 'hooks', 'dg-hook.ts');
  if (!fs.existsSync(srcJson) || !fs.existsSync(srcHook)) {
    res.skipped.push({ path: repoDir, reason: 'orchestrator-hook-source-missing' });
    return res;
  }

  const agentsDir = path.join(repoDir, '.agents');
  const hooksDir = path.join(agentsDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const dstJson = path.join(agentsDir, 'hooks.json');
  const canonical = fs.readFileSync(srcJson, 'utf8');
  if (!fs.existsSync(dstJson)) {
    fs.writeFileSync(dstJson, canonical);
    res.written.push(dstJson);
  } else if (fs.readFileSync(dstJson, 'utf8') === canonical) {
    res.skipped.push({ path: dstJson, reason: 'already-present' });
  } else {
    res.skipped.push({ path: dstJson, reason: 'conflict-different-content' });
  }

  const dstHook = path.join(hooksDir, 'dg-hook.ts');
  let lst: fs.Stats | null = null;
  try {
    lst = fs.lstatSync(dstHook);
  } catch {
    lst = null;
  }
  if (!lst) {
    fs.symlinkSync(srcHook, dstHook);
    res.written.push(dstHook);
  } else if (lst.isSymbolicLink() && fs.readlinkSync(dstHook) === srcHook) {
    res.skipped.push({ path: dstHook, reason: 'already-linked' });
  } else {
    res.skipped.push({ path: dstHook, reason: 'conflict-existing-path' });
  }

  const gitDir = path.join(repoDir, '.git');
  const excludePath = path.join(gitDir, 'info', 'exclude');
  if (!fs.existsSync(gitDir)) {
    res.skipped.push({ path: excludePath, reason: 'not-a-git-repo' });
    return res;
  }
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const lines = existing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const missing = GIT_EXCLUDE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) {
    res.skipped.push({ path: excludePath, reason: 'already-excluded' });
  } else {
    const base = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
    fs.writeFileSync(excludePath, `${base}${missing.join('\n')}\n`);
    res.written.push(excludePath);
  }
  return res;
}

// ---------- dgate 계약 블록 설치 (AGENTS.md 관리 블록) ----------

/** `installContractsBlock` 결과 — changed=false면 쓰기가 없었다. */
export interface ContractsBlockResult {
  repoDir: string;
  changed: boolean;
  reason?:
    | 'created' // AGENTS.md 없음 → 블록만 넣어 생성
    | 'appended' // 마커 없는 기존 파일 → 끝에 추가
    | 'updated' // 기존 관리 블록을 소스 블록으로 교체
    | 'already-current' // 이미 동일 — 쓰기 없음
    | 'repo-dir-missing'
    | 'block-source-missing'
    | 'write-failed';
}

/** AGENTS.md에서 dgate 관리 블록 범위 — begin 마커부터 첫 end 마커까지(비탐욕). */
const CONTRACTS_BLOCK_RE = /<!-- dgate:begin[\s\S]*?<!-- dgate:end -->/;

/** AGENTS.md 내용에 계약 블록을 적용한다 — 변화 없으면 null. */
function applyContractsBlock(prev: string, block: string): string | null {
  if (CONTRACTS_BLOCK_RE.test(prev)) {
    // 함수형 치환자 — 블록 내 `$`(예: `$HC_TERMINAL_ID`)가 특수 패턴으로 해석되지 않게 한다.
    const next = prev.replace(CONTRACTS_BLOCK_RE, () => block);
    return next === prev ? null : next;
  }
  // 마커 없음 — 끝 개행을 정규화해 빈 줄 하나 두고 추가한다(빈 파일이면 블록만).
  const base = prev.replace(/\n+$/, '');
  return base === '' ? block : `${base}\n\n${block}`;
}

/**
 * 대상 레포 AGENTS.md에 dgate 계약 블록(`skills/dgate/AGENTS-BLOCK.md`)을 멱등 설치·갱신한다.
 * 파일이 없으면 블록만 넣어 생성하고, 관리 마커가 있으면 해당 범위를 교체, 없으면 끝에 추가한다.
 * 이미 동일하면 changed=false(쓰기 없음). 소스·대상 부재는 조용히 스킵한다.
 */
export function installContractsBlock(opts: {
  repoDir: string;
  orchestratorRoot?: string;
}): ContractsBlockResult {
  const repoDir = opts.repoDir;
  const orch = opts.orchestratorRoot ?? REPO_ROOT;
  if (!fs.existsSync(repoDir)) {
    return { repoDir, changed: false, reason: 'repo-dir-missing' };
  }
  let block: string;
  try {
    block = fs
      .readFileSync(path.join(orch, 'skills', 'dgate', 'AGENTS-BLOCK.md'), 'utf8')
      .replace(/\n+$/, '');
  } catch {
    return { repoDir, changed: false, reason: 'block-source-missing' };
  }
  const agentsMd = path.join(repoDir, 'AGENTS.md');
  const prev = fs.existsSync(agentsMd) ? fs.readFileSync(agentsMd, 'utf8') : null;
  const next = prev === null ? `${block}\n` : applyContractsBlock(prev, block);
  if (next === null || next === prev) {
    return { repoDir, changed: false, reason: 'already-current' };
  }
  try {
    fs.writeFileSync(agentsMd, next);
  } catch {
    return { repoDir, changed: false, reason: 'write-failed' };
  }
  const reason: ContractsBlockResult['reason'] =
    prev === null ? 'created' : CONTRACTS_BLOCK_RE.test(prev) ? 'updated' : 'appended';
  return { repoDir, changed: true, reason };
}

// ---------- GitHub 스타 (opt-in 전용) ----------

export interface StarRepoResult {
  ok: boolean;
  repoSlug: string;
  /** 실패·거부 시에도 항상 제공되는 수동 안내 URL */
  fallbackUrl: string;
  reason?: string;
}

/**
 * `gh api -X PUT user/starred/<owner>/<repo>`로 저장소에 스타를 등록한다.
 * 사용자의 명시적 동의가 있을 때만 호출되어야 하며(호출 측 책임), 절대 throw하지 않고
 * gh 부재(ENOENT)·비정상 종료·비공개 저장소 404는 깔끔한 폴백 URL로 되돌린다.
 * argv 배열로만 실행한다 — 쉘 문자열 결합·쉘 실행은 절대 금지.
 */
export function starGithubRepo(
  repoSlug: string,
  deps: { exec?: typeof spawnSync } = {}
): StarRepoResult {
  const fallbackUrl = `https://github.com/${repoSlug}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoSlug)) {
    return { ok: false, repoSlug, fallbackUrl, reason: 'invalid-repo-slug' };
  }
  const exec = deps.exec ?? spawnSync;
  let res: { status: number | null; error?: Error | undefined; stdout?: string; stderr?: string };
  try {
    res = exec('gh', ['api', '-X', 'PUT', `user/starred/${repoSlug}`], { encoding: 'utf8' });
  } catch (err) {
    return { ok: false, repoSlug, fallbackUrl, reason: `gh-spawn-threw:${(err as Error).message}` };
  }
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      repoSlug,
      fallbackUrl,
      reason: code === 'ENOENT' ? 'gh-not-installed' : `gh-spawn-error:${code ?? res.error.message}`,
    };
  }
  if (res.status !== 0) {
    const errText = `${res.stderr ?? ''} ${res.stdout ?? ''}`;
    return {
      ok: false,
      repoSlug,
      fallbackUrl,
      reason: /404|not found/i.test(errText)
        ? 'repo-not-found-or-private'
        : `gh-exit-${res.status ?? 'null'}`,
    };
  }
  return { ok: true, repoSlug, fallbackUrl };
}

/**
 * Claude Code 내장 `Explore` 서브에이전트 4줄 오버라이드 템플릿.
 * 같은 이름(`Explore`)으로 `.claude/agents/Explore.md`를 두면 내장 Explore의
 * 읽기전용 검색(Read/Grep/Glob)이 Opus 대신 Haiku(effort: low)로 실행되어
 * 탐색 토큰 비용을 절감한다.
 */
export const CLAUDE_EXPLORE_OVERRIDE_MD = [
  '---',
  'name: Explore',
  'model: haiku',
  'effort: low',
  'tools: Read, Grep, Glob',
  '---',
  '',
].join('\n');

export function installClaudeExploreOverride(opts: {
  homeDir?: string;
  repoDir?: string;
  overwrite?: boolean;
} = {}): { installed: boolean; path: string; reason: 'created' | 'overwritten' | 'exists' } {
  const baseDir = opts.repoDir
    ? path.join(path.resolve(opts.repoDir), '.claude', 'agents')
    : path.join(opts.homeDir ?? os.homedir(), '.claude', 'agents');
  const target = path.join(baseDir, 'Explore.md');
  const existed = fs.existsSync(target);
  if (existed && !opts.overwrite) {
    return { installed: false, path: target, reason: 'exists' };
  }
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(target, CLAUDE_EXPLORE_OVERRIDE_MD, 'utf8');
  return { installed: true, path: target, reason: existed ? 'overwritten' : 'created' };
}

// ---------- 진단 리포트 포맷 ----------

export function formatCheckReport(report: EnvironmentReport): string {
  const mark = (ok: boolean, optional = false): string => (ok ? '✓' : optional ? '○' : '✗');
  const L: string[] = [];
  L.push('[setup --check] dgate 환경 진단');
  L.push('');
  L.push('필수 런타임:');
  L.push(`  ${mark(report.node.ok)} node ${report.node.version} (>= 22.6 필요)`);
  L.push(`  ${mark(report.nodeSqlite.ok)} node:sqlite (DatabaseSync 로드)`);
  L.push(`  ${mark(report.git.installed)} git ${report.git.path ?? '미설치'}`);
  L.push('');
  L.push('코딩 CLI (선택):');
  for (const id of CLI_IDS) {
    const c = report.clis[id];
    const note = id === 'agy' ? ' — 감지됨, 쿼터 한도로 기본 미선택' : '';
    L.push(`  ${mark(c.installed, true)} ${id} ${c.path ?? '(미설치)'}${c.installed ? note : ''}`);
  }
  if (report.discoveredModels.length > 0) {
    L.push('');
    L.push(`사용 가능 모델 (${report.discoveredModels.length}종, 로컬 감지):`);
    const MAX = 12;
    for (const m of report.discoveredModels.slice(0, MAX)) {
      const prov = m.provider ? ` · ${m.provider}` : '';
      const src = m.source === 'local_config' ? ' · 로컬 설정' : '';
      L.push(`  [${m.cli}] ${m.model} — ${m.tierLabel}${prov}${src}`);
    }
    if (report.discoveredModels.length > MAX) {
      L.push(`  … 외 ${report.discoveredModels.length - MAX}종`);
    }
  }
  L.push('');
  L.push('에이전트 스킬 디렉터리:');
  for (const a of report.agents) {
    if (!a.exists) {
      L.push(`  ○ ${a.dir} (미설치)`);
    } else {
      L.push(`  ${a.skillLinked ? '✓' : '○'} ${a.dir} ${a.skillLinked ? '(dgate 링크됨)' : '(스킬 미링크)'}`);
    }
  }
  L.push('');
  L.push('설정·상태:');
  L.push(
    `  ${report.roster.exists ? (report.roster.validJson ? '✓' : '✗') : '○'} 전역 roster ${report.roster.exists ? (report.roster.validJson ? report.roster.path : `${report.roster.path} (JSON 파싱 실패)`) : `없음 (${report.roster.path})`}`
  );
  L.push(`  ${mark(report.db.exists, true)} 결정 DB ${report.db.exists ? report.db.path : `없음 (${report.db.path}, ${report.db.source})`}`);
  L.push(
    `  ${mark(report.secrets.configured, true)} ${DECISION_API_KEY_ENV} ${report.secrets.envSet ? '(환경변수 설정됨)' : report.secrets.secretsFileExists ? '(secrets.env 존재)' : '(미설정 — 기본 off, 무료 로컬 통계)'}`
  );
  L.push('');
  L.push('선택 도구·스킬:');
  for (const id of COMPANION_IDS) {
    const c = report.companions[id];
    L.push(`  ${mark(c.installed, true)} ${id} — ${c.role}`);
    if (c.installed) L.push(`      → ${c.detail}`);
  }
  if (report.companionAdvice.length > 0) {
    L.push('');
    L.push('동반 스킬 환경 비교 추천:');
    const V_LABEL: Record<CompanionVerdict, string> = {
      already_installed: '✓ 설치됨',
      recommended: '◆ 추천',
      optional: '○ 선택',
      skip_overlap: '· 생략',
    };
    for (const a of report.companionAdvice) {
      L.push(`  ${V_LABEL[a.verdict]} ${a.id} — ${a.reason}`);
      L.push(`      ${a.repoUrl}`);
      if (a.verdict === 'recommended' && a.canAutoInstall && a.installCommand) {
        L.push(`      → 지금 자동 설치 가능: ${a.installCommand}`);
      }
    }
  }
  L.push('');
  const rec = report.recommendation;
  if (rec.mode === 'standalone') {
    L.push(`추천 모드: standalone — ${rec.reason}`);
  } else {
    L.push(`추천 모드: multi-cli / 프로필 "${rec.profileName}" (agy: ${rec.agy})`);
    L.push(`  ${rec.reason}`);
    for (const slot of ROLE_SLOT_LIST) {
      L.push(`    ${slot.padEnd(8)} → ${rec.roles[slot]}  (권장: ${ROLE_FIT_GUIDES[slot].recommendedTier})`);
    }
  }
  if (report.repoHooks) {
    const h = report.repoHooks;
    L.push('');
    L.push(`대상 프로젝트 훅 상태 (${h.repoDir}):`);
    L.push(`  ${mark(h.repoDirExists)} 디렉터리 ${h.repoDirExists ? '존재' : '없음'}`);
    L.push(`  ${mark(h.hooksJson, true)} .agents/hooks.json ${h.hooksJson ? '설치됨' : '미설치'}`);
    L.push(`  ${mark(h.hookSymlink, true)} .agents/hooks/dg-hook.ts ${h.hookSymlink ? '심볼릭 링크됨' : '미설치'}`);
    L.push(`  ${mark(h.excluded, true)} .git/info/exclude ${h.excluded ? '항목 있음' : '항목 없음'}`);
  }
  if (report.clis.claude.installed) {
    const ov = report.claudeExploreOverride;
    L.push('');
    L.push('Claude Code 탐색 비용 절감 (Explore.md 4줄 오버라이드):');
    L.push(
      ov.installed
        ? `  ✓ 설치됨 (${ov.path}) — 내장 Explore 검색이 haiku · low 로 실행됩니다`
        : `  ○ 미설치 (${ov.path}) — 기본 내장 Explore가 Opus로 grep을 실행합니다 (setup으로 4줄 haiku 오버라이드 설치 가능)`
    );
  }
  return L.join('\n');
}

// ---------- 대화형 위저드 ----------

const API_KEY_GUIDE_LINES = [
  `  ${DECISION_API_KEY_ENV} 안내:`,
  '    기본값 `off`(완전 무료 로컬 통계)입니다. 선택적으로 `gemini-decision-1` Shadow',
  '    비교를 쓰려면 ~/.config/herdr-quad/secrets.env에 키를 저장하세요:',
  '      mkdir -p ~/.config/herdr-quad',
  `      printf '${DECISION_API_KEY_ENV}=<키>' > ~/.config/herdr-quad/secrets.env`,
  '      chmod 600 ~/.config/herdr-quad/secrets.env',
  '    ※ 키 값은 이 프롬프트에 입력하지 않습니다 (셸 히스토리·로그 노출 방지).',
];

const PICKER_CLI_IDS = ['pi', 'claude', 'codex', 'devin', 'gemini'] as const;

/**
 * 대화형 역할별 모델 피커 — 추천 프로필을 베이스로 5개 슬롯을 순회하며
 * 발견 모델 번호 선택·직접 입력(m)·Enter(추천 유지)로 `roles`를 맞춤 구성한다.
 */
async function pickRoleModels(
  report: EnvironmentReport,
  rec: RosterRecommendation,
  ask: (q: string) => Promise<string>,
  out: (s?: string) => void
): Promise<Record<RoleSlot, RoleWorkerSpec>> {
  const base = PROFILE_BUILDERS[rec.profileName!]!.build();
  const roles: Record<RoleSlot, RoleWorkerSpec> = { ...base.roles };

  for (const slot of ROLE_SLOT_LIST) {
    const guide = ROLE_FIT_GUIDES[slot];
    out('');
    out(`[${slot}] ${guide.label} — ${guide.summary}`);
    out(`  현재 추천 → ${specLabel(base.roles[slot])}`);
    for (const [i, m] of report.discoveredModels.entries()) {
      out(`  ${String(i + 1).padStart(2)}. [${m.cli}] ${m.model} (${m.tierLabel})`);
    }
    const a = await ask('  번호 선택 / [m] 직접 입력 / [Enter] 추천 유지: ');
    if (a === '') continue;
    if (a === 'm') {
      const cliRaw = await ask('  CLI (pi|claude|codex|devin|gemini): ');
      const cli = PICKER_CLI_IDS.find((c) => c === cliRaw);
      if (!cli) {
        out('  → 알 수 없는 CLI — 추천 유지');
        continue;
      }
      const model =
        cli === 'devin'
          ? (await ask('  모델 이름 (devin이면 Enter로 건너뛰기): ')) || 'default'
          : await ask('  모델 이름: ');
      if (!model.trim()) {
        out('  → 모델 미입력 — 추천 유지');
        continue;
      }
      const provider = cli === 'pi' ? (await ask('  프로바이더 (예: opencodex): ')) || undefined : undefined;
      const choice: DiscoveredModel = { cli, model: model.trim(), source: 'local_config', ...classifyModelTier(cli, model.trim()) };
      if (provider) choice.provider = provider;
      roles[slot] = modelChoiceToRoleSpec(choice, slot);
      out(`  → ${specLabel(roles[slot])} 선택`);
      continue;
    }
    const n = Number.parseInt(a, 10);
    const m = report.discoveredModels[n - 1];
    if (!m) {
      out('  → 범위 밖 번호 — 추천 유지');
      continue;
    }
    roles[slot] = modelChoiceToRoleSpec(m, slot);
    out(`  → [${m.cli}] ${m.model} 선택`);
  }
  return roles;
}

/**
 * 위저드 Step 4-4 `[p]` 처리 — 입력이 기존 로컬 스킬 폴더면 SKILL.md 검증 후
 * 감지된 에이전트 스킬 디렉터리에 심볼릭 링크하고, Git URL이면 내용을 실행하지
 * 않는 안전한 절차(clone → SKILL.md 확인 → 재실행 시 로컬 경로 연결, 또는
 * opt-in으로 지금 clone 후 연결)를 안내한다.
 * 반환값은 스킬이 실제로 설치·연결됐는지 여부(스타 응원 프롬프트 게이트용).
 */
async function linkExternalSkillInteractive(
  src: string,
  advice: CompanionAdvice,
  report: EnvironmentReport,
  askChoice: (q: string) => Promise<string>,
  askText: (q: string) => Promise<string>,
  out: (s?: string) => void
): Promise<boolean> {
  const expandHome = (p: string): string =>
    p === '~' ? os.homedir() : p.startsWith(`~${path.sep}`) || p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  const linkFrom = (dir: string): boolean => {
    const targetDirs = report.agents.filter((a) => a.exists).map((a) => path.join(a.dir, 'skills'));
    if (targetDirs.length === 0) {
      out('  → 감지된 에이전트 스킬 디렉터리가 없어 연결할 수 없습니다 — 코딩 에이전트 설치 후 다시 시도하세요.');
      return false;
    }
    const r = installExternalSkillFromLocalPath(dir, advice.id, targetDirs);
    if (!r.ok) {
      out(`  → 연결 실패: ${r.error}`);
      return false;
    }
    for (const d of r.linked) out(`  → 링크 생성: ${path.join(d, advice.id)}`);
    for (const s of r.skipped) out(`  → 건너뜀: ${s.dir} (${s.reason})`);
    out(`    쓰는 법: ${advice.howToUse}`);
    return r.linked.length > 0 || r.skipped.some((s) => s.reason === 'already-linked');
  };

  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(src)) {
    out('  → Git URL은 내용을 확인하지 않고 실행하지 않습니다. 안전한 절차를 선택하세요:');
    const sel = await askChoice('    [c] 지금 git clone 후 연결 / [g] 수동 절차 안내 / [s] 취소 (기본: s) ');
    if (sel === 'c') {
      const defDest = path.join(os.homedir(), '.local', 'share', 'external-skills', advice.id);
      const dest = (await askText(`    clone 대상 경로 (기본: ${defDest}): `)) || defDest;
      const resolvedDest = path.resolve(expandHome(dest));
      if (fs.existsSync(resolvedDest)) {
        out(`    → 대상 경로가 이미 존재합니다: ${resolvedDest}`);
        return false;
      }
      const gitBin = report.git.path ?? 'git';
      const r = spawnSync(gitBin, ['clone', '--depth', '1', src, resolvedDest], { stdio: 'inherit' });
      if (r.status === 0) return linkFrom(resolvedDest);
      out('    → git clone 실패 — URL과 네트워크를 확인하세요');
    } else if (sel === 'g') {
      out(`    1) git clone ${src} <로컬 경로>`);
      out('    2) 폴더 안 SKILL.md 존재를 확인한 뒤, 이 위저드의 [p]에 그 로컬 경로를 입력하면 자동 심볼릭 링크됩니다.');
    }
    return false;
  }
  return linkFrom(path.resolve(expandHome(src)));
}

function printFinalSummary(report: EnvironmentReport, out: (s?: string) => void): void {
  out('');
  out('— 설정 요약: 내 환경 기준 지금 바로 써보는 3줄 —');
  out('  node ./src/decision/dg.ts route --task-kind explore_read --project .');
  out('  node ./src/decision/dg.ts wrap --route hook --tool-class exec -- echo ok');
  out('  node ./src/decision/dg.ts stats --project . && node ./src/decision/dg.ts report --project .');
  out('');
  out('TUI 실시간 관측 (읽기전용):');
  out(`  node ./src/cli.ts --watch-db ${report.db.path} --watch`);
  out('※ TUI `--watch`는 읽기전용 실시간 관측 화면이며, 실제 작업 실행·배차는 별도 셸에서 `dg`/`dispatch.ts`로 제어합니다.');
}

/**
 * 방금 설치·연결된 스킬 저장소에 GitHub 스타를 누를지 묻는다 (기본 N).
 * 사용자가 명시적으로 `y`/`yes`를 입력한 경우에만 `starGithubRepo`를 호출하고,
 * gh 부재·비공개 404 등 실패는 조용히 저장소 URL 안내로 폴백한다.
 */
async function promptStarRepo(
  rl: readline.Interface,
  name: string,
  repoSlug: string,
  repoUrl: string,
  out: (s?: string) => void
): Promise<void> {
  const a = (
    await rl.question(
      `방금 설치한 ${name} (${repoUrl}) 저장소에 GitHub 스타(★)를 눌러 제작자를 응원할까요? [y/N]: `
    )
  )
    .trim()
    .toLowerCase();
  if (a !== 'y' && a !== 'yes') return;
  const r = starGithubRepo(repoSlug);
  if (r.ok) {
    out(`  → 감사합니다! ${name} 저장소에 스타를 등록했습니다 ★`);
  } else {
    out(`  → 지금은 스타를 등록하지 못했습니다 (${r.reason ?? 'unknown'}) — ${r.fallbackUrl} 에서 직접 누르실 수 있습니다.`);
  }
}

async function runWizard(report: EnvironmentReport, opts: { yes: boolean; repo: string | null }): Promise<void> {
  const out = (s = ''): void => {
    process.stdout.write(`${s}\n`);
  };
  out(formatCheckReport(report));
  out('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askRaw = async (q: string): Promise<string> => {
    if (opts.yes) return '';
    return (await rl.question(q)).trim().toLowerCase();
  };
  /** 경로·URL 입력용 — 소문자 변환 없이 그대로 받는다 (macOS/Linux 경로는 대소문자 구분). */
  const askText = async (q: string): Promise<string> => {
    if (opts.yes) return '';
    return (await rl.question(q)).trim();
  };
  const askYN = async (q: string, defaultYes: boolean): Promise<boolean> => {
    const a = await askRaw(q);
    if (a === '') return defaultYes;
    return a === 'y' || a === 'yes' || a === '예' || a === 'ㅇ';
  };

  try {
    // Step 4-2: 맞춤 roster.json 생성/갱신 (multi-cli만) — 추천 그대로/직접 선택/건너뛰기
    const rec = report.recommendation;
    if (rec.mode === 'multi-cli' && rec.profileName) {
      out('— 맞춤 roster.json —');
      out(`추천 프로필 "${rec.profileName}": ${rec.reason}`);
      for (const slot of ROLE_SLOT_LIST) {
        out(`  ${slot.padEnd(8)} → ${rec.roles[slot]}  (권장: ${ROLE_FIT_GUIDES[slot].recommendedTier})`);
      }
      if (report.discoveredModels.length > 0) {
        out('');
        out(`로컬에서 발견된 사용 가능 모델 ${report.discoveredModels.length}종:`);
        const MAX = 15;
        for (const [i, m] of report.discoveredModels.slice(0, MAX).entries()) {
          out(`  ${String(i + 1).padStart(2)}. [${m.cli}] ${m.model} (${m.tierLabel})`);
        }
        if (report.discoveredModels.length > MAX) {
          out(`  … 외 ${report.discoveredModels.length - MAX}종`);
        }
      }
      const pickMode = await askRaw(
        '이 추천 조합을 그대로 쓸까요, 아니면 역할별 CLI·모델을 직접 골라 바꿀까요? [k=그대로 / c=직접 선택 / s=건너뛰기] (기본: k): '
      );
      if (pickMode === 's') {
        out('  → roster 설정 건너뜀 (기존 내장 기본값으로 동작)');
      } else {
        let cfg: RosterConfig | null;
        if (pickMode === 'c') {
          const picked = await pickRoleModels(report, rec, askRaw, out);
          out('');
          for (const w of checkCrossVerificationDiversity(picked)) out(`  ${w}`);
          out('— 최종 맞춤 역할 구성 —');
          for (const slot of ROLE_SLOT_LIST) out(`  ${slot.padEnd(8)} → ${specLabel(picked[slot])}`);
          cfg = {
            defaultProfile: 'custom-picked',
            profiles: {
              'custom-picked': {
                description: '대화형 선택 맞춤 프로필 (custom-picked), agy=0',
                dailyTurnBudgets: { agy: 0 },
                roles: picked,
              },
            },
          };
        } else {
          cfg = buildTailoredRosterConfig(rec);
        }
        const rosterPath = report.roster.path;
        if (!report.roster.exists) {
          if (await askYN(`이 조합으로 ${rosterPath}을 생성할까요? [Y/n]`, true)) {
            fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
            fs.writeFileSync(rosterPath, `${JSON.stringify(cfg, null, 2)}\n`);
            out(`  → 생성 완료: ${rosterPath}`);
          } else {
            out('  → 건너뜀 (기존 내장 기본값으로 동작)');
          }
        } else if (await askYN(`기존 ${rosterPath}이 있습니다. 백업(.bak) 후 새 조합으로 덮어쓸까요? [y/N]`, false)) {
          fs.copyFileSync(rosterPath, `${rosterPath}.bak`);
          fs.writeFileSync(rosterPath, `${JSON.stringify(cfg, null, 2)}\n`);
          out(`  → 백업 후 갱신 완료: ${rosterPath} (.bak 보존)`);
        } else {
          out('  → 기존 roster 유지');
        }
      }
      out('');
    }

    // Step 4-3: dgate 스킬 링크
    const linkTargets = report.agents.filter((a) => a.exists && !a.skillLinked);
    if (linkTargets.length > 0) {
      out('— 에이전트 스킬 등록 —');
      for (const t of linkTargets) out(`  대상: ${path.join(t.dir, 'skills', 'dgate')}`);
      if (await askYN('발견된 에이전트 폴더에 `dgate` 스킬을 연결할까요? [Y/n]', true)) {
        const r = installSkillLinks({ onlyAgentIds: linkTargets.map((t) => t.id) });
        for (const d of r.linked) out(`  → 링크 생성: ${path.join(d, 'skills', 'dgate')}`);
        for (const s of r.skipped) out(`  → 건너뜀: ${s.dir} (${s.reason})`);
      } else {
        out('  → 건너뜀');
      }
      out('');
    }

    // Step 4-3b: Claude Code 내장 Explore 4줄 경량 오버라이드 (claude 설치 시)
    if (report.clis.claude.installed && !report.claudeExploreOverride.installed) {
      out('— Claude Code Explore 비용 절감 오버라이드 —');
      out(`  대상: ${report.claudeExploreOverride.path}`);
      out('  효과: 내장 Explore(Read/Grep/Glob)를 Opus 대신 haiku · low 로 강등해 탐색 토큰 절약');
      if (await askYN('~/.claude/agents/Explore.md (4줄 오버라이드)를 설치할까요? [Y/n]', true)) {
        const r = installClaudeExploreOverride();
        out(r.installed ? `  → 생성 완료: ${r.path}` : `  → 기존 파일 보존: ${r.path}`);
      } else {
        out('  → 건너뜀');
      }
      out('');
    }

    // Step 4-4: 동반 스킬 비교 추천 및 설치 — 환경 비교 verdict별 분리 (전부 권하지 않음)
    const recommendedAdvice = report.companionAdvice.filter((a) => a.verdict === 'recommended');
    const optionalAdvice = report.companionAdvice.filter((a) => a.verdict === 'optional');
    const installedAdvice = report.companionAdvice.filter((a) => a.verdict === 'already_installed');
    out('— 동반 스킬 환경 비교 추천 —');
    for (const a of installedAdvice) out(`  ✓ ${a.id} — ${a.reason}`);
    if (recommendedAdvice.length > 0) {
      out('현재 환경에 설치하면 특히 유리한 스킬:');
      for (const a of recommendedAdvice) {
        out(`  ◆ ${a.id} — ${a.reason}`);
        out(`    쓰는 법: ${a.howToUse}`);
        if (a.id === 'mistology' && a.canAutoInstall) {
          const sel = await askRaw('  [i] 지금 자동 설치 / [g] 안내만 보기 / [s] 건너뛰기 (기본: s) ');
          if (sel === 'i') {
            const cargoBin = report.clis.cargo.path ?? 'cargo';
            out('  → cargo install 실행 중…');
            const r1 = spawnSync(cargoBin, ['install', '--git', MISTOLOGY_GUIDE_URL, '--locked'], { stdio: 'inherit' });
            if (r1.status === 0) {
              const mistBin = findOnPath('mistology', [path.dirname(cargoBin)]) ?? 'mistology';
              spawnSync(mistBin, ['setup'], { stdio: 'inherit' });
              out(`    → 설치 완료: ${a.howToUse}`);
              if (!opts.yes) await promptStarRepo(rl, a.name, a.repoSlug, a.repoUrl, out);
            } else {
              out('  → 설치 실패 — 안내 명령을 수동으로 실행하세요:');
              out(`    ${a.installCommand ?? MISTOLOGY_INSTALL_CMD}`);
            }
          } else if (sel === 'g') {
            out(`    ${a.installGuide}`);
          }
        } else {
          const sel = await askRaw('  [p] 로컬 폴더·Git URL로 지금 연결 / [g] 수동 설치 안내 / [s] 건너뛰기 (기본: s) ');
          if (sel === 'p') {
            const src = await askText('  스킬 폴더 경로 또는 Git URL 입력: ');
            if (src) {
              const linked = await linkExternalSkillInteractive(src, a, report, askRaw, askText, out);
              if (linked && !opts.yes) await promptStarRepo(rl, a.name, a.repoSlug, a.repoUrl, out);
            } else out('  → 입력 없음 — 건너뜀');
          } else if (sel === 'g') {
            out(`    ${a.installGuide}`);
          }
        }
      }
    }
    if (optionalAdvice.length > 0) {
      out('필요할 때만 선택할 스킬:');
      for (const a of optionalAdvice) out(`  ○ ${a.id} — ${a.reason}`);
    }
    const hcCompanion = report.companions.hc;
    if (!hcCompanion.installed) {
      out(`  ○ hc — ${hcCompanion.role}`);
      if (hcCompanion.installHint) out(`    ${hcCompanion.installHint}`);
    }
    if (!report.secrets.configured) {
      for (const line of API_KEY_GUIDE_LINES) out(line);
    }
    out('');

    // Step 4-5: 타깃 프로젝트 훅 설치 (기본 건너뛰기)
    out('— 타깃 프로젝트 훅 설치 (선택) —');
    let repoTarget: string | null = null;
    if (opts.repo) {
      // --repo 지정 자체가 opt-in 의사표시 — --yes 모드에서는 즉시 적용
      if (opts.yes || (await askYN(`${opts.repo}에 .agents 훅을 설치할까요? [y/N]`, false))) {
        repoTarget = opts.repo;
      }
    } else {
      const a = await askRaw('훅(.agents/hooks.json + .git/info/exclude)을 연결할 프로젝트 경로 (비우면 건너뛰기): ');
      if (a) repoTarget = a;
    }
    if (repoTarget) {
      const r = installRepoHooks({ repoDir: path.resolve(repoTarget) });
      for (const w of r.written) out(`  → 설치: ${w}`);
      for (const s of r.skipped) out(`  → 건너뜀: ${s.path} (${s.reason})`);
      // 계약 블록 — 훅 설치 결과와 무관하게 항상 시도(멱등, 실패는 조용 스킵)
      const c = installContractsBlock({ repoDir: path.resolve(repoTarget) });
      const label = c.reason === 'updated' ? '갱신' : c.changed ? '설치' : '변경 없음';
      out(`  → 계약 블록: ${label}`);
    } else {
      out('  → 건너뜀');
    }

    // Step 4-6: 마지막 요약
    printFinalSummary(report, out);

    // Step 4-7: 본 저장소 스타 응원 (opt-in — --yes·기본값·비동의 모두 건너뜀, 실패 무시)
    if (!opts.yes) {
      const yes = await askYN(
        `dgate (${SELF_REPO_URL})가 도움이 되셨다면 GitHub 스타(★)를 눌러 응원해 주실래요? [y/N]: `,
        false
      );
      if (yes) {
        const r = starGithubRepo(SELF_REPO_SLUG);
        if (r.ok) out('  → 감사합니다! 스타를 등록했습니다 ★');
        else out(`  → 지금은 스타를 등록하지 못했습니다 (${r.reason ?? 'unknown'}) — ${r.fallbackUrl} 에서 직접 눌러주세요.`);
      }
    }
  } finally {
    rl.close();
  }
}

// ---------- CLI 엔트리 ----------

const USAGE = `Usage:
  node ./scripts/setup.ts                 대화형 온보딩 위저드 (비TTY → 진단 요약)
  node ./scripts/setup.ts --check         읽기전용 진단 리포트 (0 writes/0 prompts)
  node ./scripts/setup.ts --check --json  기계판독 JSON 진단
  node ./scripts/setup.ts --repo <dir>    훅 설치 대상 프로젝트 지정
  node ./scripts/setup.ts --yes           대화형 프롬프트 기본값 자동 수락
  node ./scripts/setup.ts --help          이 도움말`;

interface ParsedArgs {
  check: boolean;
  json: boolean;
  yes: boolean;
  repo: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { check: false, json: false, yes: false, repo: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--repo') {
      const v = argv[++i];
      if (!v) throw new Error('--repo requires a directory argument');
      out.repo = v;
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const report = detectEnvironment({ repoDir: args.repo });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (args.check || !process.stdin.isTTY) {
    const footer =
      args.check || process.stdin.isTTY
        ? ''
        : '\n(비대화형 모드 — 쓰기 없이 진단만 수행했습니다. 대화형 설치는 TTY에서 `node ./scripts/setup.ts`를 실행하세요.)';
    process.stdout.write(`${formatCheckReport(report)}${footer}\n`);
    return 0;
  }

  await runWizard(report, { yes: args.yes, repo: args.repo });
  return 0;
}

const invokedAsScript = (() => {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return path.resolve(arg1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`[setup] fatal: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}
