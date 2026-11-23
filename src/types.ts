import type { AgentColorKey } from './theme.ts';

export type QuadRole = 'argon' | 'carbon' | 'neon' | 'hydrogen' | 'all';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export type FocusTarget = 'advisor' | 'main' | 'neon' | 'decision' | 'swarm' | 'logs';

export type ModalKind =
  | 'none'
  | 'help'
  | 'swarm'
  | 'advisor'
  | 'neon'
  | 'decision'
  | 'logs'
  | 'response'
  | 'terminal';

export type CompactTab = 0 | 1 | 2 | 3; // 0: 파이프라인, 1: 스웜, 2: Advisor, 3: 세션 기록

export type LogFilter = 'all' | 'argon' | 'hydrogen' | 'decision' | 'neon' | 'carbon';

export type NeonStatus = 'idle' | 'run' | 'pass' | 'fail';

/** Decision 게이트 고정 라우트 열거형 (§4.1 — 4종만 허용) */
export type RouteId = 'file_select' | 'tool_select' | 'retry_or_abort' | 'delegate_swarm';

/** 사후확률 근거 표지: n_raw < N_min(=5) 구간은 prior, 이후 measured */
export type DecisionBasis = 'prior' | 'measured';

export type RunMode = 'demo' | 'stream' | 'live' | 'watch';

export type BackendKind = 'agy' | 'gemini-api' | 'none';

export interface NeonCheckRecord {
  time: string;
  label: string;
  status: 'run' | 'pass' | 'fail';
  summary: string;
  model: string;
}

export interface DecisionRoute {
  name: string;
  p: number; // 0.0 ~ 1.0 (p >= 0.70 => sharp, p < 0.70 => split)
  targetHint?: string;
  // SQLite SSOT 확장 선택 필드 (W1 — §5.3)
  id?: RouteId;
  basis?: DecisionBasis;
  samples?: number;
  consecutiveErrors?: number;
  forcedSplit?: boolean;
}

export interface SwarmCard {
  name: string;
  model: string;
  progress: number; // 0 ~ 100
  description: string;
  status: 'running' | 'done' | 'idle' | 'error';
  /** 라이브 워커 실측 경과 시간(초) — 렌더에서 MM:SS로 표시. 폴백 카드에는 없음. */
  elapsedSec?: number;
  /** `hc ls --json` 실측 턴 카운터 — 라이브 카드 텔레메트리(선택). */
  turn?: number;
  /** 라이브 워커 hc 터미널 주소 — 경과 추적·디버그 식별용(선택). */
  address?: string;
  /** 워커의 최근 출력 줄(`dg wrap` 실시간 로그 또는 `hc read` 꼬리, 시크릿 리덕션 완료). */
  recentOutput?: string[];
  /** pid:N(wrap) 워커를 소유한 hc 터미널 주소 — 터미널 상세 뷰가 이 터미널을 보여준다. */
  ownerAddress?: string;
}

/** 터미널 상세 뷰 대상 — Enter로 연 역할 카드 1개의 터미널 식별 정보. */
export interface TerminalViewTarget {
  /** 화면 식별용 카드 이름(예: '[repo] w-pi-x · pi:glm-5.3') */
  name: string;
  /** hc 터미널 주소 — 일반 워커는 자기 주소, pid:N wrap 워커는 소유 hc 주소. */
  address: string;
  /** 원본 카드 주소(표시용 — pid:1234 등). address와 다를 수 있다. */
  originAddress: string;
  /** 모델·cli 요약 라인 */
  model: string;
  /** 카드 상태 라벨 */
  status: string;
  /** 출력 소스 — 'hc'면 `hc read` 라이브 폴, 'wrap-log'면 wrap 로그 파일 꼬리 폴백. */
  source: 'hc' | 'wrap-log';
}

export interface SwarmWorker {
  id: number; // 1..50
  role: 'search' | 'grep' | 'audit' | 'index' | 'verify';
  target: string;
  progress: number;
  status: 'running' | 'done' | 'idle';
}

export interface AdviceRecord {
  time: string;
  triggerIndex: 0 | 1 | 2;
  triggerLabel: string;
  text: string;
  tokensRead: string;
}

export interface LogEntry {
  id: number;
  time: string;
  agent: string;
  color: AgentColorKey;
  message: string;
}

/**
 * 활성 roster.json 바인딩의 TUI 표시용 라벨 묶음.
 * 각 역할 슬롯 값은 `formatRoleBadge`가 만든 간결 태그
 * (예: 'pi:glm-5.3', 'pi:deepseek-v4.1-flash', 'devin', 'claude:sonnet-4-6').
 */
export interface RosterDisplayLabels {
  /** 활성 roster 프로필 이름 (예: 'zero-agy', 'quota-saver') */
  profileName: string;
  /** roster 로딩 출처: flag | env | project | global | builtin */
  rosterSource: string;
  lead: string;
  explore: string;
  coder: string;
  verifier: string;
  advisor: string;
}

export interface AppState {
  mode: RunMode;
  paused: boolean;
  simTime: number; // 초 단위 (데모는 0~40 순환, 라이브는 연속 증가)
  tickCount: number;

