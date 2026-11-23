import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AppState,
  DecisionRoute,
  EffortLevel,
  FocusTarget,
  LogEntry,
  LogFilter,
  RosterDisplayLabels,
  RunMode,
  SwarmWorker,
} from '../types.ts';
import {
  builtinRosterConfig,
  resolveRosterProfile,
  type RoleWorkerSpec,
  type RosterProfile,
} from '../decision/roster.ts';
import { readTelemetrySnapshot } from '../decision/telemetry.ts';
import type { AgentColorKey } from '../theme.ts';

const FOCUS_ORDER: readonly FocusTarget[] = ['advisor', 'main', 'neon', 'decision', 'swarm', 'logs'];

const WORKER_TARGETS = [
  'src/api/spec.ts',
  'src/api/router.ts',
  'src/core/session.ts',
  'src/db/tx.ts',
  'src/auth/token.ts',
  'tests/api/spec.test.ts',
  'tests/fixtures/mock_symbol.ts',
  'packages/cli/main.ts',
  'src/tools/grep.ts',
  'src/tools/patch.ts',
] as const;

const WORKER_ROLES: ReadonlyArray<SwarmWorker['role']> = [
  'search',
  'grep',
  'audit',
  'index',
  'verify',
];

export const TRIGGER_LABELS = ['계획 확정 전', '같은 오류 2회', '완료 전'] as const;

/** 로그 필터 키 → 화면 표시용 역할 이름 (모델 무관) */
export const LOG_FILTER_LABELS: Record<LogFilter, string> = {
  all: '전체',
  argon: 'Lead',
  hydrogen: 'Workers',
  decision: 'Decision Gate',
  neon: 'Verifier',
  carbon: 'Advisor',
};

/**
 * 역할 스펙 → 간결 표기 태그 (예: 'pi:glm-5.3', 'pi:deepseek-v4.1-flash',
 * 'devin', 'claude:sonnet-4-6'). provider 프리픽스('provider/model')와
 * 'deepseek-deepseek-' 같은 중첩 접두, 'claude-sonnet-' 같은 cli 접두를 정리한다.
 */
export function formatRoleBadge(spec: RoleWorkerSpec | undefined): string {
  if (!spec) return '—';
  const raw = spec.model?.trim();
  if (!raw) return spec.cli;
  let short = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  short = short.replace(/^([A-Za-z0-9]+)-\1-/, '$1-');
  const cliPrefix = `${spec.cli}-`;
  if (short.startsWith(cliPrefix)) short = short.slice(cliPrefix.length);
  return `${spec.cli}:${short}`;
}

/** 활성 roster 프로필 → TUI 표시용 라벨 묶음 */
export function rosterLabelsFromProfile(
  profileName: string,
  rosterSource: string,
  profile: RosterProfile
): RosterDisplayLabels {
  return {
    profileName,
    rosterSource,
    lead: formatRoleBadge(profile.roles.lead),
    explore: formatRoleBadge(profile.roles.explore),
    coder: formatRoleBadge(profile.roles.coder),
    verifier: formatRoleBadge(profile.roles.verifier),
    advisor: formatRoleBadge(profile.roles.advisor),
  };
}

/**
 * 활성 roster 프로필을 AppState 표시 필드에 반영한다.
 * - rosterLabels: 5개 역할 슬롯 배지
 * - modelName/modelFlag: lead 슬롯 태그 + 실제 --model 플래그
 * - neonModelName/neonModelFlag: verifier 슬롯 태그 + 실제 --model 플래그
 * - cards[].model: 스웜 워커 카드는 explore 슬롯 배지
 */
export function applyRosterToState(
  state: AppState,
  profileName: string,
  rosterSource: string,
  profile: RosterProfile
): void {
  state.rosterLabels = rosterLabelsFromProfile(profileName, rosterSource, profile);
  const lead = profile.roles.lead;
  const verifier = profile.roles.verifier;
  state.modelName = state.rosterLabels.lead;
  state.modelFlag = lead?.model ? `--model ${lead.model}` : state.rosterLabels.lead;
  state.neonModelName = state.rosterLabels.verifier;
  state.neonModelFlag = verifier?.model
    ? `--model ${verifier.model}`
    : state.rosterLabels.verifier;
  for (const card of state.cards) {
    card.model = state.rosterLabels.explore;
  }
}

