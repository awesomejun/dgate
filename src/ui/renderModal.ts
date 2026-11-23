import { CellBuffer, type Rect } from '../core/buffer.ts';
import { padLeftWidth, padRightWidth, stringWidth, truncateWidth, wrapByWidth } from '../core/width.ts';
import { LOG_FILTER_LABELS, getFilteredLogs, sortRoutesForDisplay } from '../state/store.ts';
import { THEME, lerpColor, resolveColorKey } from '../theme.ts';
import type { AppState } from '../types.ts';

function dimBackground(buf: CellBuffer): void {
  for (let i = 0; i < buf.cells.length; i++) {
    const c = buf.cells[i]!;
    c.fg = lerpColor(c.fg, THEME.bg, 0.58);
    c.bg = lerpColor(c.bg, hexDark, 0.55);
    c.bold = false;
  }
}

const hexDark = { r: 12, g: 15, b: 19 } as const;

export function renderModalOverlay(buf: CellBuffer, state: AppState): void {
  if (state.modal === 'none') return;

  dimBackground(buf);

  const maxW = Math.min(96, buf.width - 6);
  const maxH = Math.min(30, buf.height - 4);
  if (maxW < 30 || maxH < 10) return;

  const rect: Rect = {
    x: Math.floor((buf.width - maxW) / 2),
    y: Math.floor((buf.height - maxH) / 2),
    w: maxW,
    h: maxH,
  };

  switch (state.modal) {
    case 'help':
      renderHelpModal(buf, rect);
      break;
    case 'swarm':
      renderSwarmModal(buf, rect, state);
      break;
    case 'advisor':
      renderAdvisorModal(buf, rect, state);
      break;
    case 'neon':
      renderNeonModal(buf, rect, state);
      break;
    case 'decision':
      renderDecisionModal(buf, rect, state);
      break;
    case 'logs':
      renderLogsModal(buf, rect, state);
      break;
    case 'response':
      renderResponseModal(buf, rect, state);
      break;
    case 'terminal':
      renderTerminalModal(buf, rect, state);
      break;
  }
}

