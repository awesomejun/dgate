/**
 * `src/backend/liveWorkerSync.ts` — 활성 `hc` 워커 터미널 로스터 실시간 동기화 (Live TUI Sync v2).
 *
 * 목적: `--watch` 관측 TUI가 roster.json 대기(standby) 라벨 대신 **지금 실제로 돌고 있는
 * `hc` 워커 세션**(pi/devin/claude/codex/gemini)의 모델·레포·1줄 활동을 보여주게 한다.
 * roster.json 이 바뀌면 mtime 감지로 핫리로드하고, `hc` 부재·오류는 조용히 폴백해
 * 관제 화면이 죽지 않는다(§3.5 안전 폴백 계약 준수).
 *
 * 외부 연결:
 * - `src/cli.ts` `--watch` 모드가 `createLiveRosterSyncer`로 주기 동기화를 시작한다.
 * - `hc ls --json`(터미널 목록) · `hc get <addr> --json`(argv 상세) ·
 *   `hc read <addr> --lines 4`(화면 마지막 줄) 세 명령만 쓴다(전부 읽기 전용).
 * - 라벨 조립은 `../state/store.ts`의 `formatRoleBadge`·`rosterLabelsFromProfile`,
 *   roster 로딩은 `../decision/roster.ts`의 `loadRosterConfig`·`resolveRosterProfile`,
 *   활동 줄 정화는 `../decision/redact.ts`의 `redactSecrets`를 재사용한다(단일 구현 원칙).
 *
 * 주의:
 * - 모든 `hc` 호출은 timeout을 붙인 비동기 실행이며 실패 시 해당 틱을 조용히 건너뛴다.
 * - 터미널 화면 원문에는 시크릿이 섞일 수 있으므로 활동 줄 추출 시 반드시
 *   `redactSecrets`를 경유한다(절단 이전 적용 — redact.ts 계약).
 * - `tsconfig` `erasableSyntaxOnly` — enum·클래스 파라미터 프로퍼티 금지.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { redactSecrets } from '../decision/redact.ts';
import {
  builtinRosterConfig,
  globalRosterPath,
  loadRosterConfig,
  resolveRosterProfile,
} from '../decision/roster.ts';
import { formatRoleBadge, rosterLabelsFromProfile } from '../state/store.ts';
import {
  inferLiveWorkerSlotFromName,
  parseLiveWorkerSlot,
  type LiveWorkerSlot,
  type RosterDisplayLabels,
} from '../types.ts';

const execFileAsync = promisify(execFile);

/** `hc ls --json` 타임아웃 — 목록 조회는 짧게 끊는다. */
export const HC_LS_TIMEOUT_MS = 1500;
/** `hc read` 타임아웃 — 화면 캡처는 더 짧게 끊는다. */
export const HC_READ_TIMEOUT_MS = 800;
/** 기본 동기화 주기 (3초 — 터미널·herdr-core 부하 최소화). */
export const DEFAULT_SYNC_INTERVAL_MS = 3000;
/** 틱당 `hc read` 활동 캡처 상한 — 터미널 많아도 TUI가 느려지지 않게 한다. */
export const MAX_ACTIVITY_READS_PER_TICK = 6;

// ---------- 형태 ----------

/** `hc ls --json` 터미널 항목(요약). */
export interface HcTerminalSummary {
  address: string;
  agent?: string;
  name?: string;
  parent?: string;
  state?: string;
  status?: string;
  cwd?: string;
  /** `hc ls --json` 선택 필드 — 실측 턴 카운터(정수일 때만 채택). */
  turn?: number;
}

/** `hc get <addr> --json` 터미널 항목(상세) — argv 및 현재 foreground.argv 포함. */
export interface HcTerminalDetail extends HcTerminalSummary {
  argv?: string[];
  /** 현재 터미널 포그라운드 프로세스 argv — 있으면 초기 셸 런치 argv보다 모델·CLI 판정에 우선. */
  foregroundArgv?: string[];
}

/** 역할 슬롯 — `src/types.ts`의 공유 어휘(5종)를 재노출. TUI 파티션·`dg wrap --role`·`HERDR_ROLE`이 같은 표를 쓴다. */
export type { LiveWorkerSlot };

/** 현재 실행 중인 워커 1개의 TUI 표시 정보. */
export interface LiveWorkerInfo {
  slot: LiveWorkerSlot;
  /** 예: 'pi:glm-5.3 (실행 중)' · 'devin (실행 중)' */
  badge: string;
  /** 예: 'pi:glm-5.3' · 'devin' */
  shortModel: string;
  /** 예: 'glm-zcode/glm-5.3' · 'devin' (원문 모델명, 없으면 CLI명) */
  modelName: string;
  address: string;
  name: string;
  cwd: string | null;
  /** 레포 basename — `.herdr/worktrees/<wt>` 는 소속 레포명으로 환원 */
  repoTag: string;
  /** `hc read`에서 뽑은 정화된 1줄 활동 (없으면 간결 폴백) */
  activity: string;
  /** pid:N(wrap) 워커를 소유한 hc 터미널 주소 — 터미널 상세 뷰가 이 터미널을 보여준다. */
  ownerAddress?: string;
  /** `hc` 터미널 상태('working'·'done' 등) — 카드 완료 표시·완료 로그 판정용(선택). */
  status?: string | null;
  /** `hc ls --json` 실측 턴 카운터 — 카드 텔레메트리 라인에 그대로 노출. */
  turn?: number;
  /** 실측 CLI 이름 (예: 'agy', 'pi', 'devin') — roster.json 미사용. */
  cli?: string;
  /** 실측 모델명 (예: 'Gemini 4 Neon', 'glm-zcode/glm-5.3') — 미확인 시 null. */
  model?: string | null;
  /** 실측 effort/thinking (예: 'medium', 'max', 'high') — 미확인 시 null. */
  effort?: string | null;
  /** 카드 하단 표시용 실측 요약 (예: 'agy · Gemini 4 Neon · medium'). */
  telemetryLine?: string;
  /** 리드 세션이 내장 서브에이전트(invoke_subagent)를 실행 중일 때 경고 문구(없으면 null). */
  subagentWarning?: string | null;
  /** 리드 세션의 `--conversation` transcript에서 추출한 최근 사용자 입력·리드 응답. */
  recentIo?: TranscriptIoEntry[];
  /** 워커의 최근 출력 줄(`dg wrap` 실시간 로그 또는 `hc read` 꼬리, 시크릿 리덕션 완료). */
  recentOutput?: string[];
}

/** transcript.jsonl에서 추출한 사용자 입력 / 리드 응답 1건. */
export interface TranscriptIoEntry {
  time: string;
  role: 'user' | 'assistant';
  text: string;
}

/** `mergeLiveRosterLabels` 결과 — cli.ts가 AppState에 반영할 값의 묶음. */
export interface MergedLiveRoster {
  labels: RosterDisplayLabels;
  leadModelName: string;
  leadModelFlag: string;
  verifierModelName: string;
  verifierModelFlag: string;
  /** 실측 라이브 역할 세션의 하단 텔레메트리 (`cli · model · effort`), 없으면 null. */
  leadTelemetry?: string | null;
  verifierTelemetry?: string | null;
  advisorTelemetry?: string | null;
  /** 라이브 리드 세션의 내장 서브에이전트 실행 경고 배지(없으면 null). */
  leadSubagentWarning?: string | null;
  /** 라이브 리드 세션의 최근 사용자 입력·리드 응답(최대 12건, 오래된→최신 순). */
  leadRecentIo?: TranscriptIoEntry[];
  workers: LiveWorkerInfo[];
  activeWorkerCount: number;
}

// ---------- 워커 터미널 판정 ----------

/** 제외할 셸·비워커 에이전트 (antigravity는 리드 관측 대상이지 워커가 아니다). */
const SHELL_AGENTS = new Set([
  'zsh',
  'bash',
  'fish',
  'sh',
  'ksh',
  'dash',
  'pwsh',
  'powershell.exe',
  'antigravity',
]);

/** parent 매칭 판정에 쓰는 워커 CLI 에이전트 목록. */
const PARENT_MATCH_AGENTS = new Set([
  'pi',
  'devin',
  'claude',
  'codex',
  'gemini',
  'opencode',
  'hermes',
]);

/** 워커 세션명 접두 — herdr-quad-launch/dispatch가 만드는 이름 규약. */
const WORKER_NAME_PREFIXES = [
  'w-',
  'exp-',
  'explore-',
  'coder',
  'verify-',
  'verifier-',
  'lead-',
  'advisor-',
  'carbon-',
] as const;

/** 모니터·관측 전용 세션명 — 워커 집계에서 제외. */
const MONITOR_NAME_RE = /^dg-monitor(-|$)/;

/** 최상위 활성 AI 에이전트 세션으로 인정하는 에이전트 집합 — 관측 대상 확장용. */
const TOP_LEVEL_AI_AGENTS = new Set([
  'antigravity',
  'pi',
  'claude',
  'codex',
  'devin',
  'gemini',
  'agy',
  'opencode',
  'hermes',
]);

/** 모니터·GUI 전용 세션명 — 최상위 세션 관측에서도 제외. */
function isMonitorOrGuiName(name: string): boolean {
  return MONITOR_NAME_RE.test(name) || name.startsWith('mon-') || name.startsWith('dgate-gui');
}

