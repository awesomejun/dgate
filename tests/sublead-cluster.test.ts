/**
 * Sublead Phase 2b — Workers 클러스터 그룹핑 단위·렌더·선택 정합 테스트.
 *
 * 실행: `node --test tests/sublead-cluster.test.ts`
 * 범위:
 * - `clusterWorkersBySublead`: 혼합 분할·sublead 없음·죽은 sublead·입력 순서 보존·중복 없음
 * - `formatSubleadOwnerBadge`: `[repo] sublead · name` / `sublead-name` / `sub-name` 정규화 테이블
 * - `orderSwarmCardsByCluster`: 원본 배열 불변·클러스터 정렬·소유 배지·총 개수 보존
 * - `renderFrame` + `applyKeyInput`: TUI 소유 배지 노출·`+N개 더` 초과 배지·`cardSelect` 정합·무회귀
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clusterWorkersBySublead,
  formatSubleadOwnerBadge,
  orderSwarmCardsByCluster,
  type LiveWorkerInfo,
} from '../src/backend/liveWorkerSync.ts';
import { applyKeyInput, type KeyHandlerDeps } from '../src/cli.ts';
import { createInitialState } from '../src/state/store.ts';
import type { SwarmCard } from '../src/types.ts';
import { renderFrame } from '../src/ui/renderApp.ts';

function makeWorker(over: Partial<LiveWorkerInfo>): LiveWorkerInfo {
  return {
    slot: 'coder',
    badge: 'pi:glm-5.3 (실행 중)',
    shortModel: 'pi:glm-5.3',
    modelName: 'glm-zcode/glm-5.3',
    address: 'pid:100',
    name: 'w-coder',
    cwd: '/tmp/dgate',
    repoTag: 'dgate',
    activity: '테스트 작업 중',
    status: 'working',
    ...over,
  };
}

function makeCard(over: Partial<SwarmCard>): SwarmCard {
  return {
    name: 'w-coder',
    model: 'pi · glm-5.3',
    progress: 0,
    description: '작업 실행 중',
    status: 'running',
    address: 'pid:100',
    ...over,
  };
}

function makeDeps(): KeyHandlerDeps {
  return {
    quitApp: () => {},
    executePrompt: () => {},
    filteredLogCount: () => 0,
    layoutKind: () => 'full',
    seekTo: () => {},
    filterShortcut: () => {},
  };
}

test('clusterWorkersBySublead — (a)~(e) 혼합 분할·무sublead·죽은 소유자·순서 보존·중복 없음', () => {
  // (a) sublead + 소속 + 미소속 혼합 분할
  const mixed: LiveWorkerInfo[] = [
    makeWorker({ address: 'pid:1', name: 'w-unowned-1', slot: 'coder' }),
    makeWorker({ address: 'tSubB', name: 'sublead-billing', slot: 'sublead' }),
    makeWorker({ address: 'pid:2', name: 'w-auth-1', slot: 'coder', ownerAddress: 'tSubA' }),
    makeWorker({ address: 'tSubA', name: 'sublead-auth', slot: 'sublead' }),
    makeWorker({ address: 'pid:3', name: 'w-bill-1', slot: 'explore', ownerAddress: 'tSubB' }),
    makeWorker({ address: 'pid:4', name: 'w-auth-2', slot: 'coder', ownerAddress: 'tSubA' }),
    makeWorker({ address: 'pid:5', name: 'w-lead-direct', slot: 'coder', ownerAddress: 'tLead0' }),
    makeWorker({ address: 'tSubIdle', name: 'sublead-idle', slot: 'sublead' }),
  ];
  const res = clusterWorkersBySublead(mixed);
  assert.deepEqual(
    res.clusters.map((c) => c.sublead.address),
    ['tSubB', 'tSubA', 'tSubIdle'],
    '클러스터 순서는 입력 sublead 순서를 보존'
  );
  assert.deepEqual(
    res.clusters[0]!.workers.map((w) => w.address),
    ['pid:3']
  );
  assert.deepEqual(
    res.clusters[1]!.workers.map((w) => w.address),
    ['pid:2', 'pid:4'],
    '클러스터 내부 워커도 입력 순서 보존'
  );
  assert.deepEqual(res.clusters[2]!.workers, [], '소속 워커가 없는 sublead도 헤더로 유지');
  assert.deepEqual(
    res.unowned.map((w) => w.address),
    ['pid:1', 'pid:5'],
    '미소속 wrap + 최상위 리드 직속만 순서 보존'
  );

  // (b) sublead가 없으면 clusters=[] · 전부 unowned
  const noSublead: LiveWorkerInfo[] = [
    makeWorker({ address: 'pid:10', slot: 'coder' }),
    makeWorker({ address: 'pid:11', slot: 'explore', ownerAddress: 'tLead0' }),
  ];
  const flat = clusterWorkersBySublead(noSublead);
  assert.equal(flat.clusters.length, 0);
  assert.deepEqual(
    flat.unowned.map((w) => w.address),
    ['pid:10', 'pid:11']
  );

  // (c) owner가 죽은 sublead 주소면 자연히 unowned로 떨어진다
  const deadOwner: LiveWorkerInfo[] = [
    makeWorker({ address: 'tSubAlive', name: 'sublead-alive', slot: 'sublead' }),
    makeWorker({ address: 'pid:20', name: 'w-dead-owner', slot: 'coder', ownerAddress: 'tSubDead' }),
    makeWorker({ address: 'pid:21', name: 'w-alive-child', slot: 'coder', ownerAddress: 'tSubAlive' }),
  ];
  const afterDeath = clusterWorkersBySublead(deadOwner);
  assert.equal(afterDeath.clusters.length, 1);
  assert.deepEqual(
    afterDeath.clusters[0]!.workers.map((w) => w.address),
    ['pid:21']
  );
  assert.deepEqual(
    afterDeath.unowned.map((w) => w.address),
    ['pid:20']
  );

  // (d) sublead 자신은 clusters 헤더에서만 나오고 unowned나 다른 클러스터에 중복되지 않는다
  assert.ok(
    res.unowned.every((w) => w.slot !== 'sublead'),
    'unowned에 sublead 중복 없음'
  );
  const totalCount =
    res.clusters.reduce((acc, c) => acc + 1 + c.workers.length, 0) + res.unowned.length;
  assert.equal(totalCount, mixed.length, '분할 후 총 워커 수 불변');

  // (e) 빈 입력
  const empty = clusterWorkersBySublead([]);
  assert.deepEqual(empty, { clusters: [], unowned: [] });
});

test('formatSubleadOwnerBadge — 카드명 정규화 테이블', () => {
  const cases = [
    ['sublead-auth', '↳ sublead-auth'],
    ['[dgate] sublead · sublead-auth', '↳ sublead-auth'],
    ['[dgate] sublead · auth', '↳ sublead-auth'],
    ['sublead · billing', '↳ sublead-billing'],
    ['sub-engine', '↳ sub-engine'],
    ['auth', '↳ sublead-auth'],
    ['', '↳ sublead'],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(formatSubleadOwnerBadge(input), expected, `input=${JSON.stringify(input)}`);
  }
});

test('Node TUI 렌더 · cardSelect 정합 · 초과 배지 · 무sublead 회귀 0', () => {
  // (a) 클러스터 정렬 + 소유 배지 + 원본 liveWorkers 불변
  const state = createInitialState('watch');
  state.focus = 'swarm';
  const rawCards: SwarmCard[] = [
    makeCard({ name: 'w-unowned', address: 'pid:1', slot: 'coder' }),
    makeCard({ name: '[dgate] sublead · sublead-auth', address: 'tSub1', slot: 'sublead' }),
    makeCard({ name: 'w-auth-1', address: 'pid:2', slot: 'coder', ownerAddress: 'tSub1' }),
  ];
  state.liveWorkers = rawCards;

  const ordered = orderSwarmCardsByCluster(rawCards);
  assert.deepEqual(
    ordered.map((e) => [e.card.address, e.ownerBadge]),
    [
      ['tSub1', null],
      ['pid:2', '↳ sublead-auth'],
      ['pid:1', null],
    ]
  );
  // 원본 liveWorkers 순서는 변하지 않는다
  assert.deepEqual(
    state.liveWorkers.map((c) => c.address),
    ['pid:1', 'tSub1', 'pid:2']
  );

  // (b) 렌더 결과: 클러스터 순서(sublead → 소속 → 미소속) + 소속 카드 소유 배지 노출
  const frame = renderFrame(state, 148, 43).toPlainString();
  const posSub = frame.indexOf('sublead-auth');
  const posOwned = frame.indexOf('w-auth-1');
  const posUnowned = frame.indexOf('w-unowned');
  assert.ok(posSub >= 0 && posOwned >= 0 && posUnowned >= 0, '세 카드 모두 렌더됨');
  assert.ok(frame.includes('↳ sublead-auth'), '소속 워커 카드에 소유 배지 노출');
  assert.ok(posOwned < posUnowned, '소속 워커가 미소속 워커보다 앞에 배치됨');

  // (c) cardSelect 인덱스 정합: 정렬된 0번(tSub1)·2번(pid:1) 선택 후 Enter → 정확한 터미널 오픈
  state.cardSelect = 0;
  applyKeyInput({ kind: 'enter' }, state, makeDeps());
  assert.equal(state.modal, 'terminal');
  assert.equal(state.terminalView?.address, 'tSub1', '0번 카드 Enter → 정렬 0번 sublead 오픈');

  state.modal = 'none';
  state.cardSelect = 2;
  applyKeyInput({ kind: 'enter' }, state, makeDeps());
  assert.equal(state.terminalView?.originAddress, 'pid:1', '2번 카드 Enter → 정렬 2번 미소속 워커 오픈');

  // (d) 슬롯 초과 `+N개 더` 배지는 총 카드 수 기준으로 동작(148열 최대 4슬롯 → 5카드면 +1개 더)
  const overflowState = createInitialState('watch');
  overflowState.liveWorkers = [
    makeCard({ name: 'sublead-auth', address: 'tSub1', slot: 'sublead' }),
    makeCard({ name: 'w-a1', address: 'pid:11', slot: 'coder', ownerAddress: 'tSub1' }),
    makeCard({ name: 'w-a2', address: 'pid:12', slot: 'coder', ownerAddress: 'tSub1' }),
    makeCard({ name: 'w-u1', address: 'pid:13', slot: 'coder' }),
    makeCard({ name: 'w-u2', address: 'pid:14', slot: 'coder' }),
  ];
  const overflowFrame = renderFrame(overflowState, 148, 43).toPlainString();
  assert.ok(overflowFrame.includes('+1개 더'), '총 5카드(최대 4슬롯)에서 +1개 더 배지 유지');

  // (e) sublead가 없으면 배지 없음·원본 순서 그대로(기존 워크플로우 회귀 0)
  const plainState = createInitialState('watch');
  plainState.liveWorkers = [
    makeCard({ name: 'w-first', address: 't1', slot: 'coder' }),
    makeCard({ name: 'w-second', address: 't2', slot: 'explore' }),
  ];
  const plainFrame = renderFrame(plainState, 148, 43).toPlainString();
  assert.ok(!plainFrame.includes('↳'), 'sublead 없으면 소유 배지 없음');
  assert.ok(
    plainFrame.indexOf('w-first') < plainFrame.indexOf('w-second'),
    'sublead 없으면 기존 카드 순서 그대로'
  );
});