  // 세션 메타
  cwd: string;
  sessionId: number;
  /** `--repo <dir>` 스코프 지정 시 레포 표시명(예: 'Gemini_trick'). 미지정 null — watch 헤더는 '전체' 표기 */
  repoScopeLabel?: string | null;
  /** 활성 roster.json 역할·모델 바인딩 라벨 (리드·탐색·코더·검증·자문) */
  rosterLabels: RosterDisplayLabels;
  modelFlag: string;
  modelName: string;
  backendKind: BackendKind;
  conversationId: string | null;
  agentBusy: boolean;
  totalTokensUsed: number;
  consecutiveToolErrors: number;
  latestResponse: string;
  responseScrollOffset: number;

  // 상단 배지 & 메트릭
  argonBuilds: number;
  /** 라이브/워치 관제의 활성 세션 역할별 카운트(GPUI 파티션 계약). 미설정(undefined)이면 기존 트랜스크립트 카운터 사용 */
  liveSessionCounts?: { lead: number; workers: number; verifiers: number; advisors: number };
  swarmActive: number;
  swarmMax: number;
  neonVerified: number;
  carbonCalls: number;
  totalForks: number;

  // Lead 메인 & 리턴 패널
  mainSummary: string;
  effort: EffortLevel;
  /** watch 모드에서 외부 세션의 실시간 effort를 모를 때 false — 허위 게이지 출력 차단 */
  effortKnown?: boolean;
  /** watch 모드 실측 하단 텔레메트리 (`cli · model · effort`), roster.json 미사용 */
  leadTelemetry?: string | null;
  verifierTelemetry?: string | null;
  advisorTelemetry?: string | null;
  /** 내장 서브에이전트(invoke_subagent) 실행 감지 시 리드 카드 경고 배지 */
  subagentWarning?: string | null;
  phase: string;
  backSummary: string;

  // Verifier 교차 검증 패널
  neonModelName: string;
  neonModelFlag: string;
  neonState: NeonStatus;
  neonProgress: number; // 0 ~ 100
  neonLabel: string;
  neonSummary: string;
  neonHistory: NeonCheckRecord[];

  // Advisor 자문 패널
  advisorState: '대기 중' | '자문 중';
  activeTrigger: -1 | 0 | 1 | 2; // -1: 비활성, 0: 계획 확정 전, 1: 같은 오류 2회, 2: 완료 전
  latestAdvice: string;
  tokensRead: string;
  adviceHistory: AdviceRecord[];

  // Decision Gate 분기 패널
  routes: DecisionRoute[];
  sharpCount: number;
  splitCount: number;

  // Workers 스웜 패널
  cards: SwarmCard[];
  /**
   * 라이브 hc 워커 카드(Live TUI Sync v2) — `--watch` 실시간 동기화 결과 표시용.
   * 길이 가변(0~N)이므로 트랜스크립트 3슬롯 계약을 쓰는 `cards`를 대체하지 않고
   * 별도 슬롯에 담는다. 렌더는 `liveWorkers?.length > 0`일 때 이 값을 우선 보여주고,
   * 없으면 기존 `cards`로 폴백한다.
   */
  liveWorkers?: SwarmCard[];
  workers: SwarmWorker[];

  // 세션 기록
  logs: LogEntry[];
  logScrollOffset: number; // 0이면 최신 줄 고정, 양수면 과거로 스크롤
  logFilter: LogFilter;

  /** 레포 마크다운 체크박스 실측 태스크 진행률(watch/live). 없으면 null — 가짜 진행률 금지 */
  taskProgress?: { sourceName: string; done: number; total: number; pct: number } | null;

  // UI 인터랙션 상태
  focus: FocusTarget;
  inputActive: boolean;
  inputValue: string;
  statusFlash: string | null;
  statusFlashUntil: number;
  modal: ModalKind;
  compactTab: CompactTab;

  // ---- 터미널 상세 뷰 (Enter: 터미널 보기) ----
  /** Workers 카드 선택 인덱스 — swarm 포커스에서 ←/→·숫자로 이동, Enter로 상세 뷰 오픈. */
  cardSelect: number;
  /** 관측 중인 리드 hc 터미널 주소 — Lead 카드 Enter로 터미널 상세 뷰를 열 때 사용. */
  leadAddress: string | null;
  /** 터미널 상세 뷰(modal==='terminal') 대상 카드 식별 정보. */
  terminalView: TerminalViewTarget | null;
  /** 터미널 상세 뷰 본문 라인 — `hc read`/wrap 로그 꼬리를 ~1초 주기로 갱신. */
  terminalOutput: string[];
}

/**
 * 실시간 JSONL 이벤트 스트림 프로토콜 (stdin 또는 --file 입력)
 */