/**
 * 최상위(parent 없음) 활성 AI 에이전트 세션 판정 — 리드 관측 확장:
 * ① `state === 'live'` ② `status`가 'working'·'idle'·'done' 중 하나(비어 있으면 불가 —
 *    idle/done 리드도 세션이 살아 있는 동안에는 Lead 배지를 유지해 사용자 턴 사이에
 *    roster.json 대기 배지로 깜빡이지 않게 한다) ③ parent 부재·빈 값
 * ④ 모니터·GUI(dg-monitor-, mon-, dgate-gui- 접두) 제외
 * ⑤ agent(소문자)가 AI 코딩 에이전트 7종 안팎.
 */
const TOP_LEVEL_ACTIVE_STATUSES = new Set(['working', 'idle', 'done']);

export function isActiveTopLevelSession(t: HcTerminalSummary): boolean {
  if (!t || t.state !== 'live') return false;
  if (!t.status || !TOP_LEVEL_ACTIVE_STATUSES.has(t.status)) return false;
  if (t.parent && t.parent.trim().length > 0) return false;
  if (isMonitorOrGuiName(t.name ?? '')) return false;
  const agent = (t.agent ?? '').toLowerCase();
  return TOP_LEVEL_AI_AGENTS.has(agent);
}

/** `hc ls` 터미널이 "관측 대상"인지 판정 — 기존 워커 규약 + 최상위 활성 AI 세션. */
export function isObservableTerminal(t: HcTerminalSummary): boolean {
  return isWorkerTerminal(t) || isActiveTopLevelSession(t);
}

/**
 * `hc ls` 터미널이 우리가 표시할 "워커"인지 판정:
 * ① `state === 'live'` 필수 ② 모니터(`dg-monitor*`·`mon-*`) 제외 ③ 셸·antigravity 제외
 * ④ 이름 접두(`w-`·`exp-`·`coder`·`verify-`…) 매칭 또는 parent 존재 + 워커 CLI 에이전트.
 */
export function isWorkerTerminal(t: HcTerminalSummary): boolean {
  if (!t || t.state !== 'live') return false;
  const name = t.name ?? '';
  if (MONITOR_NAME_RE.test(name) || name.startsWith('mon-')) return false;
  const agent = (t.agent ?? '').toLowerCase();
  if (SHELL_AGENTS.has(agent)) return false;
  if (name && WORKER_NAME_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (t.parent && agent && PARENT_MATCH_AGENTS.has(agent)) return true;
  return false;
}

// ---------- 레포 태그·스코프 ----------

/** 격리 워크트리 마커 (경로 구분자 정규화 후 탐색). */
const WORKTREE_MARKER = '/.herdr/worktrees/';

/**
 * cwd → 레포 표시명. 빈 값은 'unknown'.
 * `/a/b/my-repo/.herdr/worktrees/coder1` 처럼 격리 워크트리면 소속 레포명
 * (`my-repo`)으로 환원하고, 그 외에는 resolve 후 basename.
 */
export function extractRepoTag(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim().length === 0) return 'unknown';
  const norm = cwd.replaceAll('\\', '/');
  const markerIdx = norm.indexOf(WORKTREE_MARKER);
  if (markerIdx > 0) {
    const repoPart = norm.slice(0, markerIdx);
    const base = repoPart.split('/').filter(Boolean).pop();
    if (base) return base;
  }
  const base = path.basename(resolvePathBest(cwd));
  return base.length > 0 ? base : 'unknown';
}

/** 경로 해석 — realpath 우선, 실패(미존재 등) 시 resolve 폴백. */
function resolvePathBest(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 워커 cwd가 `--repo <dir>` 스코프 안에 있는지 판정.
 * 필터 없음(null)이면 전역 관측(항상 true), 워커 cwd 미상이면 스코프 지정 시 false.
 * 워크트리 서브디렉터리(`.herdr/worktrees/…`)도 소속 레포 스코프에 포함된다.
 */
export function matchesRepoScope(
  workerCwd: string | null | undefined,
  repoFilterDir: string | null | undefined
): boolean {
  if (!repoFilterDir) return true;
  if (!workerCwd) return false;
  const workerPath = resolvePathBest(workerCwd);
  const scopePath = resolvePathBest(repoFilterDir);
  // 스코프가 루트('/')면 `scopePath + sep`가 '//'가 되어 전부 거짓이 되는 사고 방지 —
  // 이미 구분자로 끝나는 스코프는 그대로 접두사로 쓴다.
  const prefix = scopePath.endsWith(path.sep) ? scopePath : scopePath + path.sep;
  return workerPath === scopePath || workerPath.startsWith(prefix);
}

/**
 * 터미널이 세션 스코프 안에 있는지 판정.
 * sessionId 미지정(undefined)이면 전역(항상 true) — 기존 동작 100% 보존.
 * 지정 시 터미널 주소 자체 또는 parent(해당 세션이 띄운 자식 워커)가 일치할 때만 true.
 */
export function matchesSessionScope(
  t: HcTerminalSummary,
  sessionId?: string
): boolean {
  if (!sessionId) return true;
  return t.address === sessionId || t.parent === sessionId;
}

// ---------- 활동 줄 추출 ----------

const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_RE = /\x1b[@-Z\\-_]/g;
const HC_STATUS_LINE_RE = /^\[hc\]/i;
const BOX_ONLY_LINE_RE = /^[─═┌┐└┘│├┤┬┴┼║╔╗╚╝╠╣╦╩╬\-_=·\s]+$/;
const SPINNER_ONLY_LINE_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+$/;
/** 줄 가장자리의 박스 장식(홑선·겹선 세로/모서리/교차) — 제거 후 본문을 재판정한다. */
const BOX_EDGE_RE = {
  leading: /^[\s│┌┐├┤║╔╗╠╣╦╩╬]+/,
  trailing: /[\s│└┘├┤║╚╝╠╣╦╩╬]+$/,
};

/** ANSI CSI/OSC 이스케이프 제거. */
export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_SINGLE_RE, '');
}

/** 코드포인트 기준 절단 — 초과분은 `…` 한 글자로 마감. */
function truncateChars(s: string, maxChars: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…';
}

const AGY_FOOTER_RE = /·\s+([^·]+?)\s+·\s+(minimal|low|medium|high|xhigh|max)(?:\s+·|\s*$)/i;
const PI_FOOTER_RE = /(?:\([^)]+\)\s+)?([^\s•]+)\s+•\s+(off|minimal|low|medium|high|xhigh|max)\b/i;
const STATUS_CHROME_LINE_RE =
  /^(?:esc to cancel\b|\?\s+for shortcuts\b|ctx\s+\d+%|↑\d+[kKmM]?\s+↓\d+[kKmM]?)/i;

/**
 * 라이브 터미널 화면 하단 상태줄에서 실측 model·effort를 추출한다.
 * - Antigravity(agy): `auto · Gemini 4 Neon · medium`
 * - Pi(pi): `(opencodex) glm-zcode/glm-5.3 • max`
 */
export function parseLiveScreenTelemetry(
  rawScreen: string | null | undefined
): { model: string | null; effort: string | null } {
  if (typeof rawScreen !== 'string' || rawScreen.length === 0) {
    return { model: null, effort: null };
  }
  const lines = stripAnsi(rawScreen).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    const agy = line.match(AGY_FOOTER_RE);
    if (agy) {
      const model = agy[1]!.trim();
      const effort = agy[2]!.toLowerCase();
      if (model.length > 0) return { model, effort };
    }
    const pi = line.match(PI_FOOTER_RE);
    if (pi) {
      const model = pi[1]!.trim();
      const effort = pi[2]!.toLowerCase();
      if (model.length > 0) return { model, effort };
    }
  }
  return { model: null, effort: null };
}

/** argv에서 `--effort` / `--thinking` 값을 추출한다. */
function parseWorkerEffort(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? '';
    if ((t === '--effort' || t === '--thinking') && i + 1 < argv.length) {
      const next = argv[i + 1] ?? '';
      if (next.length > 0 && !next.startsWith('-')) return next.toLowerCase();
    } else if (t.startsWith('--effort=') || t.startsWith('--thinking=')) {
      const v = t.slice(t.indexOf('=') + 1).trim();
      if (v.length > 0) return v.toLowerCase();
    }
  }
  return null;
}

/** 모델명에서 provider 접두(`glm-zcode/glm-5.3` → `glm-5.3`)만 정리해 간결 표기. */
function compactTelemetryModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1).trim() || trimmed : trimmed;
}

/** 실측 `cli · model · effort` 한 줄 포맷(확인된 항목만 조합). */
export function formatLiveTelemetry(
  cli: string | null | undefined,
  model: string | null | undefined,
  effort: string | null | undefined
): string {
  const parts: string[] = [];
  const c = (cli ?? '').trim();
  if (c && c !== 'custom') parts.push(c);
  const m = compactTelemetryModel(model);
  if (m && m.toLowerCase() !== c.toLowerCase()) parts.push(m);
  const e = (effort ?? '').trim().toLowerCase();
  if (e) parts.push(e);
  return parts.join(' · ') || c || 'live';
}