function renderHelpModal(buf: CellBuffer, rect: Rect): void {
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.green,
    fillBg: THEME.bgModal,
    title: '단축키 및 명령어 도움말',
    titleColor: THEME.green,
    rightLabel: 'Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  buf.writeText(ix, cy++, '■ 이 화면은 뭔가요? (보기 vs 작업 시키기)', THEME.green, THEME.bgModal, true, iw);
  const introRows: readonly string[] = [
    '• 이 화면은 실시간 구경 전용 계기판입니다 (여기서 직접 명령을 치지 않습니다).',
    '• 작업 시키기: 원래 쓰던 AI 채팅창에서 "오케스트레이터로 진행해줘"라고 말씀하세요.',
    '• 화면 나가기: Ctrl+\\ (백그라운드 유지)  ·  q (모니터 완전히 끄기)',
    '• 둘러보기: Tab(칸 이동) · Enter(자세히) · 1~5/0(역할별 필터) · Space(잠시 멈춤)',
  ];
  for (const line of introRows) {
    if (cy >= rect.y + rect.h - 2) break;
    buf.writeText(ix, cy++, line, THEME.fgSoft, THEME.bgModal, false, iw);
  }
  cy++;

  if (cy < rect.y + rect.h - 2) {
    buf.writeText(ix, cy++, '■ 화면 안에서 쓰는 버튼', THEME.orange, THEME.bgModal, true, iw);
  }
  const keys: ReadonlyArray<readonly [string, string]> = [
    ['Tab / Shift+Tab', '칸 포커스 순환 (Advisor → Lead → Verifier → Decision Gate → Workers → 기록)'],
    ['Enter', '현재 포커스된 칸의 자세한 내용 모달 열기'],
    ['Enter: 터미널 보기', 'Workers 카드·Lead 카드에서 실제 CLI 터미널 출력 라이브 보기 (a: 직접 attach)'],
    ['←/→ · 1~9 (Workers)', '워커 카드 선택 이동/직접 선택 — Enter로 해당 터미널 상세 뷰 오픈'],
    ['r / s / n / c / d', '응답(r) · 스웜(s) · Verifier(n) · Advisor(c) · 분기(d) · 로그(l) 모달 열기'],
    ['1~5 / 0', '로그 필터 (1:Lead 2:Workers 3:Decision 4:Verifier 5:Advisor 0:전체)'],
    ['↑ / ↓', '세션 기록 / 응답 전문 스크롤 탐색'],
    ['Space / ← →', '(데모 모드) 재생 일시정지·재개 및 타임라인 ±2초 이동'],
    ['/ 또는 i', '하단 프롬프트 입력 모드 진입 (Esc로 복귀)'],
    ['q / Ctrl+C', '모니터 완전히 끄기'],
  ];

  for (const [k, desc] of keys) {
    if (cy >= rect.y + rect.h - 2) break;
    buf.writeSegments(
      ix,
      cy++,
      [
        { text: padRightWidth(k, 24), fg: THEME.green, bg: THEME.bgModal, bold: true },
        { text: desc, fg: THEME.fgSoft, bg: THEME.bgModal },
      ],
      iw
    );
  }

  cy++;
  if (cy < rect.y + rect.h - 2) {
    buf.writeText(ix, cy++, '■ (고급 · 터미널 직접 제어)', THEME.blue, THEME.bgModal, true, iw);
  }
  const cmds: ReadonlyArray<readonly [string, string]> = [
    ['작업 배차·감시', 'dispatch.ts / dg route · dg wrap · 워커 세션 hc ls / attach / kill'],
    ['통계·초기 설정', 'dg stats / dg report · 초기 환경 진단 npm run setup'],
    ['/model <name>', '라이브 모델 변경 (예: glm-5.3, deepseek-v4.1-flash, sonnet-4-6)'],
    ['/effort <level>', 'Lead 추론 강도 변경 (low | medium | high | max)'],
    ['/neon [대상]', 'Verifier 독립 교차 검증 실행 (--live 시 실제 verifier 모델 호출)'],
    ['/carbon <질문>', '(--live) Advisor 자문 모델에게 별도 자문 요청'],
    ['/new · /cancel', '(--live) 새 대화 시작(/new) 또는 실행 중인 턴 중단(/cancel)'],
    ['/seek <0~40>', '(--demo) 데모 시나리오 특정 시간(초)으로 즉시 점프'],
    ['--live / --stream', '실제 agy/API 백엔드 실행(--live) 또는 JSONL 파이프 관제(--stream)'],
  ];
  for (const [k, desc] of cmds) {
    if (cy >= rect.y + rect.h - 1) break;
    buf.writeSegments(
      ix,
      cy++,
      [
        { text: padRightWidth(k, 19), fg: THEME.purple, bg: THEME.bgModal, bold: true },
        { text: desc, fg: THEME.fgSoft, bg: THEME.bgModal },
      ],
      iw
    );
  }
}

function renderSwarmModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.blue,
    fillBg: THEME.bgModal,
    title: `Workers 스웜 매트릭스 (${state.swarmActive}/${state.swarmMax}) · ${state.rosterLabels.explore} / ${state.rosterLabels.coder}`,
    titleColor: THEME.blue,
    rightLabel: 'Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  const runningCnt = state.workers.filter((w) => w.status === 'running').length;
  const doneCnt = state.workers.filter((w) => w.status === 'done').length;
  const idleCnt = state.workers.length - runningCnt - doneCnt;

  buf.writeSegments(
    ix,
    cy++,
    [
      { text: '◉ 실행 중: ', fg: THEME.blue, bg: THEME.bgModal, bold: true },
      { text: `${runningCnt}   `, fg: THEME.fg, bg: THEME.bgModal },
      { text: '✓ 완료: ', fg: THEME.green, bg: THEME.bgModal, bold: true },
      { text: `${doneCnt}   `, fg: THEME.fg, bg: THEME.bgModal },
      { text: '▪ 대기 슬롯: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: `${idleCnt}`, fg: THEME.muted, bg: THEME.bgModal },
    ],
    iw
  );
  cy++;

  // 5행 x 10열 슬롯 그리드
  const cellSpan = Math.max(7, Math.floor(iw / 10));
  for (let r = 0; r < 5; r++) {
    if (cy >= rect.y + rect.h - 2) break;
    for (let c = 0; c < 10; c++) {
      const idx = r * 10 + c;
      const w = state.workers[idx];
      if (!w) continue;
      const icon = w.status === 'running' ? '◉' : w.status === 'done' ? '✓' : '▪';
      const color =
        w.status === 'running' ? THEME.blue : w.status === 'done' ? THEME.green : THEME.dim;
      const label = `#${String(w.id).padStart(2, '0')} ${icon}`;
      buf.writeText(ix + c * cellSpan, cy, label, color, THEME.bgModal, w.status === 'running', cellSpan - 1);
    }
    cy++;
  }

  cy++;
  if (cy < rect.y + rect.h - 3) {
    // 라이브 hc 워커가 관측 중이면 그 카드를 우선 노출 — 없으면 기존 매트릭스 대표 태스크 유지
    const liveCards = state.liveWorkers && state.liveWorkers.length > 0 ? state.liveWorkers : null;
    buf.writeText(
      ix,
      cy++,
      liveCards ? `라이브 hc 워커 (${liveCards.length})` : '대표 워커 태스크 현황',
      THEME.blue,
      THEME.bgModal,
      true,
      iw
    );
    if (liveCards) {
      const maxEndY = rect.y + rect.h - 2;
      for (const c of liveCards) {
        if (cy >= maxEndY) break;
        const namePart = `◉ ${truncateWidth(c.name, 22, '…')}`;
        const modelPill = c.model ? ` [${truncateWidth(c.model, 22, '…')}]` : '';
        buf.writeText(ix, cy, namePart, THEME.fgSoft, THEME.bgModal, true, iw);
        if (modelPill) {
          const pillX = ix + Math.min(25, stringWidth(namePart));
          buf.writeText(pillX, cy, modelPill, THEME.blue, THEME.bgModal, false, Math.max(0, iw - (pillX - ix)));
        }
        const barW = 12;
        const bx = ix + Math.max(36, Math.min(52, iw - barW - 6));
        if (bx + barW + 5 <= rect.x + rect.w - 2) {
          buf.drawProgressBar(
            bx,
            cy,
            barW,
            c.progress / 100,
            c.status === 'done' ? THEME.green : THEME.blue,
            THEME.bgBlueTrack
          );
          buf.writeText(
            bx + barW + 1,
            cy,
            padLeftWidth(`${c.progress}%`, 4),
            c.status === 'done' ? THEME.green : THEME.muted,
            THEME.bgModal
          );
        }
        cy++;
        if (cy < maxEndY) {
          buf.writeText(ix + 2, cy++, truncateWidth(c.description, iw - 2, '…'), THEME.muted, THEME.bgModal, false, iw - 2);
        }
        if (c.recentOutput && c.recentOutput.length > 0) {
          const perCardLines = liveCards.length <= 2 ? 6 : 3;
          for (const line of c.recentOutput.slice(-perCardLines)) {
            if (cy >= maxEndY) break;
            buf.writeText(
              ix + 3,
              cy++,
              `│ ${truncateWidth(line, iw - 5, '…')}`,
              THEME.fgSoft,
              THEME.bgModal,
              false,
              iw - 3
            );
          }
        }
      }
    } else {
      const sample = state.workers.slice(0, Math.max(1, rect.y + rect.h - 2 - cy));
      for (const w of sample) {
        const barW = 14;
        const prefix = `#${String(w.id).padStart(2, '0')} ${padRightWidth(w.role, 8)} ${padRightWidth(w.target, 28)} `;
        buf.writeText(ix, cy, prefix, THEME.fgSoft, THEME.bgModal, false, iw);
        const bx = ix + 41;
        if (bx + barW + 6 < rect.x + rect.w - 2) {
          buf.drawProgressBar(
            bx,
            cy,
            barW,
            w.progress / 100,
            w.status === 'done' ? THEME.green : THEME.blue,
            THEME.bgBlueTrack
          );
          buf.writeText(
            bx + barW + 1,
            cy,
            padLeftWidth(`${w.progress}%`, 4),
            w.status === 'done' ? THEME.green : THEME.muted,
            THEME.bgModal
          );
        }
        cy++;
      }
    }
  }
}

