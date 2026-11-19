import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AppState,
  EffortLevel,
  FocusTarget,
  LogEntry,
  RunMode,
  SwarmWorker,
} from '../types.ts';
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
  return {
    mode,
    paused: false,
    simTime: 0,
    tickCount: 0,

    cwd: isLive ? formatCompactPath(process.cwd()) : '~/app',
    sessionId: isLive ? Math.floor(Date.now() % 1000) : 121,
    modelFlag: isLive ? '--model gemini-4-argon-high' : '--model argon',
    modelName: 'gemini-4-argon-high',
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
    phase: isWatch ? '세션 감시' : isLive ? '대기 중' : '탐색',
    backSummary: isLive
      ? '응답 완료 시 r 키로 전문 확인'
      : '검토 + 확인 · review + verify',

    neonModelName: 'gemini-4-neon-high',
    neonModelFlag: isLive ? '--model gemini-4-neon-high' : '--model gemini-neon',
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

    routes: isLive
      ? [
          { name: '어느 파일', p: 0.9, targetHint: '대기' },
          { name: '어느 도구', p: 0.9, targetHint: '대기' },
          { name: '재시도 또는 중단', p: 0.9, targetHint: '대기' },
        ]
      : [
          { name: '어느 파일', p: 0.89, targetHint: 'src/api/spec.ts' },
          { name: '어느 도구', p: 0.94, targetHint: 'grep' },
          { name: '재시도 또는 중단', p: 0.88, targetHint: 'continue' },
        ],
    sharpCount: isLive ? 3 : 2,
    splitCount: isLive ? 0 : 1,

    cards: [
      {
        name: 'search',
        model: 'Hydrogen',
        progress: isLive ? 0 : 64,
        description: isLive ? '파일·구조 탐색 대기' : '저장소 구조를 파악합니다',
        status: isLive ? 'idle' : 'running',
      },
      {
        name: 'grep',
        model: 'Hydrogen',
        progress: isLive ? 0 : 100,
        description: isLive ? '코드 패턴 검색 대기' : '호출 위치를 찾습니다',
        status: isLive ? 'idle' : 'done',
      },
      {
        name: 'audit',
        model: 'Hydrogen',
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
        return lower.includes('argon');
      case 'hydrogen':
        return lower.includes('hydrogen');
      case 'decision':
        return lower.includes('decision');
      case 'neon':
        return lower.includes('neon');
      case 'carbon':
        return lower.includes('carbon');
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
      return '▮▮▮▮ high';
    case 'max':
      return '▮▮▮▮ max+';
  }
}
