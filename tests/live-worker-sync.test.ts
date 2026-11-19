/**
 * 목적: Live TUI Sync v2(`src/backend/liveWorkerSync.ts` + cli/렌더 배선) 단위 검증.
 * - `isWorkerTerminal`/`inferLiveWorkerSlot`: pi·dg wrap·devin·HERDR_ROLE 슬롯 판정,
 *   dg-monitor·셸 제외
 * - `extractRepoTag`/`matchesRepoScope`: 일반 경로·`.herdr/worktrees` 환원, 스코프 매칭
 * - `extractLastActivityLine`: ANSI 제거·`[hc]`/박스/스피너 스킵·시크릿 리덕션·절단
 * - `mergeLiveRosterLabels`: 라이브 오버라이드·watchedLead 보존·대기 라벨 복귀
 * - `createLiveRosterSyncer`: roster.json 핫리로드 + `hc` 오류 fail-safe (mock 실행기,
 *   라이브 `hc` 스폰 0회 — 전부 결정적)
 * - 렌더 헤더: `repo=<이름>` / `전체` 표기, 라이브 워커 카드 노출, 80/100/120/148열
 *   카운터 충돌 없음(우측 폭 선점산)
 * - 회귀 방지: 라이브 동기화(0·1 워커) 후 applyTranscriptStep 무동작(cards 3슬롯
 *   불변), working→done 전환(hc get 캐시 + 매 틱 ls 상태 병합), malformed hc ls JSON
 *   시 이전 워커 보존, 박스형 [hc] 푸터·겹선 테두리 스킵, 루트('/') 스코프, ksh/dash/pwsh 제외
 * - 유출 스캔: 변경 파일에 홈 절대경로·키 패턴 0건
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  createLiveRosterSyncer,
  extractLastActivityLine,
  extractRepoTag,
  inferLiveWorkerSlot,
  isWorkerTerminal,
  matchesRepoScope,
  mergeLiveRosterLabels,
  type HcTerminalDetail,
  type LiveWorkerInfo,
  type MergedLiveRoster,
} from '../src/backend/liveWorkerSync.ts';
import {
  applyTranscriptStep,
  type TranscriptStep,
  type TranscriptToolCall,
} from '../src/backend/transcriptMapper.ts';
import { createInitialState } from '../src/state/store.ts';
import { renderFrame } from '../src/ui/renderApp.ts';
import type { RosterDisplayLabels } from '../src/types.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function makeBaseLabels(): RosterDisplayLabels {
  return {
    profileName: 'quota-saver',
    rosterSource: 'builtin',
    lead: 'pi:glm-5.3',
    explore: 'pi:deepseek-v4.1-flash',
    coder: 'devin',
    verifier: 'pi:deepseek-v4.1-flash',
    advisor: 'pi:glm-5.3',
  };
}

function makeWorker(partial: Partial<LiveWorkerInfo>): LiveWorkerInfo {
  return {
    slot: 'coder',
    badge: 'pi:glm-5.3 (실행 중)',
    shortModel: 'pi:glm-5.3',
    modelName: 'glm-zcode/glm-5.3',
    address: 'tA',
    name: 'w-pi-x',
    cwd: '/tmp/my-repo',
    repoTag: 'my-repo',
    activity: '작업 실행 중',
    status: null,
    ...partial,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** roster 탐색 환경 격리 — 실제 전역 roster·env 영향 차단 (복구 필수). */
function isolateRosterEnv(base: string): { restore: () => void } {
  const savedHrp = process.env.HERDR_ROSTER_PATH;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(base, 'xdg');
  return {
    restore: () => {
      if (savedHrp === undefined) delete process.env.HERDR_ROSTER_PATH;
      else process.env.HERDR_ROSTER_PATH = savedHrp;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    },
  };
}

function writeTempRoster(rosterPath: string, profile: string, leadCli: string, leadModel: string): void {
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      defaultProfile: profile,
      profiles: {
        [profile]: { roles: { lead: { cli: leadCli, model: leadModel } } },
      },
    })
  );
}

// ---------------------------------------------------------------------------