/** argv에서 `--conversation=<id>` 또는 `--conversation <id>`를 추출한다. */
export function extractConversationIdFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? '';
    if (t.startsWith('--conversation=')) {
      const id = t.slice('--conversation='.length).trim();
      if (/^[0-9a-fA-F-]{8,}$/.test(id)) return id;
    } else if (t === '--conversation' && i + 1 < argv.length) {
      const id = (argv[i + 1] ?? '').trim();
      if (/^[0-9a-fA-F-]{8,}$/.test(id)) return id;
    }
  }
  return null;
}

/**
 * Antigravity transcript.jsonl 꼬리(JSONL)에서 현재 실행 중인 내장 서브에이전트(`invoke_subagent`)를
 * 감지해 경고 배지 문구를 반환한다. 모두 완료(sender=<id> 수신 또는 state:idle)되었으면 null.
 */
export function detectSubagentWarningFromTranscript(rawTail: string | null | undefined): string | null {
  if (typeof rawTail !== 'string' || rawTail.length === 0) return null;
  const activeIds = new Set<string>();
  let pendingInvoke = false;

  for (const line of rawTail.split(/\r?\n/)) {
    if (!line) continue;
    if (line.includes('"invoke_subagent"') && line.includes('"tool_calls"')) {
      pendingInvoke = true;
    }
    if (line.includes('Created the following subagent:')) {
      const m = line.match(/\\?"conversationId\\?"\s*:\s*\\?"([0-9a-fA-F-]{8,})\\?"/);
      if (m?.[1]) {
        activeIds.add(m[1]);
        pendingInvoke = false;
      }
    }
    if (line.includes('active subagent(s):')) {
      activeIds.clear();
      pendingInvoke = false;
      const re =
        /\\?"conversationId\\?"\s*:\s*\\?"([0-9a-fA-F-]{8,})\\?"[^}]*?\\?"state\\?"\s*:\s*\\?"(running|idle)\\?"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m[2] === 'running' && m[1]) activeIds.add(m[1]);
      }
    }
    if (line.includes('sender=')) {
      const re = /sender=([0-9a-fA-F-]{8,})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m[1]) activeIds.delete(m[1]);
      }
      pendingInvoke = false;
    }
    if (line.includes('"manage_subagents"') && line.includes('kill_all')) {
      activeIds.clear();
      pendingInvoke = false;
    }
  }

  const count = activeIds.size + (pendingInvoke ? 1 : 0);
  return count > 0 ? `⚠ 내장 서브에이전트 실행 중 (${count}개 · 관측 불가)` : null;
}

const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
const MAX_RECENT_IO_ENTRIES = 12;

function formatIsoToLocalHhmmss(iso: unknown): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Antigravity / Pi / Claude Code / Codex / Gemini CLI transcript 꼬리에서
 * 최근 사용자 입력·리드 응답을 최대 `limit`건 추출한다(오래된→최신 순, 시크릿 리덕션 적용).
 */
export function extractRecentIoFromTranscript(
  rawTail: string | null | undefined,
  limit = MAX_RECENT_IO_ENTRIES
): TranscriptIoEntry[] {
  if (typeof rawTail !== 'string' || rawTail.length === 0) return [];
  const entries: TranscriptIoEntry[] = [];
  const pushClean = (role: 'user' | 'assistant', rawContent: string, isoTs: unknown) => {
    if (!rawContent.trim()) return;
    const cleaned = redactSecrets(rawContent)
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
      .replace(/<\/?USER_REQUEST>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned === '.' || cleaned.startsWith('# AGENTS.md instructions')) return;
    entries.push({
      time: formatIsoToLocalHhmmss(isoTs),
      role,
      text: truncateChars(cleaned, 160),
    });
  };
  const extractBlocks = (c: unknown, types: readonly string[]): string => {
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c
      .filter(
        (b): b is Record<string, unknown> =>
          Boolean(b) &&
          typeof b === 'object' &&
          types.includes(String((b as Record<string, unknown>)['type'] ?? ''))
      )
      .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
      .join(' ');
  };

  // Gemini CLI session JSON (`{ messages: [{ type: "user"|"gemini", content }] }`)
  const trimmed = rawTail.trimStart();
  if (trimmed.startsWith('{') && trimmed.includes('"messages"') && !trimmed.includes('\n{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (Array.isArray(parsed['messages'])) {
        for (const m of parsed['messages']) {
          if (!m || typeof m !== 'object') continue;
          const mo = m as Record<string, unknown>;
          const mt = mo['type'];
          if (mt === 'user' || mt === 'gemini') {
            const txt = extractBlocks(mo['content'], ['text']);
            pushClean(mt === 'user' ? 'user' : 'assistant', txt, mo['timestamp']);
          }
        }
        return entries.length > limit ? entries.slice(entries.length - limit) : entries;
      }
    } catch {
      // fall through to JSONL
    }
  }

  for (const line of rawTail.split(/\r?\n/)) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj['type'];
    if (type === 'USER_INPUT' || type === 'PLANNER_RESPONSE') {
      // Antigravity
      pushClean(
        type === 'USER_INPUT' ? 'user' : 'assistant',
        typeof obj['content'] === 'string' ? obj['content'] : '',
        obj['created_at']
      );
    } else if (type === 'message' && obj['message'] && typeof obj['message'] === 'object') {
      // Pi
      const msg = obj['message'] as Record<string, unknown>;
      if (msg['role'] === 'user' || msg['role'] === 'assistant') {
        pushClean(
          msg['role'],
          extractBlocks(msg['content'], ['text']),
          obj['timestamp'] ?? msg['timestamp']
        );
      }
    } else if ((type === 'user' || type === 'assistant') && obj['message'] && typeof obj['message'] === 'object') {
      // Claude Code
      const msg = obj['message'] as Record<string, unknown>;
      pushClean(type, extractBlocks(msg['content'], ['text']), obj['timestamp']);
    } else if (type === 'event_msg' && obj['payload'] && typeof obj['payload'] === 'object') {
      // Codex event_msg
      const p = obj['payload'] as Record<string, unknown>;
      if (p['type'] === 'user_message' || p['type'] === 'agent_message') {
        pushClean(
          p['type'] === 'user_message' ? 'user' : 'assistant',
          typeof p['message'] === 'string' ? p['message'] : '',
          obj['timestamp']
        );
      }
    } else if (type === 'response_item' && obj['payload'] && typeof obj['payload'] === 'object') {
      // Codex response_item
      const p = obj['payload'] as Record<string, unknown>;
      if (p['type'] === 'message' && (p['role'] === 'user' || p['role'] === 'assistant')) {
        pushClean(
          p['role'],
          extractBlocks(p['content'], ['input_text', 'output_text', 'text']),
          obj['timestamp']
        );
      }
    }
  }
  return entries.length > limit ? entries.slice(entries.length - limit) : entries;
}

/** 디렉터리에서 지정 확장자의 가장 최근 파일 1개를 찾는다. */
function findNewestFileInDir(dir: string, ext: string): string | null {
  try {
    let bestPath: string | null = null;
    let bestMtime = -1;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(ext)) continue;
      const full = path.join(dir, ent.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          bestPath = full;
        }
      } catch {
        // ignore
      }
    }
    return bestPath;
  } catch {
    return null;
  }
}

/** Pi 세션 디렉터리(`~/.pi/agent/sessions/--<cwd>--/`)에서 가장 최근 `.jsonl` 경로를 찾는다. */
function findLatestPiSessionPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const realCwd = resolvePathBest(cwd);
  const slug = `-${realCwd.replace(/[\\/]/g, '-')}--`;
  return findNewestFileInDir(path.join(home, '.pi', 'agent', 'sessions', slug), '.jsonl');
}

/** Claude Code 세션 디렉터리(`~/.claude/projects/<cwd-slug>/`)에서 가장 최근 `.jsonl` 경로를 찾는다. */
function findLatestClaudeSessionPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const realCwd = resolvePathBest(cwd);
  const slug = realCwd.replace(/[\\/.]/g, '-');
  return findNewestFileInDir(path.join(home, '.claude', 'projects', slug), '.jsonl');
}

/** Gemini CLI 세션 디렉터리(`~/.gemini/tmp/<repoTag>/chats/`)에서 가장 최근 `session-*.json`을 찾는다. */
function findLatestGeminiSessionPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const tag = extractRepoTag(cwd);
  if (!tag || tag === 'unknown') return null;
  return findNewestFileInDir(path.join(home, '.gemini', 'tmp', tag, 'chats'), '.json');
}

