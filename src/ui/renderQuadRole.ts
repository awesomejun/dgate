import { CellBuffer, type Rect } from '../core/buffer.ts';
import {
  padRightWidth,
  stringWidth,
  truncateWidth,
  wrapByWidth,
} from '../core/width.ts';
import { effortToGauge, sortRoutesForDisplay, TRIGGER_LABELS } from '../state/store.ts';
import { THEME, type RGB } from '../theme.ts';
import type { AppState, LogEntry, QuadRole } from '../types.ts';

function getRoleLogs(state: AppState, role: QuadRole): LogEntry[] {
  return state.logs.filter((entry) => {
    const lower = entry.agent.toLowerCase();
    switch (role) {
      case 'argon':
        return lower.includes('argon') || lower.includes('decision');
      case 'carbon':
        return lower.includes('carbon');
      case 'neon':
        return lower.includes('neon');
      case 'hydrogen':
        return lower.includes('hydrogen');
      default:
        return true;
    }
  });
}

export function renderQuadRoleFrame(
  state: AppState,
  role: QuadRole,
  cols: number,
  rows: number
): CellBuffer {
  const buf = new CellBuffer(cols, rows, THEME.bg, THEME.fg);

  switch (role) {
    case 'argon':
      renderArgonView(buf, state, cols, rows);
      break;
    case 'carbon':
      renderCarbonView(buf, state, cols, rows);
      break;
    case 'neon':
      renderNeonView(buf, state, cols, rows);
      break;
    case 'hydrogen':
      renderHydrogenView(buf, state, cols, rows);
      break;
    default:
      renderArgonView(buf, state, cols, rows);
      break;
  }

  return buf;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ARGON (리드 오케스트레이터 · gemini-4-argon-high)
// ─────────────────────────────────────────────────────────────────────────────
function renderArgonView(buf: CellBuffer, state: AppState, cols: number, rows: number): void {
  // 상단 헤더 바
  buf.fillRect({ x: 0, y: 0, w: cols, h: 1 }, THEME.bgChrome);
  buf.setChar(1, 0, '◈', THEME.orange, THEME.bgChrome, true);
  buf.writeText(3, 0, 'ARGON · LEAD ORCHESTRATOR', THEME.orange, THEME.bgChrome, true);
  const modelTag = `gemini-4-argon-high (${effortToGauge(state.effort)})`;
  buf.writeRight(0, 0, cols - 2, modelTag, THEME.chromeFg, THEME.bgChrome);

  // 상단 요약 박스 (Phase & Builds)
  const padX = 1;
  const topBoxY = 1;
  const topBoxH = 4;
  buf.drawBox(
    { x: padX, y: topBoxY, w: cols - padX * 2, h: topBoxH },
    {
      borderColor: THEME.orange,
      fillBg: THEME.bgElevated,
      title: 'Current Mission State',
      titleColor: THEME.orange,
    }
  );

  const phaseText = `단계: ${state.phase}   빌드: #${state.argonBuilds}   분기: ${state.totalForks}`;
  buf.writeText(padX + 2, topBoxY + 1, phaseText, THEME.fg, THEME.bgElevated, true);
  const targetText = `목표: ${truncateWidth(state.mainSummary || '대기 중…', cols - padX * 2 - 8)}`;
  buf.writeText(padX + 2, topBoxY + 2, targetText, THEME.fgSoft, THEME.bgElevated);

  // 분기 라우팅 매트릭스 (Decision 1)
  const decY = topBoxY + topBoxH;
  const decH = Math.min(6, Math.max(4, Math.floor((rows - decY) * 0.35)));
  buf.drawBox(
    { x: padX, y: decY, w: cols - padX * 2, h: decH },
    {
      borderColor: THEME.green,
      fillBg: THEME.bgElevated,
      title: 'Decision 1 · Branching Routes',
      titleColor: THEME.green,
      rightLabel: `forks ${state.totalForks}`,
      rightLabelColor: THEME.muted,
    }
  );

  // N3: forcedSplit → split 우선 정렬 후 표시 — 소형 창에서도 4번째 라우트·강제 분기가 잘리지 않는다
  const routes = sortRoutesForDisplay(state.routes).slice(0, Math.max(1, decH - 2));
  const labelW = 14;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i]!;
    const ry = decY + 1 + i;
    buf.writeText(padX + 2, ry, r.name, THEME.fgSoft, THEME.bgElevated, false, labelW);

    const isSplit = r.forcedSplit === true || r.p < 0.7;
    const barFg = r.forcedSplit === true ? THEME.trafficRed : isSplit ? THEME.orange : THEME.green;
    const barW = Math.max(8, cols - padX * 2 - labelW - 22);
    buf.drawProgressBar(
      padX + 2 + labelW,
      ry,
      barW,
      r.p,
      barFg,
      isSplit ? THEME.bgOrangeTrack : THEME.bgGreenTrack
    );

    // 축약 태그: 강제 분기는 ERR2, 일반은 근거 표본 수 m24/p2 (N3)
    let tag = `p=${r.p.toFixed(2)} ${r.forcedSplit === true ? 'SPLIT' : isSplit ? 'split' : 'sharp'}`;
    if (r.forcedSplit === true) {
      tag += ' ERR2';
    } else if (r.basis !== undefined) {
      tag += ` ${r.basis === 'measured' ? 'm' : 'p'}${r.samples ?? 0}`;
    }
    const tagX = padX + 2 + labelW + barW + 1;
    buf.writeText(
      tagX,
      ry,
      tag,
      r.forcedSplit === true ? THEME.trafficRed : isSplit ? THEME.orange : THEME.green,
      THEME.bgElevated,
      r.forcedSplit === true,
      Math.max(0, cols - padX - 2 - tagX)
    );
  }

  // 실시간 로그 영역
  const logY = decY + decH;
  const logH = Math.max(4, rows - logY - 2);
  buf.drawBox(
    { x: padX, y: logY, w: cols - padX * 2, h: logH },
    {
      borderColor: THEME.borderLog,
      fillBg: THEME.bg,
      title: 'Argon Execution Stream',
      titleColor: THEME.orange,
    }
  );

  const logs = getRoleLogs(state, 'argon');
  const visibleLogs = logs.slice(-(logH - 2));
  for (let i = 0; i < visibleLogs.length; i++) {
    const entry = visibleLogs[i]!;
    const ly = logY + 1 + i;
    buf.writeText(padX + 2, ly, entry.time, THEME.dim, THEME.bg);
    buf.writeText(padX + 11, ly, entry.agent, THEME.orange, THEME.bg, true, 10);
    const msgW = cols - padX * 2 - 24;
    buf.writeText(padX + 22, ly, entry.message, THEME.fg, THEME.bg, false, msgW);
  }

  // 최하단 상태 및 프롬프트 바
  const footY = rows - 1;
  buf.fillRect({ x: 0, y: footY, w: cols, h: 1 }, THEME.bgChrome);
  const promptStr = state.inputActive
    ? `Argon $ ${state.inputValue}█`
    : `Argon █  [/:명령어 입력  Tab:포커스  Space:일시정지]`;
  buf.writeText(1, footY, promptStr, THEME.orange, THEME.bgChrome, true, cols - 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CARBON (전략 자문 모델 · gemini-4-carbon-high)
// ─────────────────────────────────────────────────────────────────────────────
function renderCarbonView(buf: CellBuffer, state: AppState, cols: number, rows: number): void {
  // 상단 헤더 바
  buf.fillRect({ x: 0, y: 0, w: cols, h: 1 }, THEME.bgChrome);
  buf.setChar(1, 0, '⬡', THEME.purple, THEME.bgChrome, true);
  buf.writeText(3, 0, 'CARBON · STRATEGIC ADVISOR', THEME.purple, THEME.bgChrome, true);
  const statusStr = `gemini-4-carbon-high · ${state.advisorState}`;
  buf.writeRight(0, 0, cols - 2, statusStr, THEME.chromeFg, THEME.bgChrome);

  const padX = 1;
  const topY = 1;
  const topH = 5;
  buf.drawBox(
    { x: padX, y: topY, w: cols - padX * 2, h: topH },
    {
      borderColor: THEME.purple,
      fillBg: THEME.bgElevated,
      title: 'Advisory Gateways (3 Triggers)',
      titleColor: THEME.purple,
      rightLabel: `read ${state.tokensRead}`,
      rightLabelColor: THEME.muted,
    }
  );

  // 3개 트리거 상태 표시
  const triggers = [
    { idx: 0, label: '● 계획 확정 전', desc: '아키텍처 및 보안 트랜잭션 경로 검토' },
    { idx: 1, label: '◇ 같은 오류 2회', desc: '도구 실패 반복 시 루프 차단 및 전략 수정' },
    { idx: 2, label: '◇ 완료 전', desc: '최종 릴리즈 전 스냅샷 정합성 확인' },
  ];

  for (let i = 0; i < triggers.length; i++) {
    const tr = triggers[i]!;
    const isActive = state.activeTrigger === tr.idx;
    const fg = isActive ? THEME.purple : THEME.dim;
    const bg = isActive ? THEME.bgTriggerActive : THEME.bgElevated;
    const line = `${tr.label} : ${tr.desc}`;
    buf.writeText(padX + 2, topY + 1 + i, truncateWidth(line, cols - padX * 2 - 4), fg, bg, isActive);
  }

  // 최근 전략적 조언 카드
  const cardY = topY + topH;
  const cardH = 5;
  buf.drawBox(
    { x: padX, y: cardY, w: cols - padX * 2, h: cardH },
    {
      borderColor: THEME.purple,
      fillBg: THEME.bgGlowPurple,
      title: 'Latest Strategic Guidance',
      titleColor: THEME.purple,
      rightLabel: `호출 ${state.carbonCalls}회`,
      rightLabelColor: THEME.muted,
    }
  );

  const adviceClean = state.latestAdvice || '현재 일상 턴 침묵 중 (정상 상태)';
  const wrapped = wrapByWidth(adviceClean, cols - padX * 2 - 4);
  for (let i = 0; i < Math.min(cardH - 2, wrapped.length); i++) {
    buf.writeText(padX + 2, cardY + 1 + i, wrapped[i]!, THEME.purple, THEME.bgGlowPurple, true);
  }

  // 자문 이력 로그
  const logY = cardY + cardH;
  const logH = Math.max(4, rows - logY - 1);
  buf.drawBox(
    { x: padX, y: logY, w: cols - padX * 2, h: logH },
    {
      borderColor: THEME.borderLog,
      fillBg: THEME.bg,
      title: 'Carbon Advisory History',
      titleColor: THEME.purple,
    }
  );

  const logs = getRoleLogs(state, 'carbon');
  const visibleLogs = logs.slice(-(logH - 2));
  for (let i = 0; i < visibleLogs.length; i++) {
    const entry = visibleLogs[i]!;
    const ly = logY + 1 + i;
    buf.writeText(padX + 2, ly, entry.time, THEME.dim, THEME.bg);
    buf.writeText(padX + 11, ly, entry.agent, THEME.purple, THEME.bg, true, 8);
    const msgW = cols - padX * 2 - 22;
    buf.writeText(padX + 20, ly, entry.message, THEME.fgSoft, THEME.bg, false, msgW);
  }

  // 최하단
  const footY = rows - 1;
  buf.fillRect({ x: 0, y: footY, w: cols, h: 1 }, THEME.bgChrome);
  buf.writeText(
    1,
    footY,
    'Carbon · 코드는 직접 쓰지 않고 아키텍처 가이드만 Argon에 전달합니다',
    THEME.purple,
    THEME.bgChrome
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. NEON (독립 교차 검증 모델 · gemini-4-neon-high)
// ─────────────────────────────────────────────────────────────────────────────
function renderNeonView(buf: CellBuffer, state: AppState, cols: number, rows: number): void {
  // 상단 헤더 바
  buf.fillRect({ x: 0, y: 0, w: cols, h: 1 }, THEME.bgChrome);
  buf.setChar(1, 0, '✦', THEME.neon, THEME.bgChrome, true);
  buf.writeText(3, 0, 'GEMINI NEON · CROSS-VERIFIER', THEME.neon, THEME.bgChrome, true);
  const verTag = `gemini-4-neon-high · 검증 [${state.neonVerified}건]`;
  buf.writeRight(0, 0, cols - 2, verTag, THEME.chromeFg, THEME.bgChrome);

  const padX = 1;
  const topY = 1;
  const topH = 6;
  buf.drawBox(
    { x: padX, y: topY, w: cols - padX * 2, h: topH },
    {
      borderColor: THEME.neon,
      fillBg: THEME.bgElevated,
      title: 'Independent Verification Status',
      titleColor: THEME.neon,
    }
  );

  // 상태 배지
  let statusBadge = '[⋯ IDLE] 검증 대기 중';
  let statusFg = THEME.muted;
  if (state.neonState === 'run') {
    statusBadge = `[◉ RUN] 독립 교차 검증 진행 중 (${state.neonProgress}%)`;
    statusFg = THEME.neon;
  } else if (state.neonState === 'pass') {
    statusBadge = '[✔ PASS] 회귀 및 계약 위반 없음';
    statusFg = THEME.trafficGreen;
  } else if (state.neonState === 'fail') {
    statusBadge = '[✖ FAIL] 검증 실패 — 롤백 필요';
    statusFg = THEME.trafficRed;
  }
  buf.writeText(padX + 2, topY + 1, statusBadge, statusFg, THEME.bgElevated, true);

  // 프로그레스 바
  const barW = Math.max(10, cols - padX * 2 - 14);
  buf.drawProgressBar(padX + 2, topY + 2, barW, state.neonProgress / 100, THEME.neon, THEME.bgNeonTrack);
  buf.writeText(padX + 3 + barW, topY + 2, `${state.neonProgress}%`, THEME.neon, THEME.bgElevated, true);

  // 검증 대상 & 요약
  const summaryLine = `대상: ${state.neonLabel || '전체 파이프라인'} — ${state.neonSummary}`;
  buf.writeText(
    padX + 2,
    topY + 3,
    truncateWidth(summaryLine, cols - padX * 2 - 4),
    THEME.fgSoft,
    THEME.bgElevated
  );
  buf.writeText(
    padX + 2,
    topY + 4,
    '검증 기준: [OpenAPI 계약] [엣지케이스 누락] [회귀 안전성]',
    THEME.dim,
    THEME.bgElevated
  );

  // 검증 기록 및 로그
  const logY = topY + topH;
  const logH = Math.max(4, rows - logY - 1);
  buf.drawBox(
    { x: padX, y: logY, w: cols - padX * 2, h: logH },
    {
      borderColor: THEME.borderLog,
      fillBg: THEME.bg,
      title: 'Neon Verification Audit Trail',
      titleColor: THEME.neon,
    }
  );

  const logs = getRoleLogs(state, 'neon');
  const visibleLogs = logs.slice(-(logH - 2));
  for (let i = 0; i < visibleLogs.length; i++) {
    const entry = visibleLogs[i]!;
    const ly = logY + 1 + i;
    buf.writeText(padX + 2, ly, entry.time, THEME.dim, THEME.bg);
    buf.writeText(padX + 11, ly, entry.agent, THEME.neon, THEME.bg, true, 8);
    const msgW = cols - padX * 2 - 22;
    buf.writeText(padX + 20, ly, entry.message, THEME.fg, THEME.bg, false, msgW);
  }

  // 최하단
  const footY = rows - 1;
  buf.fillRect({ x: 0, y: footY, w: cols, h: 1 }, THEME.bgChrome);
  buf.writeText(
    1,
    footY,
    'Gemini Neon · 편향 없는 독립 교차 검증으로 오류 발생을 미연에 차단합니다',
    THEME.neon,
    THEME.bgChrome
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HYDROGEN (스웜 & 서브에이전트 함대 · gemini-4-hydrogen-high)
// ─────────────────────────────────────────────────────────────────────────────
function renderHydrogenView(buf: CellBuffer, state: AppState, cols: number, rows: number): void {
  // 상단 헤더 바
  buf.fillRect({ x: 0, y: 0, w: cols, h: 1 }, THEME.bgChrome);
  buf.setChar(1, 0, '❖', THEME.blue, THEME.bgChrome, true);
  buf.writeText(3, 0, 'HYDROGEN · SWARM FLEET', THEME.blue, THEME.bgChrome, true);
  const fleetTag = `gemini-4-hydrogen-high · 활성 [${state.swarmActive}/${state.swarmMax}]`;
  buf.writeRight(0, 0, cols - 2, fleetTag, THEME.chromeFg, THEME.bgChrome);

  const padX = 1;
  const topY = 1;
  const topH = 5;
  buf.drawBox(
    { x: padX, y: topY, w: cols - padX * 2, h: topH },
    {
      borderColor: THEME.blue,
      fillBg: THEME.bgElevated,
      title: '50-Worker Concurrency Matrix',
      titleColor: THEME.blue,
      rightLabel: `${state.swarmActive} active`,
      rightLabelColor: THEME.blue,
    }
  );

  // 50개 워커 비주얼 매트릭스 그리드 (10열 x 3행)
  const matrixCols = 25;
  for (let i = 0; i < 50; i++) {
    const colIdx = i % matrixCols;
    const rowIdx = Math.floor(i / matrixCols);
    if (rowIdx >= topH - 2) break;

    const wx = padX + 2 + colIdx * 2;
    const wy = topY + 1 + rowIdx;

    const worker = state.workers[i];
    let symbol = '░';
    let fg: RGB = THEME.dim;
    if (worker && worker.status === 'running') {
      symbol = '■';
      fg = THEME.blue;
    } else if (worker && worker.status === 'done') {
      symbol = '▣';
      fg = THEME.green;
    }

    buf.setChar(wx, wy, symbol, fg, THEME.bgElevated, true);
  }

  // 병렬 작업 카드 섹션 (search, grep, audit 등)
  const cardY = topY + topH;
  const cardCount = Math.min(3, state.cards.length);
  const cardH = 5;
  buf.drawBox(
    { x: padX, y: cardY, w: cols - padX * 2, h: cardH },
    {
      borderColor: THEME.blue,
      fillBg: THEME.bgElevated,
      title: 'Active Parallel Subtasks',
      titleColor: THEME.blue,
    }
  );

  const perCardW = Math.max(16, Math.floor((cols - padX * 2 - 4) / cardCount));
  for (let c = 0; c < cardCount; c++) {
    const card = state.cards[c]!;
    const cx = padX + 2 + c * perCardW;
    buf.writeText(cx, cardY + 1, `[${card.name}]`, THEME.blue, THEME.bgElevated, true);

    const bW = Math.max(8, perCardW - 7);
    buf.drawProgressBar(cx, cardY + 2, bW, card.progress / 100, THEME.blue, THEME.bgBlueTrack);
    buf.writeText(cx + bW + 1, cardY + 2, `${card.progress}%`, THEME.fgSoft, THEME.bgElevated);

    const desc = truncateWidth(card.description, perCardW - 2);
    buf.writeText(cx, cardY + 3, desc, THEME.dim, THEME.bgElevated);
  }

  // 스웜 로그 영역
  const logY = cardY + cardH;
  const logH = Math.max(4, rows - logY - 1);
  buf.drawBox(
    { x: padX, y: logY, w: cols - padX * 2, h: logH },
    {
      borderColor: THEME.borderLog,
      fillBg: THEME.bg,
      title: 'Hydrogen Subagent Activity',
      titleColor: THEME.blue,
    }
  );

  const logs = getRoleLogs(state, 'hydrogen');
  const visibleLogs = logs.slice(-(logH - 2));
  for (let i = 0; i < visibleLogs.length; i++) {
    const entry = visibleLogs[i]!;
    const ly = logY + 1 + i;
    buf.writeText(padX + 2, ly, entry.time, THEME.dim, THEME.bg);
    buf.writeText(padX + 11, ly, entry.agent, THEME.blue, THEME.bg, true, 12);
    const msgW = cols - padX * 2 - 26;
    buf.writeText(padX + 24, ly, entry.message, THEME.fg, THEME.bg, false, msgW);
  }

  // 최하단
  const footY = rows - 1;
  buf.fillRect({ x: 0, y: footY, w: cols, h: 1 }, THEME.bgChrome);
  buf.writeText(
    1,
    footY,
    'Hydrogen · 50개 고속 슬롯으로 파일 탐색, grep, AST 분석을 병렬 처리합니다',
    THEME.blue,
    THEME.bgChrome
  );
}
