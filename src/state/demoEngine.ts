import {
  applyEffortToModelName,
  inferEffortFromModel,
} from '../backend/agentRunner.ts';
import type { AgentColorKey } from '../theme.ts';
import type { AppState, EffortLevel, NeonCheckRecord, NeonStatus } from '../types.ts';
import { LOG_FILTER_LABELS, TRIGGER_LABELS, appendLog, flashStatus } from './store.ts';

const LOOP = 40;
const STEP = LOOP / 24;
const at = (beat: number): number => beat * STEP;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t: number, start: number, dur: number): number => clamp01((t - start) / dur);

/**
 * gemini_sub_neon.html 원본의 24개 시나리오 비트(beats) 정의 (24 × 1.667초 = 40초)
 */
export const DEMO_BEATS: ReadonlyArray<readonly [string, AgentColorKey, string]> = [
  ['Lead', 'orange', '작업 시작 — 수정 범위와 테스트를 확인'],
  ['Decision Gate', 'green', '어느 파일 → src/api/spec.ts  p=0.89 sharp → code'],
  ['Worker search', 'blue', '모듈 4개를 파악  p=0.55 split → Lead'],
  ['Decision Gate', 'green', '어느 도구 → grep  p=0.94 sharp → code'],
  ['Worker grep', 'blue', '호출 위치 14개를 찾음'],
  ['Advisor', 'purple', '계획 확정 전 — 세션 전체를 읽는 중'],
  ['Advisor', 'purple', '인증·DB/트랜잭션 호출 제외 → Lead에 조언'],
  ['Verifier', 'neon', '계획 교차 검토 완료 — 영향 범위 누락 없음'],
  ['Lead', 'orange', '계획 확정 · 수정 적용 + 테스트 실행'],
  ['Worker audit', 'blue', '워크트리 차이 비교 · fixture 확인'],
  ['Lead', 'orange', 'mock_missing_symbol · 같은 오류 2회'],
  ['Advisor', 'purple', '같은 오류 2회 — 세션 전체를 읽는 중'],
  ['Advisor', 'purple', '잘못된 fixture → Lead가 수정'],
  ['Decision Gate', 'green', '재시도 또는 중단 → 중단 후 질문  p=0.42 split → Lead'],
  ['Lead', 'orange', 'fixture 수정 완료 · 테스트 28/28 통과'],
  ['Advisor', 'purple', '완료 전 — 변경 사항과 결과를 읽는 중'],
  ['Verifier', 'neon', '변경 diff 독립 재검증 시작'],
  ['Worker audit', 'blue', '차이 비교 완료 · 누락 없음'],
  ['Decision Gate', 'green', '어느 도구 → test  p=0.94 sharp → code'],
  ['Verifier', 'neon', '회귀 없음 · 28/28 재현 → Lead에 전달'],
  ['Advisor', 'purple', '검토 완료 · 조언을 Lead에 전달'],
  ['Lead', 'orange', '검토 + 확인 · 테스트 통과'],
  ['Worker search', 'blue', '다음 작업을 위한 탐색 재개'],
  ['Lead', 'orange', '세션 정리 · 다음 요청 대기'],
];

const ADV_WINDOWS = [
  { name: '계획 확정 전', on: at(5), off: at(8), gain: 155 },
  { name: '같은 오류 2회', on: at(11), off: at(13), gain: 138 },
  { name: '완료 전', on: at(15), off: at(21), gain: 210 },
] as const;

const ADVICE_ENTRIES = [
  { at: at(6), text: '» 인증·DB/트랜잭션 호출을 계획에서 제외, 토큰 약 120k 읽음' },
  { at: at(12), text: '» 잘못된 fixture, 일상 턴' },
  { at: at(20), text: '» 테스트 통과 확인, 변경 범위를 검토' },
] as const;

const PHASES: ReadonlyArray<readonly [number, string]> = [
  [0, '탐색'],
  [at(5), '계획 확정'],
  [at(9), '오류 수정'],
  [at(15), '검증 중'],
  [at(22), '완료'],
];