/**
 * UI 표시용 라우트 우선 정렬(N3): forcedSplit 최우선 → p<0.70(split) 차우선 → 원래 순서 보존.
 * 좁은 패널에서 slice 해도 delegate_swarm(4번째)이나 강제 분기 경고가 은닉되지 않게 한다.
 */
export function sortRoutesForDisplay(routes: readonly DecisionRoute[]): DecisionRoute[] {
  return routes
    .map((route, idx) => ({ route, idx }))
    .sort((a, b) => {
      const rank = (e: { route: DecisionRoute; idx: number }): number =>
        e.route.forcedSplit === true ? 0 : e.route.p < 0.7 ? 1 : 2;
      return rank(a) - rank(b) || a.idx - b.idx;
    })
    .map((e) => e.route);
}

/**
 * TUI/워치 모드용 읽기전용 SQLite 구독 헬퍼(§5.3 W2-B).
 *
 * `readTelemetrySnapshot`(readOnly + query_only)만 경유하며 DB 미존재·오류 시 조용히 폴백해
 * 기존 state.routes를 유지한다. `--demo` 모드는 DB 접근 자체를 하지 않는다(완전 격리).
 *
 * @returns live DB에서 로드했으면 true, 폴백·데모 no-op면 false
 */
export function syncStateFromDecisionDb(
  state: AppState,
  dbPath: string,
  projectCwd: string
): boolean {
  if (state.mode === 'demo') return false;
  try {
    const snapshot = readTelemetrySnapshot(dbPath, projectCwd);
    state.routes = snapshot.routes;
    const split = snapshot.routes.filter((r) => r.forcedSplit === true || r.p < 0.7).length;
    state.sharpCount = snapshot.routes.length - split;
    state.splitCount = split;
    return snapshot.live;
  } catch {
    return false;
  }
}

export function createInitialWorkers(activeCount = 42, maxCount = 50): SwarmWorker[] {
  const workers: SwarmWorker[] = [];
  for (let i = 1; i <= maxCount; i++) {
    const isRunning = i <= activeCount;
    const isDone = !isRunning && i <= activeCount + 4;
    workers.push({
      id: i,
      role: WORKER_ROLES[(i - 1) % WORKER_ROLES.length]!,
      target: WORKER_TARGETS[(i - 1) % WORKER_TARGETS.length]!,
      progress: isDone ? 100 : isRunning ? ((i * 19) % 88) + 8 : 0,
      status: isDone ? 'done' : isRunning ? 'running' : 'idle',
    });
  }
  return workers;
}

export function formatCompactPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath === home) return '~';
  if (fullPath.startsWith(home + path.sep)) {
    return '~/' + path.relative(home, fullPath);
  }
  return fullPath;
}