/**
 * 터미널 상세 뷰 모달 — 역할 카드(리드·워커) Enter로 오픈.
 * 헤더: 주소(·원본 pid 주소) · 모델 · 상태 · 소스 배지.
 * 본문: `hc read <addr> --lines 60`(≈1초 폴) 또는 wrap 로그 꼬리(state.terminalOutput).
 * 하단: a(attach) 안내 — hc 소스일 때만 실제 attach 가능.
 */
function renderTerminalModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  const target = state.terminalView;
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.blue,
    fillBg: THEME.bgModal,
    title: `터미널 · ${truncateWidth(target?.name ?? '대상 없음', 30, '…')}`,
    titleColor: THEME.blue,
    rightLabel: 'Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  if (!target) {
    buf.writeText(ix, cy, '대상 터미널 정보가 없습니다 (이미 종료된 카드일 수 있음)', THEME.muted, THEME.bgModal, false, iw);
    return;
  }

  const srcBadge =
    target.source === 'hc' ? 'hc read 라이브' : 'wrap 로그 폴백';
  buf.writeSegments(
    ix,
    cy++,
    [
      { text: '주소 ', fg: THEME.muted, bg: THEME.bgModal },
      { text: truncateWidth(target.address, 34, '…'), fg: THEME.fg, bg: THEME.bgModal, bold: true },
      { text: ` · ${srcBadge}`, fg: THEME.blue, bg: THEME.bgModal },
    ],
    iw
  );
  if (target.originAddress && target.originAddress !== target.address) {
    buf.writeText(
      ix,
      cy++,
      `카드 주소 ${target.originAddress} → 소유 hc 터미널 표시 중`,
      THEME.muted,
      THEME.bgModal,
      false,
      iw
    );
  }
  buf.writeSegments(
    ix,
    cy++,
    [
      { text: '모델 ', fg: THEME.muted, bg: THEME.bgModal },
      { text: truncateWidth(target.model || '-', 44, '…'), fg: THEME.fgSoft, bg: THEME.bgModal },
      { text: '  · 상태 ', fg: THEME.muted, bg: THEME.bgModal },
      { text: truncateWidth(target.status || '-', 20, '…'), fg: THEME.fgSoft, bg: THEME.bgModal },
    ],
    iw
  );
  cy++;

  const bodyRows = rect.y + rect.h - 2 - cy;
  const lines = state.terminalOutput ?? [];
  if (lines.length === 0) {
    buf.writeText(
      ix,
      cy,
      target.source === 'hc' ? '출력 대기 중… (hc read 폴)' : '출력 대기 중… (wrap 로그 대기)',
      THEME.muted,
      THEME.bgModal,
      false,
      iw
    );
  }
  const visible = lines.slice(Math.max(0, lines.length - bodyRows));
  for (const line of visible) {
    if (cy >= rect.y + rect.h - 2) break;
    buf.writeText(ix, cy++, truncateWidth(line, iw, '…'), THEME.fgSoft, THEME.bgModal, false, iw);
  }

  // 하단 안내 — hc 소스만 실제 attach 가능(wrap 폴백은 명령문 안내)
  const footY = rect.y + rect.h - 1;
  const foot =
    target.source === 'hc'
      ? ` a: 직접 attach (hc attach ${truncateWidth(target.address, 24, '…')}) · Esc: 닫기 `
      : ` attach 불가(wrap 폴백) — 명령: hc attach ${truncateWidth(target.address, 24, '…')} · Esc: 닫기 `;
  buf.writeText(ix, footY, foot, THEME.muted, THEME.bgModal, false, iw);
}

function renderAdvisorModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.purple,
    fillBg: THEME.bgModal,
    title: `Advisor · ${state.rosterLabels.advisor} · 메타 자문 상세 (세션 ${state.sessionId})`,
    titleColor: THEME.purple,
    rightLabel: 'Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  buf.writeSegments(
    ix,
    cy++,
    [
      { text: '현재 상태: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: `${state.advisorState}   `, fg: THEME.purple, bg: THEME.bgModal, bold: true },
      { text: '누적 호출: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: `${state.carbonCalls}회   `, fg: THEME.purple, bg: THEME.bgModal, bold: true },
      { text: '읽은 컨텍스트: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: state.tokensRead, fg: THEME.purple, bg: THEME.bgModal, bold: true },
    ],
    iw
  );
  buf.writeText(
    ix,
    cy++,
    '원칙: 일상 턴에서는 침묵하며 코드는 직접 수정하지 않고 Lead 리드 세션에 조언만 주입합니다.',
    THEME.muted,
    THEME.bgModal,
    false,
    iw
  );
  cy++;

  buf.writeText(ix, cy++, '트리거별 자문 기록', THEME.purple, THEME.bgModal, true, iw);
  for (const item of state.adviceHistory.slice(-6).reverse()) {
    if (cy >= rect.y + rect.h - 2) break;
    buf.writeSegments(
      ix,
      cy++,
      [
        { text: `${item.time}  `, fg: THEME.dim, bg: THEME.bgModal },
        { text: `[${item.triggerLabel}] `, fg: THEME.purple, bg: THEME.bgModal, bold: true },
        { text: `(토큰 ${item.tokensRead})`, fg: THEME.muted, bg: THEME.bgModal },
      ],
      iw
    );
    const wrapped = wrapByWidth(`» ${item.text}`, iw - 2, 2);
    for (const line of wrapped) {
      if (cy >= rect.y + rect.h - 1) break;
      buf.writeText(ix + 2, cy++, line, THEME.fg, THEME.bgModal, false, iw - 2);
    }
    cy++;
  }
}

function renderNeonModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  const statusLabel =
    state.neonState === 'run'
      ? '검증 중'
      : state.neonState === 'pass'
        ? '검증 통과'
        : state.neonState === 'fail'
          ? '검증 주의'
          : '대기 중';

  buf.drawBox(rect, {
    style: 'double',
    borderColor: state.neonState === 'fail' ? THEME.trafficRed : THEME.neon,
    fillBg: THEME.bgModal,
    title: `Verifier · ${state.rosterLabels.verifier} · 독립 교차 검증 인스펙터 (통과 ${state.neonVerified}건)`,
    titleColor: THEME.neon,
    rightLabel: 'Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  buf.writeSegments(
    ix,
    cy++,
    [
      { text: '현재 상태: ', fg: THEME.muted, bg: THEME.bgModal },
      {
        text: `${statusLabel}   `,
        fg:
          state.neonState === 'pass'
            ? THEME.green
            : state.neonState === 'fail'
              ? THEME.trafficRed
              : THEME.neon,
        bg: THEME.bgModal,
        bold: true,
      },
      { text: '모델: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: `${state.neonModelFlag}   `, fg: THEME.fg, bg: THEME.bgModal },
      { text: '통과 누적: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: `${state.neonVerified}회`, fg: THEME.neon, bg: THEME.bgModal, bold: true },
    ],
    iw
  );

  // 진행률 바
  const barW = Math.min(34, Math.max(12, iw - 26));
  const pctStr = state.neonState === 'idle' ? ' — ' : `${state.neonProgress}%`;
  buf.writeText(ix, cy, '진행률: ', THEME.muted, THEME.bgModal);
  buf.drawProgressBar(
    ix + 8,
    cy,
    barW,
    state.neonState === 'idle' ? 0 : state.neonProgress / 100,
    state.neonState === 'fail' ? THEME.trafficRed : THEME.neon,
    THEME.bgNeonTrack
  );
  buf.writeText(
    ix + 8 + barW + 2,
    cy,
    `${pctStr}  ${state.neonLabel || '대기'}`,
    THEME.fgSoft,
    THEME.bgModal,
    false,
    iw - (8 + barW + 2)
  );
  cy++;

  buf.writeText(
    ix,
    cy++,
    '역할: Lead의 계획·변경 diff를 독립 검증해 누락·회귀를 차단합니다. (/neon <대상>)',
    THEME.muted,
    THEME.bgModal,
    false,
    iw
  );
  cy++;

  buf.writeText(ix, cy++, '최근 검증 결과', THEME.neon, THEME.bgModal, true, iw);
  for (const line of wrapByWidth(`» ${state.neonSummary}`, iw - 2, 2)) {
    if (cy >= rect.y + rect.h - 2) break;
    buf.writeText(ix + 2, cy++, line, THEME.fg, THEME.bgModal, false, iw - 2);
  }
  cy++;

  if (cy < rect.y + rect.h - 2) {
    buf.writeText(ix, cy++, '교차 검증 이력', THEME.neon, THEME.bgModal, true, iw);
  }
  if (state.neonHistory.length === 0) {
    if (cy < rect.y + rect.h - 1) {
      buf.writeText(
        ix + 2,
        cy,
        '아직 완료된 교차 검증 이력이 없습니다. /neon <검증 내용> 으로 실행해 보세요.',
        THEME.muted,
        THEME.bgModal,
        false,
        iw - 2
      );
    }
    return;
  }

  for (const item of state.neonHistory.slice(-6).reverse()) {
    if (cy >= rect.y + rect.h - 2) break;
    const badge = item.status === 'pass' ? '✓ 통과' : item.status === 'fail' ? '✕ 주의' : '◉ 진행';
    const badgeCol =
      item.status === 'pass'
        ? THEME.green
        : item.status === 'fail'
          ? THEME.trafficRed
          : THEME.neon;
    buf.writeSegments(
      ix,
      cy++,
      [
        { text: `${item.time}  `, fg: THEME.dim, bg: THEME.bgModal },
        { text: `[${badge}] `, fg: badgeCol, bg: THEME.bgModal, bold: true },
        { text: `${item.label} `, fg: THEME.neon, bg: THEME.bgModal, bold: true },
        { text: `(${item.model})`, fg: THEME.muted, bg: THEME.bgModal },
      ],
      iw
    );
    const wrapped = wrapByWidth(`» ${item.summary}`, iw - 2, 2);
    for (const line of wrapped) {
      if (cy >= rect.y + rect.h - 1) break;
      buf.writeText(ix + 2, cy++, line, THEME.fgSoft, THEME.bgModal, false, iw - 2);
    }
    cy++;
  }
}

function renderDecisionModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.green,
    fillBg: THEME.bgModal,
    title: `Decision Gate · 확률 분기 인스펙터 (총 ${state.totalForks.toLocaleString('en-US')} forks)`,
    titleColor: THEME.green,
    rightLabel: 'Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  buf.writeText(
    ix,
    cy++,
    '라우팅 임계값 정책: 확신도 p >= 0.70 이면 sharp(즉시 코드/도구 실행), p < 0.70 이면 split(Lead 에스컬레이션)',
    THEME.fgSoft,
    THEME.bgModal,
    false,
    iw
  );
  cy++;

  // 4개 라우트 전체(delegate_swarm 포함) 표시 — 공간 부족 시에만 forcedSplit/split 우선 노출
  for (const route of sortRoutesForDisplay(state.routes)) {
    if (cy >= rect.y + rect.h - 3) break;
    const isSplit = route.forcedSplit === true || route.p < 0.7;
    const color =
      route.forcedSplit === true ? THEME.trafficRed : isSplit ? THEME.orange : THEME.green;
    const track = isSplit ? THEME.bgOrangeTrack : THEME.bgGreenTrack;

    buf.writeText(ix, cy, padRightWidth(route.name, 20), color, THEME.bgModal, true);
    buf.drawProgressBar(ix + 22, cy, 28, route.p, color, track);
    buf.writeText(
      ix + 52,
      cy,
      route.forcedSplit === true
        ? `p=${route.p.toFixed(2)}  SPLIT! → 강제 split`
        : `p=${route.p.toFixed(2)}  ${isSplit ? 'split → Lead' : 'sharp → 코드 실행'}`,
      color,
      THEME.bgModal,
      true,
      iw - 52
    );
    cy++;

    // 상세 줄: 근거(실측/사전) · 표본 n · 연속 오류 · 강제 분기 사유
    const basisText =
      route.basis === 'measured' ? '실측' : route.basis === 'prior' ? '사전' : '—';
    let detail = `근거: ${basisText} · 표본 n=${route.samples ?? 0} · 연속 오류 ${route.consecutiveErrors ?? 0}회`;
    if (route.forcedSplit === true) {
      detail += ' · 강제 분기: 2연속 오류 강제 split';
    }
    buf.writeText(
      ix + 2,
      cy,
      detail,
      route.forcedSplit === true ? THEME.trafficRed : THEME.fgSoft,
      THEME.bgModal,
      false,
      iw - 2
    );
    cy += 2;
  }
}

function renderLogsModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  const filtered = getFilteredLogs(state);
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.fgSoft,
    fillBg: THEME.bgModal,
    title: `세션 기록 전체 보기 (필터: ${LOG_FILTER_LABELS[state.logFilter]}, 총 ${filtered.length}건)`,
    titleColor: THEME.fg,
    rightLabel: '↑/↓ 스크롤 · 0~5 필터 · Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 2;
  const iw = rect.w - 4;
  const visibleRows = rect.h - 3;
  const maxOffset = Math.max(0, filtered.length - visibleRows);
  const offset = Math.min(state.logScrollOffset, maxOffset);
  const end = filtered.length - offset;
  const start = Math.max(0, end - visibleRows);
  const slice = filtered.slice(start, end);

  let cy = rect.y + 1;
  for (let i = 0; i < slice.length; i++) {
    const row = slice[i]!;
    const isLast = offset === 0 && i === slice.length - 1;
    buf.writeText(ix, cy, row.time, THEME.dim, THEME.bgModal, false, 10);
    buf.writeText(
      ix + 10,
      cy,
      padRightWidth(row.agent, 18),
      resolveColorKey(row.color),
      THEME.bgModal,
      true,
      18
    );
    buf.writeText(
      ix + 29,
      cy,
      truncateWidth(row.message, iw - 29),
      isLast ? THEME.fg : THEME.fgSoft,
      THEME.bgModal,
      isLast,
      iw - 29
    );
    cy++;
  }
}