// Verifier 교차 검증 구간: on → 진행 → done(✓) → off(대기)
const NEON_WINDOWS = [
  {
    on: 9.0,
    done: at(7),
    off: at(7) + 2.4,
    label: '계획 교차 검토',
    summary: '계획 교차 검토 완료 — 영향 범위 누락 없음',
    time: '23:48:24',
  },
  {
    on: at(16),
    done: at(19),
    off: at(19) + 2.6,
    label: '변경 diff 재검증',
    summary: '회귀 없음 · 28/28 재현 → Lead에 전달',
    time: '23:48:48',
  },
] as const;

const ROUTE_NAMES = ['어느 파일', '어느 도구', '재시도 또는 중단', '스웜 위임'] as const;
const ROUTE_MATRIX: ReadonlyArray<ReadonlyArray<number>> = [
  [0.81, 0.89, 0.94, 0.64],
  [0.45, 0.94, 0.58, 0.83],
  [0.88, 0.82, 0.91, 0.8],
  [0.72, 0.66, 0.78, 0.86],
];

const CARD_SPECS = [
  { name: 'search', desc: '저장소 구조를 파악합니다' },
  { name: 'grep', desc: '호출 위치를 찾습니다' },
  { name: 'audit', desc: '워크트리에서 차이를 비교합니다' },
] as const;

export interface DemoController {
  manualTriggerUntil: number;
  manualTriggerValue: -1 | 0 | 1 | 2;
  manualNeonStart: number;
  manualNeonUntil: number;
  manualNeonLabel: string;
  lastSeq: number;
  customLogs: Array<{ time: string; agent: string; color: AgentColorKey; message: string }>;
}

export function createDemoController(): DemoController {
  return {
    manualTriggerUntil: 0,
    manualTriggerValue: -1,
    manualNeonStart: 0,
    manualNeonUntil: 0,
    manualNeonLabel: '',
    lastSeq: -999,
    customLogs: [],
  };
}

/**
 * 데모 시나리오 엔진 — gemini_sub_neon.html 원본의 render(t) 수식을 TUI AppState로 정밀 동기화합니다.
 *
 * 격리 불변식(§5.3 W2-B): 이 모듈과 `applyDemoTime`은 SQLite(`node:sqlite`) 및
 * `src/decision/**`의 어떤 함수(읽기·쓰기 포함)도 호출하지 않는다. `--demo` 모드에서
 * 결정 DB 파일이 생성·갱신되는 일은 원천 없다(검증: tests/ui-adapter.test.ts).
 */