export function formatTokensCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function createInitialState(mode: RunMode = 'demo'): AppState {
  const isLive = mode === 'live' || mode === 'watch';
  const isWatch = mode === 'watch';
  // 초기 라우트도 SSOT 확장 필드(id/basis/samples/consecutiveErrors/forcedSplit)를 갖는다.
  // delegate_swarm(스웜 위임) 4번째 라우트 포함 — 집계는 라우트 수에 관계없이 계산된다.
  const initialRoutes: DecisionRoute[] = isLive
    ? [
        { name: '어느 파일', p: 0.9, targetHint: '대기', id: 'file_select', basis: 'prior', samples: 0, consecutiveErrors: 0, forcedSplit: false },
        { name: '어느 도구', p: 0.9, targetHint: '대기', id: 'tool_select', basis: 'prior', samples: 0, consecutiveErrors: 0, forcedSplit: false },
        { name: '재시도 또는 중단', p: 0.9, targetHint: '대기', id: 'retry_or_abort', basis: 'prior', samples: 0, consecutiveErrors: 0, forcedSplit: false },
        { name: '스웜 위임', p: 0.9, targetHint: '대기', id: 'delegate_swarm', basis: 'prior', samples: 0, consecutiveErrors: 0, forcedSplit: false },
      ]
    : [
        { name: '어느 파일', p: 0.89, targetHint: 'src/api/spec.ts', id: 'file_select', basis: 'prior', samples: 2, consecutiveErrors: 0, forcedSplit: false },
        { name: '어느 도구', p: 0.94, targetHint: 'grep', id: 'tool_select', basis: 'prior', samples: 2, consecutiveErrors: 0, forcedSplit: false },
        { name: '재시도 또는 중단', p: 0.88, targetHint: 'continue', id: 'retry_or_abort', basis: 'prior', samples: 2, consecutiveErrors: 0, forcedSplit: false },
        { name: '스웜 위임', p: 0.62, targetHint: '스웜', id: 'delegate_swarm', basis: 'prior', samples: 2, consecutiveErrors: 0, forcedSplit: false },
      ];
  const initialSplit = initialRoutes.filter((r) => r.forcedSplit === true || r.p < 0.7).length;
  // 역할·모델 기본 라벨은 내장 roster(quota-saver/zero-agy 계열)에서 파생한다 —
  // 레거시 gemini-4-* 하드코딩 제로. cli.ts가 시작 시 실제 roster.json으로 덮어쓴다.
  const builtinRoster = builtinRosterConfig();
  const builtinProfile = resolveRosterProfile(builtinRoster, builtinRoster.defaultProfile);
  const initialRosterLabels = rosterLabelsFromProfile(
    builtinProfile.name,
    'builtin',
    builtinProfile.profile
  );
  const leadSpec = builtinProfile.profile.roles.lead;
  const verifierSpec = builtinProfile.profile.roles.verifier;
  return {
    mode,
    paused: false,
    simTime: 0,
    tickCount: 0,

    cwd: isLive ? formatCompactPath(process.cwd()) : '~/app',
    sessionId: isLive ? Math.floor(Date.now() % 1000) : 121,
    rosterLabels: initialRosterLabels,
    modelFlag: leadSpec?.model ? `--model ${leadSpec.model}` : initialRosterLabels.lead,
    modelName: initialRosterLabels.lead,
    backendKind: 'none',
    conversationId: null,
    agentBusy: false,
    totalTokensUsed: 0,
    consecutiveToolErrors: 0,
    latestResponse: '',
    responseScrollOffset: 0,

    argonBuilds: isLive ? 0 : 1,
    swarmActive: isLive ? 0 : 42,
    swarmMax: 50,
    neonVerified: 0,
    carbonCalls: isLive ? 0 : 1,
    totalForks: isLive ? 0 : 1286,

    mainSummary: isWatch
      ? '실행 중인 agy 세션 트랜스크립트 감시 중…'
      : isLive
        ? '/ 또는 i 를 눌러 에이전트에 작업을 지시하세요'
        : '코드를 수정하고 테스트를 실행',
    effort: 'high',
    effortKnown: !isWatch,
    phase: isWatch ? '세션 감시' : isLive ? '대기 중' : '탐색',
    backSummary: isLive
      ? '응답 완료 시 r 키로 전문 확인'
      : '검토 + 확인 · review + verify',

    neonModelName: initialRosterLabels.verifier,
    neonModelFlag: verifierSpec?.model
      ? `--model ${verifierSpec.model}`
      : initialRosterLabels.verifier,
    neonState: 'idle',
    neonProgress: 0,
    neonLabel: '',
    neonSummary: isWatch
      ? '세션 로그 수신 대기 중'
      : isLive
        ? '대기 중 — /neon <검증 내용> 으로 독립 교차 검증 실행'
        : '대기 · 호출 시 독립 검증',
    neonHistory: [],

    advisorState: '대기 중',
    activeTrigger: -1,
    latestAdvice: isWatch
      ? '» 세션 트랜스크립트 연결 대기 중'
      : isLive
        ? '» 대기 중 — /carbon <질문> 또는 오류·완료 시 자문'
        : '» 인증·DB/트랜잭션 호출을 계획에서 제외, 토큰 약 120k 읽음',
    tokensRead: isLive ? '0' : '120k',
    adviceHistory: isLive
      ? []
      : [
          {
            time: '23:48:22',
            triggerIndex: 0,
            triggerLabel: '계획 확정 전',
            text: '인증·DB/트랜잭션 호출을 계획에서 제외, 토큰 약 120k 읽음',
            tokensRead: '120k',
          },
        ],

    routes: initialRoutes,
    sharpCount: initialRoutes.length - initialSplit,
    splitCount: initialSplit,

    cards: [
      {
        name: 'search',
        model: initialRosterLabels.explore,
        progress: isLive ? 0 : 64,
        description: isLive ? '파일·구조 탐색 대기' : '저장소 구조를 파악합니다',
        status: isLive ? 'idle' : 'running',
      },
      {
        name: 'grep',
        model: initialRosterLabels.explore,
        progress: isLive ? 0 : 100,
        description: isLive ? '코드 패턴 검색 대기' : '호출 위치를 찾습니다',
        status: isLive ? 'idle' : 'done',
      },
      {
        name: 'audit',
        model: initialRosterLabels.explore,
        progress: isLive ? 0 : 42,
        description: isLive ? '명령·수정 검증 대기' : '워크트리에서 차이를 비교합니다',
        status: isLive ? 'idle' : 'running',
      },
    ],
    workers: createInitialWorkers(isLive ? 0 : 42, 50),

    logs: [],
    logScrollOffset: 0,
    logFilter: 'all',

    focus: 'main',
    inputActive: false,
    inputValue: '',
    statusFlash: null,
    statusFlashUntil: 0,
    modal: 'none',
    compactTab: 0,

    cardSelect: 0,
    leadAddress: null,
    terminalView: null,
    terminalOutput: [],
  };
}

