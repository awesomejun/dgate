/**
 * 터미널 상세 뷰(Enter: 터미널 보기) 통합 유닛 테스트.
 *
 * 목적:
 * 1. 카드 선택(←/→·숫자) → Enter → modal==='terminal' 상태 전이.
 * 2. pid:N(wrap) 워커 카드의 소유 hc 터미널 주소 매핑(resolveTerminalTarget).
 * 3. Lead 카드 Enter → 리드 hc 터미널 상세 뷰 오픈(watch 모드).
 * 4. wrapProcToWorker가 ownerAddress를 채우는지(liveWorkerSync 계약).
 * 5. 터미널 모달 렌더 스모크 — 주소·모델·안내문 노출.
 *
 * 실행: `node --test tests/terminal-view.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  createLiveRosterSyncer,
  wrapProcToWorker,
  type HcTerminalSummary,
} from '../src/backend/liveWorkerSync.ts';
import { createInitialState } from '../src/state/store.ts';
import { applyKeyInput, resolveTerminalTarget, type KeyHandlerDeps } from '../src/cli.ts';
import type { AppState, SwarmCard } from '../src/types.ts';
import { renderFrame } from '../src/ui/renderApp.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function makeWatchState(): AppState {
  return createInitialState('watch');
}

function makeDeps(layoutKind = 'full'): KeyHandlerDeps {
  return {
    quitApp: () => {},
    executePrompt: () => {},
    filteredLogCount: () => 0,
    layoutKind: () => layoutKind,
    seekTo: () => {},
    filterShortcut: () => {},
  };
}

function makeLiveCard(over: Partial<SwarmCard> = {}): SwarmCard {
  return {
    name: '[repo] w-pi-x · pi:glm-5.3',
    model: 'pi:glm-5.3',
    progress: 0,
    description: 'grep 실행 중',
    status: 'running',
    address: 'tW1',
    ...over,
  };
}

test('1. swarm 포커스 ←/→ 카드 선택 → Enter로 terminal 모달 전이', () => {
  const state = makeWatchState();
  state.focus = 'swarm';
  state.liveWorkers = [makeLiveCard(), makeLiveCard({ address: 'tW2' }), makeLiveCard({ address: 'tW3' })];

  const deps = makeDeps();
  // ← 이동: 순환(wrap-around) 포함
  applyKeyInput({ kind: 'arrow', dir: 'left' }, state, deps);
  assert.equal(state.cardSelect, 2, '맨 왼쪽에서 ←는 마지막 카드로 순환');
  applyKeyInput({ kind: 'arrow', dir: 'right' }, state, deps);
  assert.equal(state.cardSelect, 0, '→로 다시 첫 카드');
  applyKeyInput({ kind: 'arrow', dir: 'right' }, state, deps);
  assert.equal(state.cardSelect, 1, '→ 한 칸 이동');

  // Enter → terminal 모달 + 선택 카드 주소
  applyKeyInput({ kind: 'enter' }, state, deps);
  assert.equal(state.modal, 'terminal');
  assert.equal(state.terminalView?.address, 'tW2');
  assert.equal(state.terminalView?.source, 'hc');

  // Esc 닫기
  applyKeyInput({ kind: 'escape' }, state, deps);
  assert.equal(state.modal, 'none');
});

test('2. 숫자 1~9 직접 카드 선택(full 레이아웃) + 범위 밖 무시', () => {
  const state = makeWatchState();
  state.focus = 'swarm';
  state.liveWorkers = [makeLiveCard(), makeLiveCard({ address: 'tW2' })];

  const deps = makeDeps('full');
  applyKeyInput({ kind: 'char', value: '2' }, state, deps);
  assert.equal(state.cardSelect, 1, '숫자 2 → 두 번째 카드');
  applyKeyInput({ kind: 'char', value: '5' }, state, deps);
  assert.equal(state.cardSelect, 1, '카드 수 초과 숫자는 선택 유지(로그 필터로 폴백되지 않게 swarm에서는 무시)');

  applyKeyInput({ kind: 'enter' }, state, deps);
  assert.equal(state.terminalView?.address, 'tW2');
});

test('3. resolveTerminalTarget — pid:N 워커의 소유 hc 터미널 매핑·폴백', () => {
  // (a) 소유 세션 있는 wrap 카드 → owner 주소를 hc read 대상으로
  const owned = resolveTerminalTarget(
    makeLiveCard({ address: 'pid:4242', ownerAddress: 'tOwner9' })
  );
  assert.equal(owned.address, 'tOwner9', '소유 hc 터미널 주소로 치환');
  assert.equal(owned.originAddress, 'pid:4242');
  assert.equal(owned.source, 'hc', 'attach 가능 소스');

  // (b) 고아 wrap 카드(소유 없음) → wrap 로그 폴백, attach 불가
  const orphan = resolveTerminalTarget(makeLiveCard({ address: 'pid:777' }));
  assert.equal(orphan.address, 'pid:777');
  assert.equal(orphan.source, 'wrap-log');

  // (c) 일반 hc 워커 카드 → 자기 주소
  const plain = resolveTerminalTarget(makeLiveCard({ address: 'tW1' }));
  assert.equal(plain.address, 'tW1');
  assert.equal(plain.source, 'hc');
});

test('4. wrapProcToWorker — 부모 hc 세션 주소를 ownerAddress로 채운다', () => {
  const parent: HcTerminalSummary = {
    address: 'tParent1',
    agent: 'zsh',
    name: 'lead-shell',
    state: 'live',
    status: 'working',
    cwd: REPO_ROOT,
  };
  const w = wrapProcToWorker(
    {
      wrapPid: 4242,
      ancestors: [1, 2],
      cli: 'pi',
      model: 'swe-2-max',
      effort: 'high',
      label: null,
      projectPath: REPO_ROOT,
      project: 'w-swe',
      route: undefined,
    },
    parent,
    '/nonexistent-wrap-logs'
  );
  assert.equal(w.address, 'pid:4242');
  assert.equal(w.ownerAddress, 'tParent1', 'pid → 소유 hc 주소 매핑 계약');
});

test('5. watch 모드 Lead 카드 Enter → 리드 hc 터미널 상세 뷰', () => {
  const state = makeWatchState();
  state.focus = 'main';
  state.leadAddress = 'tLead1';
  state.latestResponse = '이전 응답 본문';

  applyKeyInput({ kind: 'enter' }, state, makeDeps());
  assert.equal(state.modal, 'terminal', '리드 주소가 있으면 response 대신 터미널 뷰 우선');
  assert.equal(state.terminalView?.address, 'tLead1');

  // 리드 주소가 없으면 기존 동작(response 모달) 유지
  const state2 = makeWatchState();
  state2.focus = 'main';
  state2.leadAddress = null;
  state2.latestResponse = '응답 있음';
  applyKeyInput({ kind: 'enter' }, state2, makeDeps());
  assert.equal(state2.modal, 'response');
});

test('6. 라이브 카드 없을 때 Enter → 기존 swarm 매트릭스 모달 유지', () => {
  const state = makeWatchState();
  state.focus = 'swarm';
  applyKeyInput({ kind: 'enter' }, state, makeDeps());
  assert.equal(state.modal, 'swarm');
});

test('7. 터미널 모달 a키 — attach 훅 주입 시 호출, 미주입 시 안내 플래시', () => {
  // (a) 훅 주입 — hc 소스에서 호출된다
  const state = makeWatchState();
  state.focus = 'swarm';
  state.liveWorkers = [makeLiveCard({ address: 'tW1' })];
  const deps = makeDeps();
  let attached = '';
  deps.onTerminalAttach = (t) => {
    attached = t.address;
  };
  applyKeyInput({ kind: 'enter' }, state, deps);
  applyKeyInput({ kind: 'char', value: 'a' }, state, deps);
  assert.equal(attached, 'tW1');

  // (b) 훅 미주입 + wrap 폴백 소스 — 안내문 플래시
  const state2 = makeWatchState();
  state2.focus = 'swarm';
  state2.liveWorkers = [makeLiveCard({ address: 'pid:9' })];
  const deps2 = makeDeps();
  applyKeyInput({ kind: 'enter' }, state2, deps2);
  applyKeyInput({ kind: 'char', value: 'a' }, state2, deps2);
  assert.ok(state2.statusFlash?.includes('hc attach'), '복사 가능한 attach 명령 안내');
});

test('8. 터미널 모달 렌더 스모크 — 주소·모델·출력·attach 안내 노출', () => {
  const state = makeWatchState();
  state.modal = 'terminal';
  state.terminalView = {
    name: '[repo] w-swe · pi:swe-2-max',
    address: 'tW1',
    originAddress: 'pid:4242',
    model: 'pi · swe-2-max · high',
    status: 'running',
    source: 'hc',
  };
  state.terminalOutput = ['model swe-2-max not found — check roster.json', 'retrying...'];
  const text = renderFrame(state, 148, 43).toPlainString();
  assert.ok(text.includes('tW1'), '주소 노출');
  assert.ok(text.includes('pid:4242'), '원본 카드 주소(소유 매핑 힌트) 노출');
  assert.ok(text.includes('swe-2-max not found'), '실제 출력 라인 노출');
  assert.ok(text.includes('a: 직접 attach'), 'attach 안내 노출');

  // wrap 폴백 — attach 불가 안내
  state.terminalView = {
    name: 'wrap 카드',
    address: 'pid:9',
    originAddress: 'pid:9',
    model: 'pi',
    status: 'running',
    source: 'wrap-log',
  };
  const text2 = renderFrame(state, 148, 43).toPlainString();
  assert.ok(text2.includes('attach 불가'), 'wrap 폴백 attach 불가 안내');

  // 대상 없는 종료 카드 — 안내문만
  state.terminalView = null;
  state.terminalOutput = [];
  const text3 = renderFrame(state, 148, 43).toPlainString();
  assert.ok(text3.includes('대상 터미널 정보가 없습니다'), '종료 카드 안내 폴백');
});

test('9. compact 레이아웃에선 숫자가 탭 전환을 유지(카드 선택과 충돌 회피)', () => {
  const state = makeWatchState();
  state.focus = 'swarm';
  state.liveWorkers = [makeLiveCard(), makeLiveCard({ address: 'tW2' })];
  applyKeyInput({ kind: 'char', value: '2' }, state, makeDeps('compact'));
  assert.equal(state.compactTab, 1, 'compact에서 1~4는 탭 전환 우선');
  assert.equal(state.cardSelect, 0, '카드 선택은 바뀌지 않음');
});

test('10. createLiveRosterSyncer가 여전히 구성 가능(회귀 스모크)', () => {
  // 본 테스트 파일의 다른 계약과 무관하게 싱커 팩토리 회귀만 가볍게 확인한다.
  const syncer = createLiveRosterSyncer({
    repoDir: REPO_ROOT,
    onUpdate: () => {},
    execRunner: async () => JSON.stringify({ terminals: [] }),
  });
  syncer.stop();
  assert.ok(true);
});