export function applyDemoTime(state: AppState, rawTimeSec: number, ctrl: DemoController): void {
  const t = ((rawTimeSec % LOOP) + LOOP) % LOOP;
  state.simTime = t;

  let active: -1 | 0 | 1 | 2 = -1;
  let calls = 1;
  let tokens = 120;
  ADV_WINDOWS.forEach((w, i) => {
    if (t >= w.on && t < w.off) active = i as 0 | 1 | 2;
    if (t >= w.on) calls++;
    tokens += w.gain * seg(t, w.on, w.off - w.on);
  });

  if (Date.now() < ctrl.manualTriggerUntil) {
    active = ctrl.manualTriggerValue;
  }

  state.activeTrigger = active;
  state.totalForks = 1286 + Math.floor(t * 16.5);
  state.swarmActive = 42 + Math.round(3 * Math.sin(t * 0.65));
  state.carbonCalls = calls;
  state.tokensRead = `${Math.round(tokens)}k`;
  state.advisorState = active < 0 ? '대기 중' : '자문 중';

  let phase = PHASES[0]![1];
  for (const p of PHASES) {
    if (t >= p[0]) phase = p[1];
  }
  state.phase = phase;

  let latestAdvice = ADVICE_ENTRIES[ADVICE_ENTRIES.length - 1]!.text;
  for (const a of ADVICE_ENTRIES) {
    if (t >= a.at) latestAdvice = a.text;
  }
  state.latestAdvice = latestAdvice;

  state.adviceHistory = [
    {
      time: '23:48:22',
      triggerIndex: 0,
      triggerLabel: TRIGGER_LABELS[0],
      text: '인증·DB/트랜잭션 호출을 계획에서 제외, 토큰 약 120k 읽음',
      tokensRead: '120k',
    },
    {
      time: '23:48:34',
      triggerIndex: 1,
      triggerLabel: TRIGGER_LABELS[1],
      text: 'mock_missing_symbol 원인은 잘못된 fixture — fixture 심볼 매핑 수정 권고',
      tokensRead: '413k',
    },
    {
      time: '23:48:50',
      triggerIndex: 2,
      triggerLabel: TRIGGER_LABELS[2],
      text: '테스트 28/28 통과 확인 및 워크트리 변경 범위 최종 검토 완료',
      tokensRead: '623k',
    },
  ];

  // Verifier 교차 검증 상태 계산 (gemini_sub_neon.html NEON 수식 1:1 동기화)
  let nState: NeonStatus = 'idle';
  let nProgress = 0;
  let nLabel = '';
  let nSummary = '대기 · 호출 시 독립 검증';
  let verified = 0;
  const neonHistory: NeonCheckRecord[] = [];

  for (const w of NEON_WINDOWS) {
    if (t >= w.done) {
      verified++;
      neonHistory.push({
        time: w.time,
        label: w.label,
        status: 'pass',
        summary: w.summary,
        model: state.rosterLabels.verifier,
      });
    }
    if (t < w.on) continue;
    if (t < w.off) {
      nLabel = w.label;
      if (t < w.done) {
        nState = 'run';
        nProgress = Math.floor(((t - w.on) / (w.done - w.on)) * 100);
        nSummary = `${w.label} 진행 중…`;
      } else {
        nState = 'pass';
        nProgress = 100;
        nSummary = w.summary;
      }
    } else {
      nState = 'idle';
      nProgress = 0;
      nSummary = w.summary;
    }
  }

  const nowMs = Date.now();
  if (nowMs < ctrl.manualNeonUntil) {
    const dur = Math.max(1, ctrl.manualNeonUntil - ctrl.manualNeonStart);
    const ratio = clamp01((nowMs - ctrl.manualNeonStart) / dur);
    nLabel = ctrl.manualNeonLabel;
    if (ratio < 0.72) {
      nState = 'run';
      nProgress = Math.floor((ratio / 0.72) * 100);
      nSummary = `${ctrl.manualNeonLabel} 교차 검증 중`;
    } else {
      nState = 'pass';
      nProgress = 100;
      nSummary = `${ctrl.manualNeonLabel} 검증 통과`;
      verified += 1;
    }
  }

  state.neonState = nState;
  state.neonProgress = nProgress;
  state.neonLabel = nLabel;
  state.neonVerified = verified;
  state.neonSummary = nSummary;
  state.neonHistory = neonHistory;

  // Decision Gate 라우트 확률 업데이트 (4번째 delegate_swarm 포함 — DB 접근 없는 순수 계산)
  let sharp = 0;
  let split = 0;
  state.routes = ROUTE_NAMES.map((name, i) => {
    const p = ROUTE_MATRIX[i]![Math.floor(t / 2.5 + i) % 4]!;
    if (p >= 0.7) sharp++;
    else split++;
    return { name, p };
  });
  state.sharpCount = sharp;
  state.splitCount = split;

  // Workers 대표 역할 카드 3개 진행률
  state.cards = CARD_SPECS.map((spec, i) => {
    const cycle = (t + i * 2.7) % (9 + i * 1.7);
    const pct = Math.min(100, (cycle / (7 + i * 1.7)) * 100);
    return {
      name: spec.name,
      model: state.rosterLabels.explore,
      progress: Math.floor(pct),
      description: spec.desc,
      status: pct >= 100 ? 'done' : 'running',
    };
  });

  // 50개 스웜 개별 슬롯 동기화
  for (let idx = 0; idx < state.workers.length; idx++) {
    const w = state.workers[idx]!;
    if (idx < state.swarmActive) {
      const cyc = (t * 14 + idx * 13) % 105;
      w.progress = Math.min(100, Math.floor(cyc));
      w.status = w.progress >= 100 ? 'done' : 'running';
    } else if (idx < state.swarmActive + 4) {
      w.progress = 100;
      w.status = 'done';
    } else {
      w.progress = 0;
      w.status = 'idle';
    }
  }

  // 세션 기록 타임라인 구성 (24비트 동기화 + 과거 스크롤 가능한 윈도우 유지)
  const seq = Math.floor(t / STEP);
  if (seq !== ctrl.lastSeq || state.logs.length === 0) {
    ctrl.lastSeq = seq;
    const windowSize = 20;
    const built = Array.from({ length: windowSize }, (_, i) => {
      const k = seq - (windowSize - 1) + i;
      const beatIdx = ((k % DEMO_BEATS.length) + DEMO_BEATS.length) % DEMO_BEATS.length;
      const beat = DEMO_BEATS[beatIdx]!;
      const totalSec = 48 * 60 + 10 + k * 2;
      const safeSec = ((totalSec % 3600) + 3600) % 3600;
      const mm = String(Math.floor(safeSec / 60)).padStart(2, '0');
      const ss = String(safeSec % 60).padStart(2, '0');
      return {
        id: i + 1,
        time: `23:${mm}:${ss}`,
        agent: beat[0],
        color: beat[1],
        message: beat[2],
      };
    });

    ctrl.customLogs.forEach((c, idx) => {
      built.push({
        id: windowSize + idx + 1,
        time: c.time,
        agent: c.agent,
        color: c.color,
        message: c.message,
      });
    });

    state.logs = built;
  }
}