export function formatNowHHMMSS(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function appendLog(
  state: AppState,
  agent: string,
  color: AgentColorKey,
  message: string,
  time?: string
): void {
  const nextId = (state.logs[state.logs.length - 1]?.id ?? 0) + 1;
  state.logs.push({
    id: nextId,
    time: time ?? formatNowHHMMSS(),
    agent,
    color,
    message,
  });
  if (state.logs.length > 300) {
    state.logs.splice(0, state.logs.length - 300);
  }
}

export function getFilteredLogs(state: AppState): LogEntry[] {
  if (state.logFilter === 'all') return state.logs;
  return state.logs.filter((entry) => {
    const lower = entry.agent.toLowerCase();
    switch (state.logFilter) {
      case 'argon':
        return lower.includes('argon') || lower.includes('lead');
      case 'hydrogen':
        return lower.includes('hydrogen') || lower.includes('worker');
      case 'decision':
        return lower.includes('decision');
      case 'neon':
        return lower.includes('neon') || lower.includes('verifier');
      case 'carbon':
        return lower.includes('carbon') || lower.includes('advisor');
    }
  });
}

export function cycleFocus(state: AppState, reverse = false): void {
  const idx = FOCUS_ORDER.indexOf(state.focus);
  const delta = reverse ? -1 : 1;
  const next = (idx + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length;
  state.focus = FOCUS_ORDER[next]!;
}

export function flashStatus(state: AppState, msg: string, durationMs = 2600): void {
  state.statusFlash = msg;
  state.statusFlashUntil = Date.now() + durationMs;
}

export function effortToGauge(effort: EffortLevel): string {
  switch (effort) {
    case 'low':
      return '▮▯▯▯ low';
    case 'medium':
      return '▮▮▯▯ medium';
    case 'high':
      return '▮▮▮▯ high';
    case 'max':
      return '▮▮▮▮ max+';
  }
}