export type StreamEvent =
  | {
      type: 'session';
      sessionId?: number;
      cwd?: string;
      model?: string;
      effort?: EffortLevel;
    }
  | {
      type: 'phase';
      phase: string;
      summary?: string;
      backSummary?: string;
      argonBuilds?: number;
    }
  | {
      type: 'decision';
      forks?: number;
      routes: Array<{
        name: string;
        p: number;
        targetHint?: string;
        id?: RouteId;
        basis?: DecisionBasis;
        samples?: number;
        consecutiveErrors?: number;
        forcedSplit?: boolean;
      }>;
    }
  | {
      type: 'swarm';
      active?: number;
      max?: number;
      cards?: Array<{
        name: string;
        model?: string;
        progress: number;
        description?: string;
        status?: 'running' | 'done' | 'idle' | 'error';
      }>;
    }
  | {
      type: 'advisor';
      trigger: -1 | 0 | 1 | 2;
      state?: '대기 중' | '자문 중';
      calls?: number;
      tokens?: string;
      advice?: string;
    }
  | {
      type: 'neon';
      state: NeonStatus;
      progress?: number;
      label?: string;
      verified?: number;
      summary?: string;
      model?: string;
    }
  | {
      type: 'log';
      time?: string;
      agent: string;
      color?: AgentColorKey;
      message: string;
    }
  | {
      type: 'reset';
    };

// ─────────────────────────────────────────────────────────────────────────────
// 라이브 워커 슬롯 — TUI 파티션(Lead/Workers/Verifier/Advisor)·`dg wrap --role`·
// `HERDR_ROLE`·세션명/라벨 접두가 함께 쓰는 단일 어휘. 역할 이름이 곳마다 달라져
// (`verify` vs `verifier` vs `neon`) verifier가 coder로 오분류되어 Workers 카드에
// 뜨던 사고를 막기 위해 이 표 하나만 믿는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 라이브 워커 슬롯 5종. coder는 라벨로 유도하지 않는다(명시 `--role`/`HERDR_ROLE`만). */
export const LIVE_WORKER_SLOTS = ['lead', 'explore', 'coder', 'verifier', 'advisor'] as const;
export type LiveWorkerSlot = (typeof LIVE_WORKER_SLOTS)[number];

/** 슬롯 별칭 — herdr 관문 이름 `carbon`은 advisor 슬롯. */
const LIVE_WORKER_SLOT_ALIASES: Readonly<Record<string, LiveWorkerSlot>> = { carbon: 'advisor' };

/**
 * `--role`·`HERDR_ROLE` 값 → 슬롯. 대소문자·공백은 무시하고, 미등값은 null(
 * 호출자가 라벨 폴백·사용자 오류 중 무엇을 할지 정한다).
 */
export function parseLiveWorkerSlot(value: string | null | undefined): LiveWorkerSlot | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if ((LIVE_WORKER_SLOTS as readonly string[]).includes(v)) return v as LiveWorkerSlot;
  return LIVE_WORKER_SLOT_ALIASES[v] ?? null;
}

/**
 * 세션명·`dg wrap --label`의 역할 접수 어휘 — `<역할>-<주제>` 규약(`verify-stage1`·
 * `research-hcdesign`·`advisor-g3`)과 herdr-quad-launch의 agy 세션명(`argon`/`carbon`/`neon`)을 포함한다.
 * lead는 세션명으로만 의미가 있고(라벨 `lead-…`로 wrap 워커가 리드가 되지는 않는다) 나머지 4종을 라벨에서 유도한다.
 */
const SLOT_NAME_PREFIXES: Readonly<Record<LiveWorkerSlot, readonly string[]>> = {
  lead: ['lead', 'argon'],
  verifier: ['verifier', 'verify', 'neon', '검증'],
  explore: ['explore', 'exp', 'research', '탐색', '조사'],
  advisor: ['advisor', 'carbon', '자문'],
  coder: [],
};

/**
 * 이름(세션명·라벨)의 **접두**로 슬롯을 판정한다. 어느 역할 접두도 아니면 null.
 * - ASCII 접두는 뒤에 `-`·`_`·숫자·끝이 와야 한다(`expandex`≠exp, `verifier`≠verify).
 * - 한글 접두는 구분자 없이 붙여도 인정한다(`검증-g1`·`검증g1`).
 * - `w-` 접두는 hc 세션명 규약상 벗겨고 본다.
 * 부분 문자열 판정을 쓰지 않는다 — `fix-rust-verifier-observations`처럼 **주제에 역할어가
 * 들어간 coder 라벨**을 verifier로 오분류하면 Workers 카드에서 사라지고 검증 패널을 오염시킨다.
 */
export function inferLiveWorkerSlotFromName(name: string | null | undefined): LiveWorkerSlot | null {
  if (!name) return null;
  const n = name.trim().toLowerCase().replace(/^w-/, '');
  if (n.length === 0) return null;
  for (const [slot, prefixes] of Object.entries(SLOT_NAME_PREFIXES)) {
    for (const p of prefixes) {
      if (isAsciiPrefix(p)) {
        if (new RegExp(`^${p}(?:[-_\\d]|$)`).test(n)) return slot as LiveWorkerSlot;
      } else if (n.startsWith(p)) {
        return slot as LiveWorkerSlot;
      }
    }
  }
  return null;
}

function isAsciiPrefix(p: string): boolean {
  return /^[a-z]+$/.test(p);
}