export interface LivePromptHooks {
  onLivePrompt: (prompt: string) => void;
  onCarbonAsk: (question: string) => void;
  onNeonVerify: (target: string) => void;
  onCancel: () => void;
  onNewSession: () => void;
}

/**
 * 하단 프롬프트(`~/app $ gemini` / `agy`)에서 입력한 명령 또는 자연어 지시어 실행기
 */
export function executePromptCommand(
  rawInput: string,
  state: AppState,
  ctrl: DemoController,
  onSeek: (sec: number) => void,
  onQuit: () => void,
  liveHooks?: LivePromptHooks
): void {
  const trimmed = rawInput.trim();
  if (!trimmed) return;

  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const arg = parts[1]?.toLowerCase();
    const restText = trimmed.slice(1 + (parts[0]?.length ?? 0)).trim();

    switch (cmd) {
      case 'help':
      case '?':
        state.modal = 'help';
        return;
      case 'response':
      case 'res':
        state.modal = 'response';
        return;
      case 'swarm':
      case 'agents':
        state.modal = 'swarm';
        return;
      case 'advisor':
        state.modal = 'advisor';
        return;
      case 'carbon':
        if (state.mode === 'live' && restText.length > 0 && liveHooks) {
          liveHooks.onCarbonAsk(restText);
        } else {
          state.modal = 'advisor';
        }
        return;
      case 'neon':
      case 'verify':
        if (state.mode === 'live' && liveHooks) {
          if (restText.length > 0 || state.latestResponse.trim().length > 0) {
            liveHooks.onNeonVerify(
              restText || '최근 Lead 응답과 변경 사항의 누락·회귀 여부를 독립 교차 검증해줘'
            );
          } else {
            state.modal = 'neon';
          }
        } else if (restText.length > 0) {
          const now = Date.now();
          ctrl.manualNeonStart = now;
          ctrl.manualNeonUntil = now + 5000;
          ctrl.manualNeonLabel = restText;
          state.neonState = 'run';
          state.neonProgress = 12;
          state.neonLabel = restText;
          const d = new Date();
          const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
          if (state.mode === 'demo') {
            ctrl.customLogs.push({
              time: ts,
              agent: 'Verifier',
              color: 'neon',
              message: `독립 교차 검증 시작 — ${restText}`,
            });
            ctrl.lastSeq = -999;
          } else {
            appendLog(state, 'Verifier', 'neon', `독립 교차 검증 시작 — ${restText}`, ts);
          }
          flashStatus(state, `Verifier 교차 검증 시작: ${restText}`);
        } else {
          state.modal = 'neon';
        }
        return;
      case 'model': {
        if (parts[1]) {
          state.modelName = parts[1];
          state.modelFlag = `--model ${parts[1]}`;
          const inferred = inferEffortFromModel(parts[1]);
          if (inferred) state.effort = inferred;
          flashStatus(state, `모델 변경: ${parts[1]}`);
        } else {
          flashStatus(
            state,
            `현재 모델: ${state.modelName} (예: /model glm-zcode/glm-5.3)`
          );
        }
        return;
      }
      case 'new':
        if (state.mode === 'live' && liveHooks) {
          liveHooks.onNewSession();
        } else {
          flashStatus(state, '새 세션 초기화는 --live 모드에서 지원됩니다');
        }
        return;
      case 'cancel':
      case 'stop':
        if (state.mode === 'live' && liveHooks) {
          liveHooks.onCancel();
        }
        return;
      case 'decision':
      case 'forks':
        state.modal = 'decision';
        return;
      case 'logs':
        state.modal = 'logs';
        return;
      case 'pause':
        state.paused = true;
        flashStatus(state, '일시정지됨 (/play 또는 Space로 재개)');
        return;
      case 'play':
      case 'resume':
        state.paused = false;
        flashStatus(state, '재생 재개됨');
        return;
      case 'seek': {
        const sec = Number(arg);
        if (!Number.isNaN(sec)) {
          onSeek(sec);
          flashStatus(state, `타임라인 이동: t=${sec.toFixed(1)}s`);
        } else {
          flashStatus(state, '사용법: /seek <0~40>');
        }
        return;
      }
      case 'effort': {
        if (arg === 'low' || arg === 'medium' || arg === 'high' || arg === 'max') {
          state.effort = arg as EffortLevel;
          state.effortKnown = true;
          if (state.mode === 'live') {
            state.modelName = applyEffortToModelName(state.modelName, state.effort);
            state.modelFlag = `--model ${state.modelName}`;
          }
          flashStatus(state, `Lead effort 변경: ${arg}`);
        } else {
          flashStatus(state, '사용법: /effort <low|medium|high|max>');
        }
        return;
      }
      case 'trigger': {
        const idx = Number(arg);
        if (idx === 0 || idx === 1 || idx === 2) {
          ctrl.manualTriggerValue = idx;
          ctrl.manualTriggerUntil = Date.now() + 6000;
          state.activeTrigger = idx;
          state.advisorState = '자문 중';
          flashStatus(state, `Advisor 트리거 발동: ${TRIGGER_LABELS[idx]}`);
        } else {
          ctrl.manualTriggerUntil = 0;
          flashStatus(state, '사용법: /trigger <0|1|2>');
        }
        return;
      }
      case 'filter': {
        if (
          arg === 'all' ||
          arg === 'argon' ||
          arg === 'hydrogen' ||
          arg === 'decision' ||
          arg === 'neon' ||
          arg === 'carbon'
        ) {
          state.logFilter = arg;
          state.logScrollOffset = 0;
          flashStatus(state, `로그 필터: ${LOG_FILTER_LABELS[arg]}`);
        } else {
          flashStatus(state, '사용법: /filter <all|argon|hydrogen|decision|neon|carbon>');
        }
        return;
      }
      case 'clear':
        ctrl.customLogs = [];
        state.logs = [];
        ctrl.lastSeq = -999;
        flashStatus(state, '세션 기록이 초기화되었습니다');
        return;
      case 'quit':
      case 'exit':
      case 'q':
        onQuit();
        return;
      default:
        flashStatus(state, `알 수 없는 명령어: /${cmd} (/help 참고)`);
        return;
    }
  }

  // 일반 프롬프트 입력 -> 라이브 백엔드 실행 또는 데모 세션 투입
  if (state.mode === 'live' && liveHooks) {
    liveHooks.onLivePrompt(trimmed);
    return;
  }

  state.argonBuilds += 1;
  state.mainSummary = trimmed;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  if (state.mode === 'demo') {
    ctrl.customLogs.push({
      time: ts,
      agent: 'Lead',
      color: 'orange',
      message: `새 지시 수신 — "${trimmed}"`,
    });
    ctrl.lastSeq = -999; // 즉시 재구성
  } else {
    appendLog(state, 'Lead', 'orange', `새 지시 수신 — "${trimmed}"`, ts);
  }
  flashStatus(state, 'Lead 메인 세션에 새 작업이 전달되었습니다');
}