test('1. inferLiveWorkerSlot — pi --model / dg wrap / devin / HERDR_ROLE / 모니터·셸 제외', () => {
  // (a) pi --model — 이름 w- 접두 → coder 슬롯, 화면 원문에서 활동 추출
  const pi = inferLiveWorkerSlot(
    {
      address: 't1',
      agent: 'pi',
      name: 'w-pi-glm-tui-live',
      state: 'live',
      cwd: '/tmp/my-repo',
      argv: [
        '/tools/pi',
        '--provider',
        'opencodex',
        '--model',
        'glm-zcode/glm-5.3',
        '--thinking',
        'max',
        '프롬프트',
      ],
    },
    '\x1b[32m테스트 12/12 통과\x1b[0m'
  );
  assert.equal(pi?.slot, 'coder');
  assert.equal(pi?.shortModel, 'pi:glm-5.3');
  assert.equal(pi?.badge, 'pi:glm-5.3 (실행 중)');
  assert.equal(pi?.modelName, 'glm-zcode/glm-5.3');
  assert.equal(pi?.repoTag, 'my-repo');
  assert.equal(pi?.activity, '테스트 12/12 통과');

  // (b) dg wrap 래퍼 + env — 래퍼를 벗겨 실제 CLI·모델·HERDR_ROLE 슬롯 인식
  const wrapped = inferLiveWorkerSlot({
    address: 't2',
    agent: 'node',
    name: 'coder1-abc123',
    state: 'live',
    cwd: '/tmp/my-repo/.herdr/worktrees/coder1-abc123',
    argv: [
      'node',
      '/dg/dg.ts',
      'wrap',
      '--route',
      'tool_select',
      '--',
      'env',
      'HERDR_ROLE=coder',
      'HERDR_READONLY=1',
      '/tools/pi',
      '--model',
      'glm-zcode/glm-5.3',
      '--no-approve',
      '작업',
    ],
  });
  assert.equal(wrapped?.slot, 'coder');
  assert.equal(wrapped?.shortModel, 'pi:glm-5.3');
  assert.equal(wrapped?.repoTag, 'my-repo');
  assert.equal(wrapped?.activity, '작업 실행 중'); // 화면 원문 없음 + status 없음 → 폴백

  // (c) devin — 모델 미지정 → CLI명 그대로 배지, status 폴백 활동
  const devin = inferLiveWorkerSlot({
    address: 't3',
    agent: 'devin',
    name: 'coder2-abc123',
    state: 'live',
    status: 'working',
    cwd: '/tmp/my-repo',
    argv: ['/tools/devin', '--permission-mode', 'auto', '--', '수정 반영'],
  });
  assert.equal(devin?.slot, 'coder');
  assert.equal(devin?.shortModel, 'devin');
  assert.equal(devin?.modelName, 'devin');
  assert.equal(devin?.badge, 'devin (실행 중)');
  assert.equal(devin?.activity, 'working 작업 중');

  // (d) HERDR_ROLE=verifier — argv 슬롯이 이름 규약보다 우선
  const verifier = inferLiveWorkerSlot({
    address: 't4',
    agent: 'pi',
    name: 'verify-abc123',
    state: 'live',
    cwd: '/tmp/my-repo',
    argv: [
      'env',
      'HERDR_ROLE=verifier',
      'HERDR_READONLY=1',
      '/tools/pi',
      '--model',
      'command-code/deepseek-deepseek-v4.1-flash',
      '프롬프트',
    ],
  });
  assert.equal(verifier?.slot, 'verifier');
  assert.equal(verifier?.shortModel, 'pi:deepseek-v4.1-flash');

  // (e) HERDR_ROLE=carbon → advisor 슬롯 환원
  const advisor = inferLiveWorkerSlot({
    address: 't5',
    agent: 'pi',
    name: 'carbon-gate1-abc123',
    state: 'live',
    cwd: '/tmp/my-repo',
    argv: ['env', 'HERDR_ROLE=carbon', '/tools/pi', '--model', 'glm-zcode/glm-5.3'],
  });
  assert.equal(advisor?.slot, 'advisor');

  // (f) lead — 이름 규약
  const lead = inferLiveWorkerSlot({
    address: 't6',
    agent: 'pi',
    name: 'lead-abc123',
    state: 'live',
    cwd: '/tmp/my-repo',
    argv: ['env', 'HERDR_ROLE=lead', '/tools/pi', '--model', 'glm-zcode/glm-5.3'],
  });
  assert.equal(lead?.slot, 'lead');

  // (g) 모니터·셸·비라이브 제외 — 워커 집계 대상 아님
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'node', name: 'dg-monitor', state: 'live' }), false);
  assert.equal(
    isWorkerTerminal({ address: 'a', agent: 'node', name: 'dg-monitor-myrepo', state: 'live', parent: 't9' }),
    false
  );
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'node', name: 'mon-xyz', state: 'live' }), false);
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'zsh', state: 'live' }), false);
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'zsh', name: 'w-shell', state: 'live' }), false);
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'antigravity', name: 'w-agy', state: 'live' }), false);
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'pi', name: 'w-x', state: 'dead' }), false);
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'pi', state: 'live' }), false); // 근거 없음

  // (h) 긍정 — 이름 접두 / parent+워커 CLI 에이전트
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'pi', name: 'w-x', state: 'live' }), true);
  assert.equal(isWorkerTerminal({ address: 'a', agent: 'devin', parent: 't1', state: 'live' }), true);
});

