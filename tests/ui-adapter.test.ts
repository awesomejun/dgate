/**
 * W2-B 상태·UI 패스스루 및 `--demo` 격리 통합 테스트 (brief-w2b §3.D + plan-r2.1 §5.3·§7.2).
 *
 * 목적: `type:'decision'` 이벤트의 SSOT 확장 필드(id/basis/samples/consecutiveErrors/
 * forcedSplit) 전수 보존, forcedSplit split 집계(N7), UI 렌더러 4곳(전체 패널·compact·
 * 4분할 Argon·decision 모달)의 4번째 라우트(delegate_swarm) 노출 회귀 감시,
 * `--demo` 모드의 결정 DB 파일 미생성(완전 격리)을 검증한다.
 *
 * 실행: `node --test tests/ui-adapter.test.ts` (외부 의존성 0개, 임시 GEMINI_TRICK_DB_PATH 사용)
 *
 * 주의: 렌더 검증은 CellBuffer.toPlainString()의 플레인 텍스트(ANSI 제거 본연 형식)로
 * 판정한다 — ANSI 스트립이 별도로 필요 없다.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyDemoTime, createDemoController } from '../src/state/demoEngine.ts';
import {
  createInitialState,
  sortRoutesForDisplay,
  syncStateFromDecisionDb,
} from '../src/state/store.ts';
import { applyStreamEvent } from '../src/state/streamAdapter.ts';
import type { AppState, DecisionRoute } from '../src/types.ts';
import { renderFrame } from '../src/ui/renderApp.ts';
import { renderQuadRoleFrame } from '../src/ui/renderQuadRole.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');

/**
 * 검증용 4라우트 상태: 4번째 delegate_swarm에 forcedSplit+p 0.81+basis measured+
 * samples 12+consecutiveErrors 2를 주입(brief §3.D-3 시나리오 그대로).
 */
function makeQuadRouteState(mode: 'demo' | 'stream' = 'demo'): AppState {
  const state = createInitialState(mode);
  state.routes = [
    { name: '어느 파일', p: 0.89, id: 'file_select', basis: 'measured', samples: 14, consecutiveErrors: 0, forcedSplit: false },
    { name: '어느 도구', p: 0.94, id: 'tool_select', basis: 'prior', samples: 2, consecutiveErrors: 0, forcedSplit: false },
    { name: '재시도 또는 중단', p: 0.42, id: 'retry_or_abort', basis: 'prior', samples: 2, consecutiveErrors: 0, forcedSplit: false },
    { name: '스웜 위임', p: 0.81, id: 'delegate_swarm', basis: 'measured', samples: 12, consecutiveErrors: 2, forcedSplit: true },
  ];
  const split = state.routes.filter((r) => r.forcedSplit === true || r.p < 0.7).length;
  state.sharpCount = state.routes.length - split;
  state.splitCount = split;
  return state;
}

test('streamAdapter: decision 이벤트가 SSOT 확장 필드 5개를 전수 보존한다', () => {
  const state = createInitialState('stream');
  applyStreamEvent(state, {
    type: 'decision',
    forks: 7,
    routes: [
      { name: '어느 파일', p: 0.89, id: 'file_select', basis: 'measured', samples: 14, consecutiveErrors: 0, forcedSplit: false },
      { name: '스웜 위임', p: 0.92, id: 'delegate_swarm', basis: 'measured', samples: 12, consecutiveErrors: 2, forcedSplit: true },
    ],
  });

  assert.equal(state.totalForks, 7);
  assert.equal(state.routes.length, 2);

  const r1 = state.routes[0]!;
  assert.equal(r1.name, '어느 파일');
  assert.equal(r1.p, 0.89);
  assert.equal(r1.id, 'file_select');
  assert.equal(r1.basis, 'measured');
  assert.equal(r1.samples, 14);
  assert.equal(r1.consecutiveErrors, 0);
  assert.equal(r1.forcedSplit, false);

  const r2 = state.routes[1]!;
  assert.equal(r2.id, 'delegate_swarm');
  assert.equal(r2.basis, 'measured');
  assert.equal(r2.samples, 12);
  assert.equal(r2.consecutiveErrors, 2);
  assert.equal(r2.forcedSplit, true);
  assert.equal(r2.p, 0.92);

  // N7: forcedSplit(p=0.92 ≥ 0.70)도 splitCount로 집계되어야 한다
  assert.equal(state.splitCount, 1);
  assert.equal(state.sharpCount, 1);
});

test('sortRoutesForDisplay: forcedSplit 최우선 → p<0.70 차우선 → 원래 순서 보존', () => {
  const sorted = sortRoutesForDisplay(makeQuadRouteState().routes);
  assert.equal(sorted.length, 4);
  assert.equal(sorted[0]!.id, 'delegate_swarm'); // forcedSplit (4번째였던 라우트)
  assert.equal(sorted[1]!.id, 'retry_or_abort'); // p=0.42 split
  assert.equal(sorted[2]!.id, 'file_select'); // 이후 원래 순서
  assert.equal(sorted[3]!.id, 'tool_select');
});