/** Codex 세션(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) 중 첫 줄 session_meta.cwd가 일치하는 최신 파일을 찾는다. */
function findLatestCodexSessionPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const target = resolvePathBest(cwd);
  const root = path.join(home, '.codex', 'sessions');
  try {
    const years = fs.readdirSync(root).sort().reverse();
    let checked = 0;
    for (const y of years) {
      const yDir = path.join(root, y);
      let months: string[];
      try {
        months = fs.readdirSync(yDir).sort().reverse();
      } catch {
        continue;
      }
      for (const m of months) {
        const mDir = path.join(yDir, m);
        let days: string[];
        try {
          days = fs.readdirSync(mDir).sort().reverse();
        } catch {
          continue;
        }
        for (const d of days) {
          const dDir = path.join(mDir, d);
          let files: string[];
          try {
            files = fs.readdirSync(dDir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
          } catch {
            continue;
          }
          for (const f of files) {
            if (++checked > 15) return null;
            const full = path.join(dDir, f);
            try {
              const fd = fs.openSync(full, 'r');
              const buf = Buffer.alloc(4096);
              const n = fs.readSync(fd, buf, 0, 4096, 0);
              fs.closeSync(fd);
              const firstLine = buf.subarray(0, n).toString('utf8').split(/\r?\n/)[0] ?? '';
              const meta = JSON.parse(firstLine) as { payload?: { cwd?: string } };
              if (meta.payload?.cwd && resolvePathBest(meta.payload.cwd) === target) {
                return full;
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface ConversationTranscriptCacheEntry {
  sig: string;
  warning: string | null;
  recentIo: TranscriptIoEntry[];
}

/** 주어진 transcript 파일 경로의 꼬리 128KB를 1회 읽어 경고 + 최근 입출력을 반환(mtime 캐시). */
function readTranscriptFileInfo(
  cacheKey: string,
  txPath: string,
  cache: Map<string, ConversationTranscriptCacheEntry>
): { warning: string | null; recentIo: TranscriptIoEntry[] } {
  try {
    const st = fs.statSync(txPath);
    const sig = `${txPath}:${st.mtimeMs}:${st.size}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.sig === sig) return { warning: hit.warning, recentIo: hit.recentIo };
    const fd = fs.openSync(txPath, 'r');
    try {
      const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const bytesRead = fs.readSync(fd, buf, 0, len, start);
      const raw = buf.subarray(0, bytesRead).toString('utf8');
      const warning = detectSubagentWarningFromTranscript(raw);
      const recentIo = extractRecentIoFromTranscript(raw, MAX_RECENT_IO_ENTRIES);
      cache.set(cacheKey, { sig, warning, recentIo });
      return { warning, recentIo };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { warning: null, recentIo: [] };
  }
}

/** conversationId의 transcript.jsonl 꼬리 128KB를 1회 읽어 서브에이전트 경고 + 최근 입출력을 함께 반환(mtime 캐시). */
function readConversationTranscriptInfo(
  convId: string,
  cache: Map<string, ConversationTranscriptCacheEntry>
): { warning: string | null; recentIo: TranscriptIoEntry[] } {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return { warning: null, recentIo: [] };
  const txPath = path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'brain',
    convId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  return readTranscriptFileInfo(convId, txPath, cache);
}

/**
 * 터미널 화면 원문에서 "의미 있는 마지막 1줄"을 뽑는다.
 * 아래에서 위로 훑으며 빈 줄·`[hc] …` 상태줄·박스/구분선·스피너 전용 줄·CLI 하단 상태줄은 건너뛴다.
 * 후보 줄은 가장자리 박스 장식(`│` 등)을 떼고, `redactSecrets`로 시크릿을.masking한 뒤
 * 공백을 붙이고 maxChars(기본 68)로 절단한다. 없으면 null.
 */
export function extractLastActivityLine(
  rawScreen: string | null | undefined,
  maxChars = 68
): string | null {
  if (typeof rawScreen !== 'string' || rawScreen.length === 0) return null;
  const lines = stripAnsi(rawScreen).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    // 먼저 가장자리 박스 장식(│║ 등)을 떼고 판정 — '│ [hc] idle │' 같은 박스형 상태줄도
    // 스킵되고, '╚════╝' 같은 겹선 테두리는 본문 없음으로 건너뛴다.
    const line = (lines[i] ?? '')
      .replace(BOX_EDGE_RE.leading, '')
      .replace(BOX_EDGE_RE.trailing, '')
      .trim();
    if (line.length === 0) continue;
    if (HC_STATUS_LINE_RE.test(line)) continue;
    if (BOX_ONLY_LINE_RE.test(line)) continue;
    if (SPINNER_ONLY_LINE_RE.test(line)) continue;
    if (STATUS_CHROME_LINE_RE.test(line)) continue;
    if (AGY_FOOTER_RE.test(line) || PI_FOOTER_RE.test(line)) continue;
    // 시크릿 리덕션은 절단 이전에(레댁션 계약 — 잘린 경계 무효화 방지)
    const safe = redactSecrets(line).replace(/\s+/g, ' ').trim();
    if (safe.length === 0) continue;
    return truncateChars(safe, maxChars);
  }
  return null;
}

// ---------- 슬롯·모델 추론 ----------

/** `HERDR_ROLE=<값>` 토큰 — 값 → 슬롯 해석은 `parseLiveWorkerSlot`(공유 어휘)이 담당한다. */
const HERDR_ROLE_RE = /^HERDR_ROLE=([^=\s]+)$/i;
const WORKER_CLI_SET = new Set([
  'pi',
  'devin',
  'claude',
  'codex',
  'gemini',
  'agy',
  'opencode',
  'hermes',
]);
const ENV_ASSIGN_ARG_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 토큰(절대경로 포함)의 basename — CLI 이름 추출용. */
function tokenBase(token: string): string {
  const norm = token.replaceAll('\\', '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

/** argv 앞단의 `env` + `KEY=VAL` 토큰 제거. */
function stripEnvPrefix(tokens: readonly string[]): string[] {
  let i = 0;
  if (tokens[i] === 'env') i++;
  while (i < tokens.length && ENV_ASSIGN_ARG_RE.test(tokens[i] ?? '')) i++;
  return tokens.slice(i);
}

/** `node …/dg.ts wrap … --` 래퍼 접두 제거 — `--` 이후의 실제 워커 커맨드만 남긴다. */
function stripDgWrapPrefix(tokens: readonly string[]): string[] {
  let dgIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const base = tokenBase(tokens[i] ?? '');
    if (base === 'dg.ts' || base === 'dg') {
      dgIdx = i;
      break;
    }
  }
  if (dgIdx < 0) return tokens as string[];
  const dashIdx = tokens.indexOf('--', dgIdx);
  return dashIdx >= 0 ? tokens.slice(dashIdx + 1) : (tokens as string[]);
}

/** 셸 `-c`/`-lc` 단일 문자열 안 `dg wrap` 코맨드 세그먼트 — `…; dg wrap …` 형태. */
const DG_WRAP_IN_SHELL_RE = /(?:^|[;&\n][;&\s]*)dg(?:\.ts)?\s+wrap\b/;

/**
 * argv가 `dg wrap` 실행을 호스팅하는지 — 이중 카드 방지 판정.
 * ① dg/dg.ts 토큰 바로 뒤가 'wrap'(env 접두는 먼저 벗긴다)
 * ② `env X=1 bash -lc '…; dg wrap …'`처럼 셸 -c/-lc 단일 문자열 안 코맨드로 감싼 형태.
 * 이런 터미널은 §3.5 ps wrap 탐지가 같은 워커를 cli·model·effort까지 정확히
 * 잡아주므로 hc 터미널 카드를 만들지 않는다. 일반 bash/기타 실행은 해당 없음.
 */
function isDgWrapHostArgv(tokens: readonly string[]): boolean {
  const stripped = stripEnvPrefix(tokens);
  for (let i = 0; i + 1 < stripped.length; i++) {
    const base = tokenBase(stripped[i] ?? '');
    if ((base === 'dg' || base === 'dg.ts') && stripped[i + 1] === 'wrap') return true;
  }
  for (let i = 0; i + 1 < stripped.length; i++) {
    const base = tokenBase(stripped[i] ?? '');
    if (
      (base === 'bash' || base === 'zsh' || base === 'sh') &&
      (stripped[i + 1] === '-lc' || stripped[i + 1] === '-c') &&
      DG_WRAP_IN_SHELL_RE.test(stripped.slice(i + 2).join(' '))
    ) {
      return true;
    }
  }
  return false;
}

/** argv(+agent 폴백)에서 실제 워커 CLI 이름과 `--model` 값을 찾는다. */
function parseWorkerCliAndModel(
  argv: readonly string[],
  fallbackAgent?: string
): { cli: string; model: string | null } {
  const cleaned0 = argv.filter((t) => typeof t === 'string' && t.length > 0);
  let tokens = stripEnvPrefix(cleaned0);
  tokens = stripEnvPrefix(stripDgWrapPrefix(tokens));

  let cliIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (WORKER_CLI_SET.has(tokenBase(tokens[i] ?? ''))) {
      cliIdx = i;
      break;
    }
  }
  let cli: string;
  if (cliIdx >= 0) {
    cli = tokenBase(tokens[cliIdx]!);
  } else {
    const agent = (fallbackAgent ?? '').toLowerCase();
    cli = WORKER_CLI_SET.has(agent) ? agent : 'custom';
  }

  let model: string | null = null;
  const scanStart = cliIdx >= 0 ? cliIdx : 0;
  for (let i = scanStart; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--model') {
      const v = tokens[i + 1];
      if (v && !v.startsWith('-')) {
        model = v;
        break;
      }
    } else if (t.startsWith('--model=')) {
      model = t.slice('--model='.length);
      break;
    }
  }
  return { cli, model };
}

/**
 * `hc get` 상세 + 화면 원문 → LiveWorkerInfo.
 * 슬롯은 ① argv의 `HERDR_ROLE=`(carbon→advisor) ② 세션명 규약(verify-/exp-/carbon-/lead-
 * …) 순으로 판정하고, CLI·모델은 `env`·`dg wrap` 래퍼를 벗겨낸 뒤 실제 CLI와
 * `--model`에서 읽는다(실패 시 `detail.agent` 폴백).
 */
export function inferLiveWorkerSlot(
  detail: HcTerminalDetail,
  rawScreen?: string
): LiveWorkerInfo | null {
  if (!detail || typeof detail.address !== 'string' || detail.address.length === 0) return null;
  const argv = Array.isArray(detail.argv) ? detail.argv : [];
  const fgArgv = Array.isArray(detail.foregroundArgv) ? detail.foregroundArgv : [];
  // 현재 포그라운드 프로세스 argv가 있으면 초기 셸 런치 argv(스테일 --model 등) 대신 사용한다.
  const cliArgv = fgArgv.length > 0 ? fgArgv : argv;

  // 1) 슬롯 — HERDR_ROLE env가 최우선 (래퍼 argv·포그라운드 argv 모두 검사)
  let slot: LiveWorkerSlot = 'coder';
  let roleFromArgv = false;
  for (const token of [...argv, ...fgArgv]) {
    if (typeof token !== 'string') continue;
    const m = token.match(HERDR_ROLE_RE);
    if (m) {
      const parsed = parseLiveWorkerSlot(m[1]);
      if (parsed) {
        slot = parsed;
        roleFromArgv = true;
        break;
      }
    }
  }
  // 세션명 접두(verify-/verifier-/neon-/exp-/carbon-/lead-/argon-) — 공유 접두 테이블로 판정.
  // 리드는 부모 없는 최상위 세션일 때만(하위 세션은 coder). 어느 접두도 아니면 coder.
  const name = detail.name ?? '';
  if (!roleFromArgv && name.length > 0) {
    const byName = inferLiveWorkerSlotFromName(name);
    if (byName === 'lead') slot = detail.parent ? 'coder' : 'lead';
    else if (byName) slot = byName;
    else slot = 'coder';
  }

  // 2) CLI·모델·effort — 현재 포그라운드 프로세스(cliArgv) + 실시간 터미널 하단 상태줄 우선
  const { cli, model: argvModel } = parseWorkerCliAndModel(cliArgv, detail.agent);
  const screenTel = parseLiveScreenTelemetry(rawScreen);
  const argvEffort = parseWorkerEffort(cliArgv);
  const liveModel = screenTel.model ?? argvModel ?? null;
  const liveEffort = screenTel.effort ?? argvEffort ?? null;
  const displayCli =
    cli === 'custom' && detail.agent
      ? detail.agent.toLowerCase() === 'antigravity'
        ? 'agy'
        : detail.agent.toLowerCase()
      : cli;
  const shortModel = formatRoleBadge(liveModel ? { cli, model: liveModel } : { cli });
  const modelName = liveModel ?? cli;
  const telemetryLine = formatLiveTelemetry(displayCli, liveModel, liveEffort);

  // 3) 조립 — 활동은 화면 원문 우선, 없으면 상태 기반 간결 폴백
  const activity =
    extractLastActivityLine(rawScreen ?? '') ??
    (detail.status ? `${detail.status} 작업 중` : '작업 실행 중');
  return {
    slot,
    badge: `${shortModel} (실행 중)`,
    shortModel,
    modelName,
    address: detail.address,
    name: name.length > 0 ? name : detail.address,
    cwd: detail.cwd ?? null,
    repoTag: extractRepoTag(detail.cwd),
    activity,
    status: detail.status ?? null,
    turn: detail.turn,
    cli: displayCli,
    model: liveModel,
    effort: liveEffort,
    telemetryLine,
  };
}

// ---------- dg wrap 프로세스 워커 (hc 터미널이 아닌 자식 프로세스) ----------

/** `ps` 한 줄 — pid·ppid·전체 커맨드. */
export interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

/** `ps -axo pid=,ppid=,command=` 출력 파싱. */
export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

/** 라이브 `dg wrap` 실행 1건 — 에이전트(리드)가 hc 터미널 없이 백그라운드로 띄운 워커. */
export interface WrapProc {
  wrapPid: number;
  /** wrap 프로세스부터 위로 올라가는 조상 pid 체인(자기 자신 제외). */
  ancestors: number[];
  cli: string;
  model: string | null;
  effort: string | null;
  /** 표시명 우선순위 1순위 `--label` 원문. */
  label: string | null;
  /** 명시적 역할 `--role <slot>`(최우선) — 미지정·무효값이면 null(라벨 접두로 폴백). */
  role: LiveWorkerSlot | null;
  /** 원본 `--project` 경로 — 고아 wrap 스코프 판정·cwd 폴백용(표시명은 `project`). */
  projectPath: string | null;
  project: string | null;
  route: string | null;
}

const WRAP_LAUNCHERS = new Set(['node', 'bun', 'deno', 'tsx', 'dg', 'dg.ts']);

function flagValue(tokens: readonly string[], flag: string): string | null {
  const i = tokens.indexOf(flag);
  if (i >= 0 && i + 1 < tokens.length) return tokens[i + 1]!;
  return null;
}

/**
 * ps 목록에서 `node …/dg.ts wrap …` 프로세스와 그 실제 워커 자식(devin/pi/claude/…)을 찾는다.
 * 워커 자식이 아직 없고 `--` 이후 커맨드도 없으면 건너뛴다(허위 카드 금지).
 */
export function findWrapProcesses(rows: readonly PsRow[]): WrapProc[] {
  const byPid = new Map<number, PsRow>();
  const children = new Map<number, PsRow[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const out: WrapProc[] = [];
  for (const row of rows) {
    const tokens = stripEnvPrefix(row.command.split(/\s+/).filter((t) => t.length > 0));
    if (tokens.length < 3 || !WRAP_LAUNCHERS.has(tokenBase(tokens[0]!))) continue;
    const dgIdx = tokens.findIndex((t) => t === 'dg' || tokenBase(t) === 'dg.ts' || tokenBase(t) === 'dg');
    if (dgIdx < 0 || tokens[dgIdx + 1] !== 'wrap') continue;

    // 1) `dg wrap ... -- <cmd...>` 뒤 원본 커맨드 (자식이 process.title을 'pi'로 덮어도 --model/--thinking 보존)
    const dash = tokens.indexOf('--', dgIdx);
    const dashTokens = dash >= 0 && dash + 1 < tokens.length ? tokens.slice(dash + 1) : null;

    // 2) BFS — 가장 가까운 워커 CLI 자식
    let childTokens: string[] | null = null;
    const queue: number[] = [row.pid];
    for (let qi = 0; qi < queue.length && qi < 64 && !childTokens; qi++) {
      for (const child of children.get(queue[qi]!) ?? []) {
        // `env VAR=… pi …` 자식도 감지 — env 접두를 벗기고 실제 CLI 헤드를 본다.
        const ct = stripEnvPrefix(child.command.split(/\s+/).filter((t) => t.length > 0));
        const head = tokenBase(ct[0] ?? '');
        const second = tokenBase(ct[1] ?? '');
        if (WORKER_CLI_SET.has(head) || (head === 'node' && WORKER_CLI_SET.has(second))) {
          childTokens = ct;
          break;
        }
        queue.push(child.pid);
      }
    }
    if (!dashTokens && !childTokens) continue;

    const fromDash = dashTokens ? parseWorkerCliAndModel(dashTokens) : null;
    const fromChild = childTokens ? parseWorkerCliAndModel(childTokens) : null;
    const cli =
      (fromDash && fromDash.cli !== 'custom' ? fromDash.cli : null) ??
      fromChild?.cli ??
      fromDash?.cli ??
      'custom';
    const model = fromDash?.model ?? fromChild?.model ?? null;
    const effort =
      (dashTokens ? parseWorkerEffort(dashTokens) : null) ??
      (childTokens ? parseWorkerEffort(childTokens) : null);
    const ancestors: number[] = [];
    let cur = byPid.get(row.ppid);
    for (let hop = 0; cur && hop < 40; hop++) {
      ancestors.push(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    if (row.ppid > 1 && !ancestors.includes(row.ppid)) ancestors.unshift(row.ppid);
    const projectPath = flagValue(tokens, '--project');
    const label = flagValue(tokens, '--label');
    out.push({
      wrapPid: row.pid,
      ancestors,
      cli,
      model,
      effort,
      label,
      role: parseLiveWorkerSlot(flagValue(tokens, '--role')),
      projectPath,
      project: label ?? (projectPath ? tokenBase(projectPath.replace(/[\\/]+$/, '')) || null : null),
      route: flagValue(tokens, '--route'),
    });
  }
  return out;
}

/** `dg wrap` 실시간 출력 로그 디렉터리 (`$XDG_STATE_HOME/dgate/wrap-logs` 또는 `~/.local/state/dgate/wrap-logs`). */
export function defaultWrapLogDir(): string {
  const stateHome = process.env['XDG_STATE_HOME']?.trim() || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'dgate', 'wrap-logs');
}

/** raw 터미널/로그 문자열에서 의미 있는 최근 출력 줄(최대 maxLines)을 추출한다. */
export function extractRecentOutputLines(
  raw: string | undefined,
  maxLines = 12,
  maxChars = 140
): string[] {
  if (!raw) return [];
  const cleaned = stripAnsi(raw).replace(/\r/g, '');
  const out: string[] = [];
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[hc]')) continue;
    if (/^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╰╯·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/.test(trimmed)) continue;
    out.push(redactSecrets(trimmed).slice(0, maxChars));
  }
  return out.length > maxLines ? out.slice(out.length - maxLines) : out;
}

/** `dg wrap` 백그라운드 워커의 실시간 출력 꼬리 파일을 읽어 최근 줄 목록을 반환한다. */
export function readWrapOutputTail(wrapPid: number, logDir = defaultWrapLogDir(), maxLines = 12): string[] {
  try {
    const p = path.join(logDir, `${wrapPid}.log`);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return [];
    const buf = fs.readFileSync(p, 'utf8');
    return extractRecentOutputLines(buf, maxLines);
  } catch {
    return [];
  }
}

/** wrap 워커 슬롯 추론 — label(--label) 우선, 없으면 route 근사. 역할 카드 매핑의 근거. */
/**
 * wrap 워커 슬롯 — ① 명시 `--role`(최우선) ② 라벨/프로젝트명 **접두**(`inferLiveWorkerSlotFromName`)
 * ③ 라벨 없는 file_select → explore ④ coder. 부분 문자열 판정은 쓰지 않는다: 주제에 역할어가
 * 들어간 coder 라벨(`fix-rust-verifier-observations`)을 verifier로 보내면 Workers 카드에서 사라지고
 * 검증 패널을 오염시킨다. 라벨만으로 리드가 되지는 않는다(wrap 워커는 리드가 아니다) — 명시 `--role lead`만 인정.
 */
function inferWrapSlot(p: WrapProc): LiveWorkerSlot {
  if (p.role) return p.role;
  const byLabel = inferLiveWorkerSlotFromName(p.project);
  if (byLabel && byLabel !== 'lead') return byLabel;
  if (!p.project && p.route === 'file_select') return 'explore';
  return 'coder';
}

/** wrap 프로세스를 상위 hc 세션(parent) 카드 정보로 변환 — 실행 중. */
export function wrapProcToWorker(
  p: WrapProc,
  parent: HcTerminalSummary,
  logDir = defaultWrapLogDir()
): LiveWorkerInfo {
  const shortModel = formatRoleBadge(p.model ? { cli: p.cli, model: p.model } : { cli: p.cli });
  const recentOutput = readWrapOutputTail(p.wrapPid, logDir, 12);
  const latestLine = recentOutput.length > 0 ? recentOutput[recentOutput.length - 1]! : null;
  return {
    slot: inferWrapSlot(p),
    badge: `${shortModel} (실행 중)`,
    shortModel,
    modelName: p.model ?? p.cli,
    address: `pid:${p.wrapPid}`,
    ownerAddress: parent.address,
    name: p.project ?? `wrap-${p.wrapPid}`,
    cwd: parent.cwd ?? null,
    repoTag: extractRepoTag(parent.cwd),
    activity: latestLine
      ? latestLine.slice(0, 96)
      : `dg wrap 실행 중${p.route ? ` · ${p.route}` : ''} (상위 ${parent.address})`,
    status: 'working',
    cli: p.cli,
    model: p.model,
    effort: p.effort,
    telemetryLine: formatLiveTelemetry(p.cli, p.model, p.effort),
    recentOutput,
  };
}

/**
 * 소유 hc 세션을 못 찾은 고아 `dg wrap` 워커 변환 — `nohup dg wrap … &`처럼 상위 셸이
 * 죽어 PPID=1로 재부여되면 조상 체인이 끊겨 `wrapProcToWorker`의 소유 매핑이 불가능하다.
 * 버리면 TUI에서 워커가 사라지는 관측 공백이 생기므로 미소속 카드로라도 표시한다.
 * cwd·repoTag는 `--project` 경로가 있을 때만 채우고, 없으면 '미소속'으로 표시한다.
 */
export function wrapProcToUnownedWorker(
  p: WrapProc,
  logDir = defaultWrapLogDir()
): LiveWorkerInfo {
  const shortModel = formatRoleBadge(p.model ? { cli: p.cli, model: p.model } : { cli: p.cli });
  const recentOutput = readWrapOutputTail(p.wrapPid, logDir, 12);
  const latestLine = recentOutput.length > 0 ? recentOutput[recentOutput.length - 1]! : null;
  return {
    slot: inferWrapSlot(p),
    badge: `${shortModel} (실행 중)`,
    shortModel,
    modelName: p.model ?? p.cli,
    address: `pid:${p.wrapPid}`,
    name: p.project ?? `wrap-${p.wrapPid}`,
    cwd: p.projectPath,
    repoTag: p.projectPath ? extractRepoTag(p.projectPath) : '미소속',
    activity: latestLine
      ? latestLine.slice(0, 96)
      : `dg wrap 실행 중${p.route ? ` · ${p.route}` : ''} · 소유 세션 없음`,
    status: 'working',
    cli: p.cli,
    model: p.model,
    effort: p.effort,
    telemetryLine: formatLiveTelemetry(p.cli, p.model, p.effort),
    recentOutput,
  };
}

async function defaultPsRunner(): Promise<string> {
  if (process.platform === 'win32') return '';
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], {
    timeout: 1500,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

// ---------- 라벨 병합 ----------

/**
 * 최상위 활성 AI 세션을 Lead 카드로 정규화:
 * - 슬롯은 lead 고정(LEAD 카운터·Lead 카드에 반영).
 * - 표시명은 비어 있지 않은 세션명, 없으면 'lead'(원 주소 노출 방지).
 * - `--model` 미파싱 시 shortModel을 agent명(예: 'antigravity')으로 폴백.
 */
export function normalizeTopLevelWorker(
  worker: LiveWorkerInfo,
  summary: HcTerminalSummary
): LiveWorkerInfo {
  const name = (summary.name ?? '').trim();
  const agent = (summary.agent ?? '').trim().toLowerCase();
  let { shortModel, badge, modelName } = worker;
  if (agent && shortModel === 'custom') {
    shortModel = agent;
    badge = `${agent} (실행 중)`;
    if (!modelName || modelName === 'custom') modelName = agent;
  }
  return {
    ...worker,
    slot: 'lead',
    name: name.length > 0 ? name : 'lead',
    shortModel,
    badge,
    modelName,
  };
}

/** 라이브 오버라이드 대상 슬롯(lead는 watchedLead 부재 시에만). */
const LIVE_OVERRIDE_SLOTS: readonly LiveWorkerSlot[] = ['verifier', 'coder', 'explore', 'advisor'];

/**
 * roster 대기(standby) 라벨 위에 라이브 워커 배지를 얹는다.
 * - `watchedLead`(관측 중 리드 세션 배지)가 있으면 lead 슬롯을 침범하지 않는다.
 * - 슬롯별 첫 워커가 우선(동일 슬롯 다중 워커 시 표기 안정).
 * - 워커가 없으면 대기 라벨로 그대로 되돌아간다(종료 시 자동 복귀).
 * - 모델 플래그는 실측 모델이 있을 때만 `--model <원문>` (applyRosterToState 계약 동일).
 */
export function mergeLiveRosterLabels(
  base: RosterDisplayLabels,
  watchedLead: string | null | undefined,
  workers: readonly LiveWorkerInfo[]
): MergedLiveRoster {
  const labels: RosterDisplayLabels = { ...base };
  if (watchedLead) labels.lead = watchedLead;

  let leadWorker: LiveWorkerInfo | null = null;
  let verifierWorker: LiveWorkerInfo | null = null;
  let advisorWorker: LiveWorkerInfo | null = null;
  const claimed = new Set<LiveWorkerSlot>();
  for (const w of workers) {
    if (w.slot === 'lead') {
      if (!watchedLead && !leadWorker) leadWorker = w;
      continue;
    }
    if (LIVE_OVERRIDE_SLOTS.includes(w.slot) && !claimed.has(w.slot)) {
      claimed.add(w.slot);
      labels[w.slot] = w.shortModel;
      if (w.slot === 'verifier') verifierWorker = w;
      if (w.slot === 'advisor') advisorWorker = w;
    }
  }

  // 라이브 리드 세션이 하나라도 있으면(working·idle·done 무관) 제목·modelFlag를 그 세션
  // 기준으로 유지한다 — 리드가 idle/done으로 쉬는 동안 roster.json 배지로 되돌아갔다가
  // 다시 덮어쓰면 사용자 턴 사이에 Lead 표기가 깜빡인다. roster.json 원복은 라이브 리드
  // 세션이 0개가 된 순간(목록에서 사라짐)에만 일어난다.
  // watchedLead 우선이므로 이 덮어쓰기는 관측 중 세션 배지를 침범하지 않는다.
  if (leadWorker) labels.lead = leadWorker.shortModel;

  const leadModelName = labels.lead;
  // 라이브 리드: 실측 모델이 있으면 --model 원문, 에이전트명만 있으면 live session 배지,
  // 리드 부재 시에는 roster.json 대기 배지로 깨끗히 원복(스테일 --model 잔류 방지).
  const leadModelFlag = leadWorker
    ? leadWorker.modelName && leadWorker.modelName !== leadWorker.shortModel
      ? `--model ${leadWorker.modelName}`
      : `live session: ${leadWorker.shortModel}`
    : labels.lead;
  const verifierModelName = labels.verifier;
  const verifierModelFlag =
    verifierWorker && verifierWorker.modelName && verifierWorker.modelName !== verifierWorker.shortModel
      ? `--model ${verifierWorker.modelName}`
      : labels.verifier;

  return {
    labels,
    leadModelName,
    leadModelFlag,
    verifierModelName,
    verifierModelFlag,
    leadTelemetry: leadWorker
      ? (leadWorker.telemetryLine ?? formatLiveTelemetry(leadWorker.cli, leadWorker.model, leadWorker.effort))
      : null,
    verifierTelemetry: verifierWorker
      ? (verifierWorker.telemetryLine ??
        formatLiveTelemetry(verifierWorker.cli, verifierWorker.model, verifierWorker.effort))
      : null,
    advisorTelemetry: advisorWorker
      ? (advisorWorker.telemetryLine ??
        formatLiveTelemetry(advisorWorker.cli, advisorWorker.model, advisorWorker.effort))
      : null,
    leadSubagentWarning: leadWorker?.subagentWarning ?? null,
    leadRecentIo: leadWorker?.recentIo ?? [],
    workers: [...workers],
    activeWorkerCount: workers.length,
  };
}

// ---------- 주기 동기화 ----------

/** `hc` 실행 추상 — 테스트가 mock으로 갈아끼운다. stdout 문자열 반환. */
export type HcExecRunner = (
  file: string,
  args: readonly string[],
  opts: { timeout: number }
) => Promise<string>;

async function defaultHcExec(
  file: string,
  args: readonly string[],
  opts: { timeout: number }
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: opts.timeout,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export interface LiveRosterSyncerOptions {
  /** roster.json 프로필 후보 기준 디렉터리(프로젝트 오버라이드 탐색용). */
  repoDir: string;
  /** `--repo <dir>` 스코프 — null이면 전체 레포 관측. */
  repoFilterDir?: string | null;
  /** `--session <id>` 스코프 — undefined면 세션 필터 없음(기존 동작 불변). */
  sessionId?: string;
  /** 관측 중 리드 배지 제공자(있으면 lead 슬롯 라이브 오버라이드 금지). */
  getWatchedLead?: () => string | null;
  /** 병합 결과 수신자 — 매 틱 호출(변경 여부 판정은 수신자 책임). */
  onUpdate: (merged: MergedLiveRoster) => void;
  /** 동기화 주기(기본 2000ms). */
  intervalMs?: number;
  /** `hc` 실행기 주입(테스트용 — 기본 execFile). */
  execRunner?: HcExecRunner;
  /** `hc` 실행 파일(기본 'hc'). */
  hcBin?: string;
  /** `ps -axo pid=,ppid=,command=` 출력 공급자(테스트용). execRunner를 주입하면 기본 비활성. */
  psRunner?: () => Promise<string>;
}

export interface LiveRosterSyncer {
  /** 타이머 정지·캐시 정리(멱등). */
  stop(): void;
  /** 1회 즉시 동기화(테스트·수동 트리거용). */
  tickNow(): Promise<void>;
}

/** `hc ls`/`hc get` 항목을 방어적으로 정규화 — status는 객체형(`{app,state}`)도 문자열로. */
function normalizeTerminal(raw: Record<string, unknown>): HcTerminalSummary | null {
  const address = typeof raw['address'] === 'string' ? raw['address'] : null;
  if (!address) return null;
  const statusRaw = raw['status'];
  let status: string | undefined;
  if (typeof statusRaw === 'string') {
    status = statusRaw;
  } else if (statusRaw && typeof statusRaw === 'object') {
    const st = (statusRaw as Record<string, unknown>)['state'];
    if (typeof st === 'string') status = st;
  }
  return {
    address,
    agent: typeof raw['agent'] === 'string' ? raw['agent'] : undefined,
    name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
    parent: typeof raw['parent'] === 'string' ? raw['parent'] : undefined,
    state: typeof raw['state'] === 'string' ? raw['state'] : undefined,
    status,
    cwd: typeof raw['cwd'] === 'string' ? raw['cwd'] : undefined,
    turn: typeof raw['turn'] === 'number' ? raw['turn'] : undefined,
  };
}

function parseJsonOrNull(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 주기 논블로킹 로스터 동기화기:
 * - roster.json 후보 경로의 `mtimeMs:size` 서명이 바뀌면 설정을 핫리로드한다.
 * - `hc ls --json` → 워커 필터(`isWorkerTerminal` + `matchesRepoScope`) →
 *   주소별 `hc get --json` 캐시(떠난 주소 즉시 증발) → 활동 캡처 상한 6개의
 *   `hc read <addr> --lines 4`.
 * - 틱 중첩 방지(inFlight), `stop()`으로 안전 종료. 모든 `hc` 오류는 조용히 폴백.
 */
export function createLiveRosterSyncer(opts: LiveRosterSyncerOptions): LiveRosterSyncer {
  const execRunner = opts.execRunner ?? defaultHcExec;
  const hcBin = opts.hcBin ?? 'hc';
  const intervalMs = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const repoFilterDir = opts.repoFilterDir ?? null;
  const sessionId = opts.sessionId;
  const psRunner: (() => Promise<string>) | null =
    opts.psRunner ?? (opts.execRunner ? null : defaultPsRunner);
  const pidCache = new Map<string, number[]>();
  let lastWrapWorkers: LiveWorkerInfo[] = [];
  let psTickCounter = 0;

  let baseLabels: RosterDisplayLabels | null = null;
  let rosterSignature: string | null = null;
  let lastWorkers: LiveWorkerInfo[] = [];
  const detailCache = new Map<string, HcTerminalDetail>();
  const screenCache = new Map<string, string>();
  const subagentCache = new Map<string, ConversationTranscriptCacheEntry>();
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function rosterCandidatePaths(): string[] {
    const out: string[] = [];
    const envPath = process.env.HERDR_ROSTER_PATH?.trim();
    if (envPath) out.push(path.resolve(envPath));
    out.push(path.join(opts.repoDir, '.herdr', 'roster.json'));
    out.push(globalRosterPath());
    return out;
  }

  function computeRosterSignature(): string {
    const parts: string[] = [];
    for (const p of rosterCandidatePaths()) {
      try {
        const st = fs.statSync(p);
        parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${p}:-`);
      }
    }
    return parts.join('|');
  }

  function reloadRosterLabels(): void {
    const sig = computeRosterSignature();
    if (sig === rosterSignature && baseLabels) return;
    rosterSignature = sig;
    try {
      const loaded = loadRosterConfig({ repoDir: opts.repoDir });
      const resolved = resolveRosterProfile(loaded.config, loaded.config.defaultProfile);
      baseLabels = rosterLabelsFromProfile(resolved.name, loaded.source, resolved.profile);
    } catch {
      if (!baseLabels) {
        const resolved = resolveRosterProfile(builtinRosterConfig(), 'quota-saver');
        baseLabels = rosterLabelsFromProfile(resolved.name, 'builtin', resolved.profile);
      }
    }
  }

  async function runTick(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      reloadRosterLabels();
      const labels = baseLabels!;

      // 1) `hc ls --json` — 실행 오류·JSON 파싱 실패 모두 이전 워커 상태 유지(fail-safe).
      //    (파싱 실패 시 빈 목록으로 방송하면 워커 0건 + 허위 종료 로그가 터진다.)
      let summaries: HcTerminalSummary[] | null = null;
      let allTerminals: HcTerminalSummary[] = [];
      try {
        const raw = await execRunner(hcBin, ['ls', '--json'], { timeout: HC_LS_TIMEOUT_MS });
        const parsed = parseJsonOrNull(raw);
        if (!parsed || typeof parsed !== 'object') {
          summaries = null; // malformed JSON / invalid listing schema — 이전 워커 보존
        } else {
          const terminals = (parsed as Record<string, unknown>)['terminals'];
          if (!Array.isArray(terminals)) {
            summaries = null; // terminals 누락·비정상 — 이전 워커 보존 ({} / {"terminals":null})
          } else {
          allTerminals = terminals
            .map((t) =>
              t && typeof t === 'object' ? normalizeTerminal(t as Record<string, unknown>) : null
            )
            .filter((t): t is HcTerminalSummary => t !== null);
          summaries = allTerminals
            .filter(
              (t) =>
                isObservableTerminal(t) &&
                matchesRepoScope(t.cwd, repoFilterDir) &&
                matchesSessionScope(t, sessionId)
            );
          }
        }
      } catch {
        summaries = null;
      }

      // 2) 상세 캐시 갱신 — 떠난 주소는 증발
      if (summaries) {
        const active = new Set(summaries.map((t) => t.address));
        for (const addr of [...detailCache.keys()]) {
          if (!active.has(addr)) {
            detailCache.delete(addr);
            screenCache.delete(addr);
          }
        }

        // 3) 워커별 상세·활동 수집 (활동 read는 틱당 상한)
        const workers: LiveWorkerInfo[] = [];
        let readCount = 0;
        for (const summary of summaries) {
          let detail = detailCache.get(summary.address);
          if (!detail) {
            try {
              const raw = await execRunner(hcBin, ['get', summary.address, '--json'], {
                timeout: HC_LS_TIMEOUT_MS,
              });
              const parsed = parseJsonOrNull(raw);
              const normalized = parsed ? normalizeTerminal(parsed) : null;
              const fgObj =
                parsed &&
                typeof parsed['foreground'] === 'object' &&
                parsed['foreground'] !== null &&
                !Array.isArray(parsed['foreground'])
                  ? (parsed['foreground'] as Record<string, unknown>)
                  : null;
              detail = normalized
                ? {
                    ...normalized,
                    argv:
                      parsed && Array.isArray(parsed['argv'])
                        ? (parsed['argv'] as unknown[]).filter(
                            (a): a is string => typeof a === 'string'
                          )
                        : undefined,
                    foregroundArgv:
                      fgObj && Array.isArray(fgObj['argv'])
                        ? (fgObj['argv'] as unknown[]).filter(
                            (a): a is string => typeof a === 'string'
                          )
                        : undefined,
                  }
                : { ...summary };
            } catch {
              detail = { ...summary };
            }
          }
          // `hc get` 캐시는 argv·이름 같은 정적 정보만 담당 — status/state/cwd는 매 틱의
          // `hc ls` 요약을 항상 위에 덮어쓴다. 그래야 working→done 전환이 실시간으로
          // 카드·로그에 반영된다(카드 완료 표시·완료 로그는 cli.ts가 이 전환으로 판정).
          detail = {
            ...detail,
            agent: summary.agent ?? detail.agent,
            name: summary.name ?? detail.name,
            parent: summary.parent ?? detail.parent,
            state: summary.state ?? detail.state,
            status: summary.status ?? detail.status,
            cwd: summary.cwd ?? detail.cwd,
          };
          detailCache.set(summary.address, detail);

          // 이중 카드 방지 — 터미널(포그라운드·런치 argv)이 `dg wrap`을 호스팅하면
          // §3.5 ps wrap 탐지가 같은 워커를 cli·model·effort까지 정확히 표시하므로
          // hc 터미널 카드는 만들지 않는다. wrap이 아닌 일반 bash/기타 실행은 유지.
          if (
            isDgWrapHostArgv(detail.foregroundArgv ?? []) ||
            isDgWrapHostArgv(detail.argv ?? [])
          ) {
            continue;
          }

          let screen: string | undefined;
          if (readCount < MAX_ACTIVITY_READS_PER_TICK) {
            readCount++;
            try {
              screen = await execRunner(
                hcBin,
                ['read', summary.address, '--lines', '4'],
                { timeout: HC_READ_TIMEOUT_MS }
              );
              screenCache.set(summary.address, screen);
            } catch {
              screen = undefined;
            }
          }
          const rawScreen = screen ?? screenCache.get(summary.address);
          let worker = inferLiveWorkerSlot(detail, rawScreen);
          // 최상위 활성 AI 세션(워커 규약 밖 리드 등) — Lead 슬롯·표시명·shortModel
          // 폴백을 정규화한다. 워커 규약 터미널은 그대로 둔다.
          if (
            worker &&
            isActiveTopLevelSession(summary) &&
            !isWorkerTerminal(summary)
          ) {
            worker = normalizeTopLevelWorker(worker, summary);
          }
          if (worker && worker.slot === 'lead') {
            const convId =
              extractConversationIdFromArgv(detail.foregroundArgv ?? []) ??
              extractConversationIdFromArgv(detail.argv ?? []);
            if (convId) {
              const info = readConversationTranscriptInfo(convId, subagentCache);
              worker.subagentWarning = info.warning;
              worker.recentIo = info.recentIo;
            } else {
              const txPath =
                worker.cli === 'pi'
                  ? findLatestPiSessionPath(worker.cwd)
                  : worker.cli === 'claude'
                    ? findLatestClaudeSessionPath(worker.cwd)
                    : worker.cli === 'codex'
                      ? findLatestCodexSessionPath(worker.cwd)
                      : worker.cli === 'gemini'
                        ? findLatestGeminiSessionPath(worker.cwd)
                        : null;
              if (txPath) {
                const info = readTranscriptFileInfo(
                  `${worker.cli}:${worker.address}`,
                  txPath,
                  subagentCache
                );
                worker.recentIo = info.recentIo;
              }
            }
            // Claude Code 리드 세션에서 Explore.md 4줄 오버라이드가 없으면 Opus grep 낭비 경고
            if (worker.cli === 'claude' && !worker.subagentWarning) {
              const globalExplore = path.join(os.homedir(), '.claude', 'agents', 'Explore.md');
              const repoExplore = worker.cwd
                ? path.join(worker.cwd, '.claude', 'agents', 'Explore.md')
                : null;
              if (!fs.existsSync(globalExplore) && (!repoExplore || !fs.existsSync(repoExplore))) {
                worker.subagentWarning =
                  'Explore.md 없음 — grep이 Opus로 실행됨 (dgate setup으로 4줄 haiku 강등)';
              }
            }
          }
          if (worker) {
            if (rawScreen && worker.slot !== 'lead') {
              worker.recentOutput = extractRecentOutputLines(rawScreen, 12);
            }
            workers.push(worker);
          }
        }

        // 3.5) `dg wrap`으로 에이전트가 백그라운드로 띄운 워커 — hc 터미널이 아니라 ps 프로세스
        //      트리에서만 보인다. 첫 틱과 짝수 틱(6초 간격)에만 ps를 실행해 스폰 부하를 절반으로 줄인다.
        if (psRunner) {
          const runPsThisTick = psTickCounter % 2 === 0;
          psTickCounter += 1;
          if (!runPsThisTick) {
            // ps를 건너뛰는 홀수 틱에도 로컬 wrap-logs 파일 꼬리는 가볍게 최신화한다.
            for (const w of lastWrapWorkers) {
              const m = /^pid:(\d+)$/.exec(w.address);
              if (m) {
                const tail = readWrapOutputTail(Number(m[1]), defaultWrapLogDir(), 12);
                if (tail.length > 0) {
                  w.recentOutput = tail;
                  w.activity = tail[tail.length - 1]!.slice(0, 96);
                }
              }
            }
            workers.push(...lastWrapWorkers);
          } else {
            try {
              const foundWrap: LiveWorkerInfo[] = [];
              const procs = findWrapProcesses(parsePsRows(await psRunner()));
              if (procs.length > 0) {
                for (const addr of [...pidCache.keys()]) {
                  if (!allTerminals.some((t) => t.address === addr)) pidCache.delete(addr);
                }
                let fetched = 0;
                const pidOwner = new Map<number, HcTerminalSummary>();
                for (const t of allTerminals) {
                  if (t.state !== 'live' || t.parent) continue;
                  let pids = pidCache.get(t.address);
                  if (!pids && fetched < 12) {
                    fetched++;
                    try {
                      const raw = await execRunner(hcBin, ['get', t.address, '--json'], {
                        timeout: HC_LS_TIMEOUT_MS,
                      });
                      const parsed = parseJsonOrNull(raw);
                      const list: number[] = [];
                      if (parsed) {
                        if (typeof parsed['pid'] === 'number') list.push(parsed['pid']);
                        const fg = parsed['foreground'];
                        if (fg && typeof fg === 'object' && !Array.isArray(fg)) {
                          const fp = (fg as Record<string, unknown>)['pid'];
                          if (typeof fp === 'number') list.push(fp);
                        }
                      }
                      pids = list;
                      pidCache.set(t.address, pids);
                    } catch {
                      pids = undefined;
                    }
                  }
                  for (const pid of pids ?? []) pidOwner.set(pid, t);
                }
                for (const p of procs) {
                  const owner = p.ancestors.map((a) => pidOwner.get(a)).find((t) => t !== undefined);
                  if (!owner) {
                    // 고아 wrap(nohup & 등으로 PPID=1)도 미소속 카드로 표시 —
                    // --project 있을 때만 레포 스코프 필터를 적용한다.
                    if (p.projectPath && !matchesRepoScope(p.projectPath, repoFilterDir)) continue;
                    foundWrap.push(wrapProcToUnownedWorker(p));
                    continue;
                  }
                  if (!matchesRepoScope(owner.cwd, repoFilterDir) || !matchesSessionScope(owner, sessionId)) {
                    continue;
                  }
                  foundWrap.push(wrapProcToWorker(p, owner));
                }
              }
              lastWrapWorkers = foundWrap;
              workers.push(...foundWrap);
            } catch {
              // ps 실패는 조용히 무시 — hc 기반 목록은 그대로 유지
              workers.push(...lastWrapWorkers);
            }
          }
        }
        lastWorkers = workers;
      }

      // 4) 병합 방송 — 변경 판정·렌더 제어는 수신자(cli.ts) 책임
      const merged = mergeLiveRosterLabels(labels, opts.getWatchedLead?.() ?? null, lastWorkers);
      if (!stopped) opts.onUpdate(merged);
    } finally {
      inFlight = false;
    }
  }

  // 최초 1회 즉시 실행 후 주기 타이머(언러프 — TUI 종료를 방해하지 않는다)
  void runTick();
  timer = setInterval(() => {
    void runTick();
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      detailCache.clear();
      screenCache.clear();
      pidCache.clear();
    },
    tickNow(): Promise<void> {
      return runTick();
    },
  };
}