function renderResponseModal(buf: CellBuffer, rect: Rect, state: AppState): void {
  const statusTag = state.agentBusy ? '생성 중…' : state.phase;
  buf.drawBox(rect, {
    style: 'double',
    borderColor: THEME.orange,
    fillBg: THEME.bgModal,
    title: `Lead · 실제 응답 전문 (${state.modelName} · ${statusTag})`,
    titleColor: THEME.orange,
    rightLabel: '↑/↓ 스크롤 · / 입력 · Esc 닫기',
    rightLabelColor: THEME.muted,
    boldBorder: true,
  });

  const ix = rect.x + 3;
  const iw = rect.w - 6;
  let cy = rect.y + 2;

  buf.writeSegments(
    ix,
    cy++,
    [
      { text: '질문: ', fg: THEME.muted, bg: THEME.bgModal },
      { text: state.mainSummary, fg: THEME.orange, bg: THEME.bgModal, bold: true },
    ],
    iw
  );
  buf.drawHLine(ix, cy++, iw, '─', THEME.borderLog, THEME.bgModal);

  const rawText = state.latestResponse.trim();
  const bodyRows = Math.max(1, rect.y + rect.h - 2 - cy);

  if (!rawText) {
    const emptyMsg = state.agentBusy
      ? '모델이 도구를 실행하거나 응답을 생성하는 중입니다…'
      : '아직 생성된 응답이 없습니다. / 또는 i 를 눌러 작업을 지시해 보세요.';
    buf.writeText(ix, cy, emptyMsg, THEME.muted, THEME.bgModal, false, iw);
    return;
  }

  const allLines = wrapByWidth(rawText, iw, 400);
  const maxOffset = Math.max(0, allLines.length - bodyRows);
  const offset = Math.min(state.responseScrollOffset, maxOffset);
  const start = offset;
  const visible = allLines.slice(start, start + bodyRows);

  for (const line of visible) {
    if (cy >= rect.y + rect.h - 1) break;
    buf.writeText(ix, cy++, line, THEME.fg, THEME.bgModal, false, iw);
  }

  if (allLines.length > bodyRows) {
    const indicator = ` ${start + 1}-${Math.min(allLines.length, start + bodyRows)} / ${allLines.length}줄 `;
    buf.writeRight(ix, rect.y + rect.h - 1, iw, indicator, THEME.muted, THEME.bgModal);
  }
}