test('--demo 격리: applyDemoTime·syncStateFromDecisionDb(demo)·--demo --snapshot 모두 DB 파일을 만들지 않는다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `w2bdemo-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const env = { ...process.env, GEMINI_TRICK_DB_PATH: dbPath, DGATE_DB_PATH: undefined, DECISION_ORCHESTRATOR_DB_PATH: undefined };

  try {
    // 1) 데모 엔진 순수 계산 — DB 접근 없음
    const state = createInitialState('demo');
    applyDemoTime(state, 10, createDemoController());
    assert.equal(state.routes.length, 4);
    assert.ok(state.routes.some((r) => r.name === '스웜 위임'));

    // 2) demo 모드 구독 헬퍼는 즉시 no-op — DB 미생성
    assert.equal(syncStateFromDecisionDb(state, dbPath, process.cwd()), false);
    assert.equal(fs.existsSync(dbPath), false);

    // 3) CLI --demo --snapshot 실행 — exit 0 + DB 파일·WAL/SHM 전부 미생성(행수 0)
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, '--demo', '--snapshot', '--time', '10', '--cols', '148', '--rows', '43'],
      { env, encoding: 'utf8', stdin: 'ignore' }
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(fs.existsSync(dbPath), false, '--demo 실행이 결정 DB를 생성해서는 안 된다');
    assert.equal(
      fs.readdirSync(base).length,
      0,
      `임시 디렉터리에 파일이 생성됨: ${fs.readdirSync(base).join(', ')}`
    );
    // 데모 스냅샷 회귀: 4번째 라우트(delegate_swarm) 노출 확인
    assert.ok(res.stdout.includes('스웜 위임'), '데모 스냅샷에 스웜 위임 라우트가 보여야 한다');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderFrame 전체 레이아웃(148×43): 스웜 위임·SPLIT!·m:14·p:2 노출', () => {
  const state = makeQuadRouteState();
  const text = renderFrame(state, 148, 43).toPlainString();
  assert.ok(text.includes('스웜 위임'), '4번째 라우트(delegate_swarm)가 은닉되어서는 안 된다');
  assert.ok(text.includes('SPLIT!'), 'forcedSplit 경고가 보여야 한다');
  assert.ok(text.includes('m:14'), 'measured 표기(m:14)가 보여야 한다');
  assert.ok(text.includes('p:2'), 'prior 표기(p:2)가 보여야 한다');
});

test('renderFrame compact 레이아웃(80×24): 스웜 위임·SPLIT! 노출', () => {
  const state = makeQuadRouteState();
  state.compactTab = 0;
  const text = renderFrame(state, 80, 24).toPlainString();
  assert.ok(text.includes('스웜 위임'), 'compact에서도 delegate_swarm이 보여야 한다');
  assert.ok(text.includes('SPLIT!'), 'compact에서도 forcedSplit 경고가 보여야 한다');
  assert.ok(text.includes('m:14'), 'compact에서도 measured 축약 표기가 보여야 한다');
});

test('renderQuadRoleFrame argon(72×20): 스웜 위임·ERR2/SPLIT 노출', () => {
  const state = makeQuadRouteState();
  const text = renderQuadRoleFrame(state, 'argon', 72, 20).toPlainString();
  assert.ok(text.includes('스웜 위임'), '4분할 소형 창에서도 delegate_swarm이 잘리지 않아야 한다');
  assert.ok(text.includes('ERR2'), 'forcedSplit의 ERR2 축약 표지가 보여야 한다');
  assert.ok(text.includes('SPLIT'), 'forcedSplit의 SPLIT 경고가 보여야 한다');
});

test('renderFrame decision 모달(148×43): 4라우트 전체 + 실측 + n=12 + 2연속 노출', () => {
  const state = makeQuadRouteState();
  state.modal = 'decision';
  const text = renderFrame(state, 148, 43).toPlainString();
  for (const name of ['어느 파일', '어느 도구', '재시도 또는 중단', '스웜 위임']) {
    assert.ok(text.includes(name), `모달에 라우트 "${name}"이(가) 누락되지 않아야 한다`);
  }
  assert.ok(text.includes('실측'), '근거(실측) 표기가 보여야 한다');
  assert.ok(text.includes('사전'), '근거(사전) 표기가 보여야 한다');
  assert.ok(text.includes('n=12'), '표본 n=12가 보여야 한다');
  assert.ok(text.includes('2연속'), '강제 분기 사유(2연속 오류 강제 split)가 보여야 한다');
});

test('구버전 호환: basis 없는 라우트도 집계·렌더가 깨지지 않는다', () => {
  const state = createInitialState('stream');
  applyStreamEvent(state, {
    type: 'decision',
    routes: [
      { name: '어느 파일', p: 0.5 },
      { name: '스웜 위임', p: 0.9 },
    ] satisfies Array<{ name: string; p: number }>,
  });
  assert.equal(state.splitCount, 1);
  assert.equal(state.sharpCount, 1);
  const legacy: DecisionRoute[] = [
    { name: '어느 파일', p: 0.89 },
    { name: '스웜 위임', p: 0.81 },
  ];
  const sorted = sortRoutesForDisplay(legacy);
  assert.equal(sorted.length, 2); // 원래 순서 유지(정렬 조건 없음)
  const text = renderFrame({ ...state, routes: legacy, modal: 'decision' }, 148, 43).toPlainString();
  assert.ok(text.includes('스웜 위임'));
});