test('2. extractRepoTag / matchesRepoScope — 일반 경로·워크트리 환원·스코프 판정', () => {
  assert.equal(extractRepoTag(null), 'unknown');
  assert.equal(extractRepoTag(''), 'unknown');
  assert.equal(extractRepoTag('   '), 'unknown');
  assert.equal(extractRepoTag('/a/b/my-repo'), 'my-repo');
  assert.equal(extractRepoTag('/a/b/my-repo/'), 'my-repo');
  assert.equal(extractRepoTag('/a/b/my-repo/.herdr/worktrees/coder1'), 'my-repo');
  assert.equal(extractRepoTag('/a/b/my-repo/.herdr/worktrees/coder1/'), 'my-repo');
  assert.equal(extractRepoTag('C:\\x\\my-repo\\.herdr\\worktrees\\wt1'), 'my-repo');

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-scope-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-other-')));
  try {
    const repoDir = path.join(tmp, 'my-repo');
    const sub = path.join(repoDir, 'src');
    const worktree = path.join(repoDir, '.herdr', 'worktrees', 'coder1');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    assert.equal(matchesRepoScope(repoDir, repoDir), true);
    assert.equal(matchesRepoScope(sub, repoDir), true);
    assert.equal(matchesRepoScope(worktree, repoDir), true); // 워크트리도 소속 레포 스코프
    assert.equal(matchesRepoScope(other, repoDir), false); // 무관 레포
    assert.equal(matchesRepoScope(path.join(other, 'sub'), repoDir), false);
    assert.equal(matchesRepoScope(sub, null), true); // 전역 관측
    assert.equal(matchesRepoScope(sub, undefined), true);
    assert.equal(matchesRepoScope(null, repoDir), false); // cwd 미상 + 스코프 지정
    assert.equal(matchesRepoScope(undefined, undefined), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('3. extractLastActivityLine — ANSI 제거·[hc]/박스/스피너 스킵·리덕션·절단', () => {
  // ANSI 색상 코드 제거
  assert.equal(extractLastActivityLine('\x1b[32m테스트 12/12 통과\x1b[0m'), '테스트 12/12 통과');
  assert.equal(extractLastActivityLine('\x1b]0;title\x07\x1b[1m실제 작업\x1b[0m'), '실제 작업');

  // 아래→위 훑기: 빈 줄·[hc] 상태줄·스피너·구분선 건너뛰고 의미 줄 선택
  const screen = [
    '⠋',
    '┌──────────────┐',
    '[hc] t18s · live · pi',
    '   ',
    '\x1b[1m\x1b[32m검증 통과: 12/12\x1b[0m',
    '[hc] done',
    '⠹',
    '─ ─ ─ ─ ─',
  ].join('\n');
  assert.equal(extractLastActivityLine(screen), '검증 통과: 12/12');

  // 박스 내부 텍스트 가장자리 장식 제거
  assert.equal(extractLastActivityLine('│ 패치 적용 중 │'), '패치 적용 중');

  // 시크릿 리덕션 — sk-… / AIza… / Bearer
  const sk = extractLastActivityLine('curl -H "Authorization: Bearer sk-abcdefghijklmnop1234" https://x.io');
  assert.ok(sk !== null && !sk.includes('sk-abcdefghijklmnop1234'), `sk leaked: ${sk}`);
  assert.ok(sk !== null && sk.includes('<redacted>'));
  const googleKey = extractLastActivityLine('export KEY=AIzaSyD-12345678901234567890x 완료');
  assert.ok(googleKey !== null && !googleKey.includes('AIzaSyD'), `AIza leaked: ${googleKey}`);

  // 절단 — maxChars(68) 초과 시 … 마감
  const long = extractLastActivityLine('x'.repeat(100));
  assert.equal(long?.length, 68);
  assert.ok(long?.endsWith('…'));
  assert.equal(extractLastActivityLine('y'.repeat(50), 10)?.length, 10);

  // 의미 줄 전무 → null
  assert.equal(extractLastActivityLine('⠋\n⠙\n\n─ ─ ─\n[hc] idle'), null);
  assert.equal(extractLastActivityLine(''), null);
  assert.equal(extractLastActivityLine(null), null);
  assert.equal(extractLastActivityLine('┌────────┐\n└────────┘'), null);
});

test('4. mergeLiveRosterLabels — 라이브 오버라이드·watchedLead 보존·대기 복귀', () => {
  const base = makeBaseLabels();
  const baseSnapshot = JSON.stringify(base);

  // (a) 라이브 verifier가 대기 배지를 덮고, 모델 플래그는 실측 원문으로
  const merged = mergeLiveRosterLabels(base, null, [
    makeWorker({
      slot: 'verifier',
      shortModel: 'pi:glm-5.3',
      badge: 'pi:glm-5.3 (실행 중)',
      modelName: 'glm-zcode/glm-5.3',
      name: 'verify-abc',
      address: 'tV',
    }),
  ]);
  assert.equal(merged.labels.verifier, 'pi:glm-5.3');
  assert.equal(merged.verifierModelName, 'pi:glm-5.3');
  assert.equal(merged.verifierModelFlag, '--model glm-zcode/glm-5.3');
  assert.equal(merged.labels.coder, 'devin'); // 무관 슬롯은 대기 유지
  assert.equal(merged.labels.lead, 'pi:glm-5.3');
  assert.equal(merged.activeWorkerCount, 1);

  // base 원본 미변형 (오염 방지)
  assert.equal(JSON.stringify(base), baseSnapshot);

  // (b) watchedLead 우선 — 라이브 lead 워커가 있어도 관측 중 배지 보존
  const mergedWatched = mergeLiveRosterLabels(base, 'Antigravity (현재 세션)', [
    makeWorker({ slot: 'lead', name: 'lead-abc', address: 'tL' }),
  ]);
  assert.equal(mergedWatched.labels.lead, 'Antigravity (현재 세션)');

  // (c) 워커 종료(빈 배열) → 대기 라벨로 자동 복귀
  const reverted = mergeLiveRosterLabels(base, null, []);
  assert.deepEqual(reverted.labels, base);
  assert.equal(reverted.verifierModelFlag, 'pi:deepseek-v4.1-flash'); // 배지 폴백
  assert.equal(reverted.leadModelFlag, 'pi:glm-5.3');
  assert.equal(reverted.activeWorkerCount, 0);

  // (d) 라이브 lead(모델 실측) — watchedLead 부재 시에만 모델명·플래그 반영
  const mergedLead = mergeLiveRosterLabels(base, null, [
    makeWorker({ slot: 'lead', name: 'lead-abc', address: 'tL2' }),
  ]);
  assert.equal(mergedLead.labels.lead, 'pi:glm-5.3');
  assert.equal(mergedLead.leadModelName, 'pi:glm-5.3');
  assert.equal(mergedLead.leadModelFlag, '--model glm-zcode/glm-5.3');

  // (e) 동일 슬롯 다중 워커 — 첫 워커 우선(표기 안정)
  const multi = mergeLiveRosterLabels(base, null, [
    makeWorker({ slot: 'coder', shortModel: 'devin', modelName: 'devin', address: 'c1' }),
    makeWorker({ slot: 'coder', address: 'c2' }),
  ]);
  assert.equal(multi.labels.coder, 'devin');
  assert.equal(multi.activeWorkerCount, 2);
});

test('5. createLiveRosterSyncer — roster.json 핫리로드 + hc 오류 fail-safe', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-hot-')));
  const env = isolateRosterEnv(tmp);
  const rosterPath = path.join(tmp, 'roster.json');
  process.env.HERDR_ROSTER_PATH = rosterPath;
  writeTempRoster(rosterPath, 't-profile-a', 'claude', 'claude-sonnet-4-6');
  const updates: MergedLiveRoster[] = [];
  const syncer = createLiveRosterSyncer({
    repoDir: tmp,
    repoFilterDir: null,
    getWatchedLead: () => null,
    onUpdate: (m) => updates.push(m),
    intervalMs: 25,
    execRunner: async (_file, args) => {
      // hc 미설치/오류 상황 — ls부터 실패
      throw Object.assign(new Error(`spawn ${args[0]} ENOENT`), { code: 'ENOENT' });
    },
  });
  try {
    await waitFor(() => updates.length >= 1);
    // fail-safe: 예외 전파 없이 대기 라벨 방송, 워커 0
    assert.equal(updates[0]!.labels.profileName, 't-profile-a');
    assert.equal(updates[0]!.labels.lead, 'claude:sonnet-4-6');
    assert.equal(updates[0]!.workers.length, 0);

    // roster.json 중간 교체 — mtime/size 서명 변화 감지 → 핫리로드
    const before = updates.length;
    writeTempRoster(rosterPath, 't-profile-b', 'pi', 'glm-zcode/glm-5.3');
    await waitFor(
      () => updates.length > before && updates[updates.length - 1]!.labels.profileName === 't-profile-b'
    );
    assert.equal(updates[updates.length - 1]!.labels.lead, 'pi:glm-5.3');
  } finally {
    syncer.stop();
    env.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('6. createLiveRosterSyncer — live 워커 수집·스코프 필터·활동 캡처·캐시·stop', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-live-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-out-')));
  const env = isolateRosterEnv(tmp);
  const rosterPath = path.join(tmp, 'roster.json');
  process.env.HERDR_ROSTER_PATH = rosterPath;
  writeTempRoster(rosterPath, 't-live-prof', 'claude', 'claude-sonnet-4-6');

  const repoDir = path.join(tmp, 'my-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const lsJson = JSON.stringify({
    terminals: [
      { address: 'tA', agent: 'pi', name: 'w-pi-x', parent: 't0', state: 'live', status: 'working', cwd: repoDir },
      { address: 'tB', agent: 'devin', name: 'coder1-x', parent: 't0', state: 'live', cwd: outside }, // 스코프 밖
      { address: 'tC', agent: 'zsh', state: 'live', cwd: repoDir }, // 셸 제외
      { address: 'tD', agent: 'node', name: 'dg-monitor', parent: 't0', state: 'live', cwd: repoDir }, // 모니터 제외
    ],
  });
  const getA = JSON.stringify({
    address: 'tA',
    agent: 'pi',
    name: 'w-pi-x',
    state: 'live',
    cwd: repoDir,
    status: { app: 'pi', state: 'working' }, // hc get은 객체형 status
    argv: ['/b/pi', '--model', 'glm-zcode/glm-5.3', '프롬프트'],
  });
  const readA = '[hc] tA · live\n⠹\n테스트 3/3 통과';

  let getCalls = 0;
  const updates: MergedLiveRoster[] = [];
  const syncer = createLiveRosterSyncer({
    repoDir: tmp,
    repoFilterDir: tmp, // 스코프 = tmp (my-repo 포함, outside 제외)
    getWatchedLead: () => null,
    onUpdate: (m) => updates.push(m),
    intervalMs: 25,
    execRunner: async (_file, args) => {
      if (args[0] === 'ls') return lsJson;
      if (args[0] === 'get') {
        getCalls++;
        return getA;
      }
      if (args[0] === 'read' && args[1] === 'tA') return readA;
      return '{}';
    },
  });
  try {
    await waitFor(() => updates.some((m) => m.workers.length === 1));
    const merged = updates.find((m) => m.workers.length === 1)!;
    const w = merged.workers[0]!;
    assert.equal(w.address, 'tA'); // 스코프·셸·모니터 필터 후 1개만
    assert.equal(w.shortModel, 'pi:glm-5.3');
    assert.equal(w.repoTag, 'my-repo');
    assert.equal(w.status, 'working'); // 객체형 status 정규화
    assert.equal(w.activity, '테스트 3/3 통과'); // [hc]·스피너 스킵 후 활동
    // 라이브 coder 오버라이드 — 대기 'devin' → 'pi:glm-5.3', lead는 대기 유지
    assert.equal(merged.labels.coder, 'pi:glm-5.3');
    assert.equal(merged.labels.lead, 'claude:sonnet-4-6');
    assert.equal(merged.activeWorkerCount, 1);

    // `hc get` 상세 캐시 — 주소별 1회만 조회
    const ticks = updates.filter((m) => m.workers.length === 1).length;
    await waitFor(() => updates.filter((m) => m.workers.length === 1).length > ticks + 1);
    assert.equal(getCalls, 1);

    // stop() 후 방송 중단
    const countAtStop = updates.length;
    syncer.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(updates.length, countAtStop);
  } finally {
    syncer.stop();
    env.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('7. renderApp 헤더·워커 카드 — repo=<이름> / 전체 표기 + 라이브 카드 노출', () => {
  // --repo 지정 watch — repo=<이름>
  const scoped = createInitialState('watch');
  scoped.repoScopeLabel = 'my-repo';
  const scopedText = renderFrame(scoped, 148, 43).toPlainString();
  assert.ok(scopedText.includes('repo=my-repo'), 'repo scope tag in header');

  // 전역 watch — '전체' 표기로 스코프 모호성 제거
  const globalWatch = createInitialState('watch');
  const globalText = renderFrame(globalWatch, 148, 43).toPlainString();
  assert.ok(globalText.includes(' · 전체'), 'global watch scope marker');
  assert.ok(!globalText.includes('repo='), 'no repo tag without --repo');

  // 비watch(demo) — 스코프 미지정 시 표기 없음
  const demo = createInitialState('demo');
  const demoText = renderFrame(demo, 148, 43).toPlainString();
  assert.ok(!demoText.includes('repo='), 'no repo tag in demo');
  assert.ok(!demoText.includes(' · 전체'), 'no global marker in demo');

  // 라이브 워커 카드 — [repoTag] + 모델 + 1줄 활동 표시
  const withCards = createInitialState('watch');
  withCards.cards = [
    {
      name: '[my-repo] w-pi-x · pi:glm-5.3',
      model: 'pi:glm-5.3',
      progress: 0,
      description: '테스트 3/3 통과',
      status: 'running',
    },
  ];
  const cardsText = renderFrame(withCards, 148, 43).toPlainString();
  assert.ok(cardsText.includes('[my-repo] w-pi-x'), 'worker card repo tag + name');
  assert.ok(cardsText.includes('테스트 3/3 통과'), 'worker card 1-line activity');
});

test('8. 유출 스캔 — 변경 파일에 홈 절대경로·키 패턴 0건', () => {
  // src 변경 파일 — 홈 절대경로·키 패턴 전부 검사
  const srcChanged = [
    'src/backend/liveWorkerSync.ts',
    'src/types.ts',
    'src/cli.ts',
    'src/ui/renderApp.ts',
    'src/ui/renderModal.ts',
  ];
  // 이 테스트 파일 자체 — 리덕션 검증용 가짜 키 fixture가 있으므로 경로 패턴만 검사
  const testChanged = ['tests/live-worker-sync.test.ts'];
  const leakPatterns: RegExp[] = [
    /\/Users\//,
    /sk-[A-Za-z0-9_-]{16,}/,
    /AIza[0-9A-Za-z_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
  ];
  const pathOnly = [/\/Users\//];
  for (const rel of [...srcChanged, ...testChanged]) {
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const patterns = testChanged.includes(rel) ? pathOnly : leakPatterns;
    for (const re of patterns) {
      assert.ok(!re.test(content), `${rel} leaks ${re.source}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 회귀 방지 (verify-tui-live.md 블로킹 3건 + 경계 케이스)

/** 트랜스크립트 매퍼의 SQLite SSOT 쓰기 격리 — 임시 DB로 돌린다(복구 필수). */
function makeDbEnv(): { restore: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lws-db-'));
  const prevDb = process.env.GEMINI_TRICK_DB_PATH;
  const prevDgateDb = process.env.DGATE_DB_PATH;
  const prevDoDb = process.env.DECISION_ORCHESTRATOR_DB_PATH;
  process.env.GEMINI_TRICK_DB_PATH = path.join(base, 'decision.db');
  delete process.env.DGATE_DB_PATH;
  delete process.env.DECISION_ORCHESTRATOR_DB_PATH;
  return {
    restore: () => {
      if (prevDb === undefined) delete process.env.GEMINI_TRICK_DB_PATH;
      else process.env.GEMINI_TRICK_DB_PATH = prevDb;
      if (prevDgateDb === undefined) delete process.env.DGATE_DB_PATH;
      else process.env.DGATE_DB_PATH = prevDgateDb;
      if (prevDoDb === undefined) delete process.env.DECISION_ORCHESTRATOR_DB_PATH;
      else process.env.DECISION_ORCHESTRATOR_DB_PATH = prevDoDb;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function plannerGrepStep(idx: number): TranscriptStep {
  const calls: TranscriptToolCall[] = [{ name: 'grep_search', args: { query: 'TODO' } }];
  return {
    step_index: idx,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-19T09:00:01Z',
    model: 'gemini-4-argon-high',
    tool_calls: calls,
  };
}

test('9. 라이브 동기화(0·1 워커) 후 applyTranscriptStep — 무동작 + cards 3슬롯 불변', async () => {
  const dbEnv = makeDbEnv();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-tx-')));
  const env = isolateRosterEnv(tmp);
  const rosterPath = path.join(tmp, 'roster.json');
  process.env.HERDR_ROSTER_PATH = rosterPath;
  writeTempRoster(rosterPath, 't-tx-prof', 'claude', 'claude-sonnet-4-6');
  const repoDir = path.join(tmp, 'my-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  let lsPayload = JSON.stringify({ terminals: [] }); // 페이즈 1: 워커 0
  const updates: MergedLiveRoster[] = [];
  const syncer = createLiveRosterSyncer({
    repoDir: tmp,
    repoFilterDir: null,
    getWatchedLead: () => null,
    onUpdate: (m) => updates.push(m),
    intervalMs: 25,
    execRunner: async (_file, args) => {
      if (args[0] === 'ls') return lsPayload;
      if (args[0] === 'get') {
        return JSON.stringify({
          address: 'tA',
          agent: 'pi',
          name: 'w-pi-x',
          state: 'live',
          cwd: repoDir,
          status: 'working',
          argv: ['/b/pi', '--model', 'glm-zcode/glm-5.3'],
        });
      }
      return '[hc] tA\n그렙 실행 중';
    },
  });
  try {
    const state = createInitialState('watch');
    const cardsSnapshot = state.cards.map((c) => ({ ...c }));

    // 페이즈 1 — 워커 0건 동기화 후 트랜스크립트 도구 호출
    await waitFor(() => updates.some((m) => m.workers.length === 0));
    const merged0 = updates.at(-1)!;
    state.liveWorkers = merged0.workers.map((w) => ({
      name: `[${w.repoTag}] ${w.name} · ${w.shortModel}`,
      model: w.shortModel,
      progress: 0,
      description: w.activity,
      status: 'running' as const,
    }));
    assert.equal(state.liveWorkers.length, 0);
    assert.doesNotThrow(() => applyTranscriptStep(state, plannerGrepStep(1)));
    assert.equal(state.cards.length, 3, 'cards 3슬롯 불변 — 라이브 목록으로 덮지 않는다');
    assert.equal(state.cards[1]!.status, 'running'); // grep_search → grep 카드 갱신

    // 페이즈 2 — 워커 1건 동기화 후에도 동일 (구 버그: cards가 1장으로 줄며 throw)
    lsPayload = JSON.stringify({
      terminals: [
        { address: 'tA', agent: 'pi', name: 'w-pi-x', parent: 't0', state: 'live', status: 'working', cwd: repoDir },
      ],
    });
    await waitFor(() => updates.some((m) => m.workers.length === 1));
    const merged1 = updates.at(-1)!;
    state.liveWorkers = merged1.workers.map((w) => ({
      name: `[${w.repoTag}] ${w.name} · ${w.shortModel}`,
      model: w.shortModel,
      progress: 0,
      description: w.activity,
      status: 'running' as const,
    }));
    assert.equal(state.liveWorkers.length, 1);
    assert.equal(state.cards.length, 3);
    assert.doesNotThrow(() => applyTranscriptStep(state, plannerGrepStep(2)));
    assert.equal(state.cards.length, 3);
    assert.ok(state.cards[1]!.description.includes('grep_search'));

    // cards 원본 슬롯 이름은 라이브 동기화로 오염되지 않는다
    assert.deepEqual(
      state.cards.map((c) => c.name),
      cardsSnapshot.map((c) => c.name)
    );

    // 렌더 스모크 — 라이브 카드 1장 상태로 프레임 그리기 무동작 + 카드 노출
    const text = renderFrame(state, 120, 43).toPlainString();
    assert.ok(text.includes('w-pi-x'), '라이브 워커 카드 렌더');
  } finally {
    syncer.stop();
    env.restore();
    dbEnv.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('10. working→done 전환 — hc get 캐시 정적 유지 + 매 틱 ls 상태 병합', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-done-')));
  const env = isolateRosterEnv(tmp);
  const rosterPath = path.join(tmp, 'roster.json');
  process.env.HERDR_ROSTER_PATH = rosterPath;
  writeTempRoster(rosterPath, 't-done-prof', 'claude', 'claude-sonnet-4-6');
  const repoDir = path.join(tmp, 'my-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  let lsStatus = 'working'; // hc ls 틱마다 바뀌는 실측 상태
  let getCalls = 0;
  const updates: MergedLiveRoster[] = [];
  const syncer = createLiveRosterSyncer({
    repoDir: tmp,
    repoFilterDir: null,
    getWatchedLead: () => null,
    onUpdate: (m) => updates.push(m),
    intervalMs: 25,
    execRunner: async (_file, args) => {
      if (args[0] === 'ls') {
        return JSON.stringify({
          terminals: [
            { address: 'tA', agent: 'pi', name: 'w-pi-x', parent: 't0', state: 'live', status: lsStatus, cwd: repoDir },
          ],
        });
      }
      if (args[0] === 'get') {
        getCalls++;
        return JSON.stringify({
          address: 'tA',
          agent: 'pi',
          name: 'w-pi-x',
          state: 'live',
          cwd: repoDir,
          status: 'working', // hc get은 계속 working — 상태 갱신은 ls 병합으로만
          argv: ['/b/pi', '--model', 'glm-zcode/glm-5.3'],
        });
      }
      return '[hc] tA\n작업 중';
    },
  });
  try {
    await waitFor(() => updates.some((m) => m.workers[0]?.status === 'working'));
    assert.equal(getCalls, 1, '상세는 주소별 1회만 조회(캐시)');

    // ls 상태가 working→done으로 바뀌면 다음 틱에 즉시 반영되어야 한다
    lsStatus = 'done';
    await waitFor(() => updates.some((m) => m.workers[0]?.status === 'done'));
    const doneMerged = [...updates].reverse().find((m) => m.workers[0]?.status === 'done')!;
    assert.equal(doneMerged.workers[0]!.repoTag, 'my-repo');
    assert.equal(getCalls, 1, '전환 후에도 hc get 재조회 없음 — 상태는 ls에서 병합');
    assert.equal(doneMerged.workers[0]!.shortModel, 'pi:glm-5.3', '캐시된 argv 정적 정보 유지');
  } finally {
    syncer.stop();
    env.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('11. malformed hc ls JSON — 이전 워커 보존(빈 방송·허위 종료 금지)', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-badjson-')));
  const env = isolateRosterEnv(tmp);
  const rosterPath = path.join(tmp, 'roster.json');
  process.env.HERDR_ROSTER_PATH = rosterPath;
  writeTempRoster(rosterPath, 't-bad-prof', 'claude', 'claude-sonnet-4-6');
  const repoDir = path.join(tmp, 'my-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const goodLs = JSON.stringify({
    terminals: [
      { address: 'tA', agent: 'pi', name: 'w-pi-x', parent: 't0', state: 'live', status: 'working', cwd: repoDir },
    ],
  });
  const badLs = '{"terminals": [ {"address": "tA", "agent"'; // 잘린 JSON
  let lsPayload = goodLs;
  const updates: MergedLiveRoster[] = [];
  const syncer = createLiveRosterSyncer({
    repoDir: tmp,
    repoFilterDir: null,
    getWatchedLead: () => null,
    onUpdate: (m) => updates.push(m),
    intervalMs: 25,
    execRunner: async (_file, args) => {
      if (args[0] === 'ls') return lsPayload;
      if (args[0] === 'get') {
        return JSON.stringify({
          address: 'tA',
          agent: 'pi',
          name: 'w-pi-x',
          state: 'live',
          cwd: repoDir,
          argv: ['/b/pi', '--model', 'glm-zcode/glm-5.3'],
        });
      }
      return '[hc] tA';
    },
  });
  try {
    await waitFor(() => updates.some((m) => m.workers.length === 1));
    const countWithWorker = updates.filter((m) => m.workers.length === 1).length;

    // 이후 틱 2회 이상을 malformed JSON으로 — 이전 워커가 그대로 보존되어야 한다
    lsPayload = badLs;
    await waitFor(() => updates.length > countWithWorker + 1);
    const after = updates.slice(countWithWorker);
    assert.ok(after.length >= 1, 'malformed 이후에도 방송은 계속된다');
    for (const m of after) {
      assert.equal(m.workers.length, 1, 'malformed ls로 워커 0건 방송 금지');
      assert.equal(m.workers[0]!.address, 'tA');
    }
  } finally {
    syncer.stop();
    env.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 회귀: '{}', '{"terminals":null}'은 스키마 무효 — 이전 워커 보존.
// 명시적 '{"terminals":[]}'만 rosters 클리어.
test("11.5 ls JSON 스키마 — '{}'·'{}' 아닌 terminals 무효 vs 명시적 빈 목록", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lws-schema-')));
  const env = isolateRosterEnv(tmp);
  const rosterPath = path.join(tmp, 'roster.json');
  process.env.HERDR_ROSTER_PATH = rosterPath;
  writeTempRoster(rosterPath, 't-schema', 'claude', 'claude-sonnet-4-6');
  const repoDir = path.join(tmp, 'my-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const goodLs = JSON.stringify({
    terminals: [
      { address: 'tA', agent: 'pi', name: 'w-pi-x', parent: 't0', state: 'live', status: 'working', cwd: repoDir },
    ],
  });
  let lsPayload = goodLs;
  const updates: MergedLiveRoster[] = [];
  const syncer = createLiveRosterSyncer({
    repoDir: tmp,
    repoFilterDir: null,
    getWatchedLead: () => null,
    onUpdate: (m) => updates.push(m),
    intervalMs: 25,
    execRunner: async (_file, args) => {
      if (args[0] === 'ls') return lsPayload;
      if (args[0] === 'get') {
        return JSON.stringify({
          address: 'tA',
          agent: 'pi',
          name: 'w-pi-x',
          state: 'live',
          cwd: repoDir,
          argv: ['/b/pi', '--model', 'glm-zcode/glm-5.3'],
        });
      }
      return '[hc] tA';
    },
  });
  try {
    await waitFor(() => updates.some((m) => m.workers.length === 1));

    // 1) '{}' — terminals 누락 → 무효 스키마, 이전 워커 보존
    lsPayload = '{}';
    await waitFor(() => updates.length > 1, 1000).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(updates.length >= 1);
    assert.ok(
      updates.every((m) => m.workers.length === 1),
      "'{}' 응답으로 워커 0건 방송 금지"
    );

    // 2) '{"terminals":null}' — terminals 비배열 → 무효 스키마, 이전 워커 보존
    lsPayload = '{"terminals":null}';
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(
      updates.every((m) => m.workers.length === 1),
      "'{\"terminals\":null}' 응답으로 워커 0건 방송 금지"
    );

    // 3) 명시적 '{"terminals":[]}' — 유효한 빈 목록, rosters 클리어
    lsPayload = '{"terminals":[]}';
    await waitFor(() => updates.some((m) => m.workers.length === 0));
    assert.ok(
      updates.slice(-3).some((m) => m.workers.length === 0),
      "명시적 '{\"terminals\":[]}' 는 워커 클리어"
    );
  } finally {
    syncer.stop();
    env.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('12. 헤더 80/100/120/148열 — repo 라벨·우측 카운터 충돌 없음', () => {
  for (const cols of [80, 100, 120, 148]) {
    const state = createInitialState('watch');
    state.repoScopeLabel = 'repo-smoke';
    const header = renderFrame(state, cols, 43)
      .toPlainString()
      .split('\n')
      .find((l) => l.includes('DGATE TUI'))!;
    assert.ok(header.includes('repo=repo-smoke'), `${cols}열: repo 라벨 온전`);
    assert.ok(
      !/repo=(LEAD|WORK|VERIF|ADV)/.test(header),
      `${cols}열: repo 라벨이 카운터를 덮지 않는다`
    );
    // 카운터가 그려지는 폭에서는 배지도 온전해야 한다
    if (header.includes('LEAD BUILDS')) {
      assert.ok(/LEAD BUILDS \[\d+\]/.test(header), `${cols}열: LEAD BUILDS 카운터 온전`);
      const repoIdx = header.indexOf('repo=repo-smoke');
      const leadIdx = header.indexOf('LEAD BUILDS');
      assert.ok(repoIdx >= 0 && leadIdx > repoIdx, `${cols}열: 라벨→카운터 순서(간격 유지)`);
    }
    // 120열 — 구 버그 재현 지점: 'repo=LEAD BUILDS [0]' 로 덮였던 자리
    if (cols === 120) {
      assert.ok(header.includes('LEAD BUILDS'), '120열: 카운터 노출');
      assert.ok(!header.includes('repo=LEAD BUILDS'), '120열 충돌 재현 없음');
    }
  }
});

test('13. 경계 — 박스형 [hc] 푸터·겹선 테두리·루트 스코프·ksh/dash/pwsh 제외', () => {
  // 박스로 감싼 [hc] 상태줄도 활동 줄이 아니라 스킵 — 가장자리 장식 제거 후 판정
  assert.equal(extractLastActivityLine('│ [hc] idle │'), null);
  assert.equal(extractLastActivityLine('║ [hc] t18s · live ║'), null);
  assert.equal(
    extractLastActivityLine('[hc] t18s\n╔════════╗\n║ 패치 적용 중 ║\n╚════════╝'),
    '패치 적용 중'
  );
  // 겹선(double-line) 테두리 전용 줄 — 본문 없음으로 스킵
  assert.equal(extractLastActivityLine('╚════════╝'), null);
  assert.equal(extractLastActivityLine('╠════╣'), null);
  assert.equal(extractLastActivityLine('╔════════╗\n╚════════╝'), null);

  // 루트('/') 스코프 — 모든 절대경로 하위를 포함해야 한다('//' 사고 방지)
  assert.equal(matchesRepoScope('/definitely/any/path', '/'), true);
  assert.equal(matchesRepoScope('/', '/'), true);
  assert.equal(matchesRepoScope(null, '/'), false); // cwd 미상 + 스코프 지정

  // 셸 확장 제외 — w- 접두가 있어도 ksh/dash/pwsh는 워커가 아니다
  for (const sh of ['ksh', 'dash', 'pwsh']) {
    assert.equal(
      isWorkerTerminal({ address: 'a', agent: sh, name: `w-${sh}`, state: 'live', parent: 't0' }),
      false,
      `${sh} 셸 제외`
    );
  }
});
