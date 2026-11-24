/**
 * Sublead Phase 4~5 — 동시성 예산 캡(항목 6) + `dg suggest-sublead` 제안 엔진 검증.
 *
 * 실행: `node --test tests/sublead-phase4-5.test.ts`
 * 범위:
 * - `clampMaxSubleads` / `evaluateConcurrencyBudget`: sublead coder 슬롯 비소모·상한 2~4·전체 트리 active_coding 캡
 * - `countTreeActiveCodingForks`: 임시 DB open/rework file_edit 카운트
 * - `groupDisjointScopes` / `evaluateSubleadSuggestion`: 3축 점수·단일 영역 비권장·다영역 고부하 추천
 * - `collectSubleadSignalsFromDb` + `dg.ts suggest-sublead --json`: 임시 DB E2E
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  clampMaxSubleads,
  countTreeActiveCodingForks,
  evaluateConcurrencyBudget,
} from '../scripts/dispatch.ts';
import { openDbSafe } from '../src/decision/db.ts';
import { issueFork } from '../src/decision/engine.ts';
import {
  collectSubleadSignalsFromDb,
  evaluateSubleadSuggestion,
  groupDisjointScopes,
} from '../src/decision/suggestSublead.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DG_TS = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');

test('Phase 4 동시성 예산 캡 — sublead coder 비소모·상한 2~4 클램프·전체 트리 active_coding 집행', () => {
  assert.equal(clampMaxSubleads(undefined), 2);
  assert.equal(clampMaxSubleads(1), 2);
  assert.equal(clampMaxSubleads(3), 3);
  assert.equal(clampMaxSubleads(9), 4);

  // (a) sublead는 activeCoding이 이미 2여도 coder 슬롯을 소모하지 않으므로 통과
  const subOk = evaluateConcurrencyBudget({
    isSubleadRequest: true,
    requiresWrite: true,
    decision: 'split',
    activeExplore: 0,
    activeCoding: 2,
    treeActiveCoding: 2,
    activeSubleads: 1,
  });
  assert.equal(subOk.deferred, false);
  assert.equal(subOk.maxSubleads, 2);

  // (b) sublead 동시 상한 도달 시 deferred
  const subCap = evaluateConcurrencyBudget({
    isSubleadRequest: true,
    requiresWrite: true,
    decision: 'split',
    activeExplore: 0,
    activeCoding: 0,
    treeActiveCoding: 0,
    activeSubleads: 2,
  });
  assert.equal(subCap.deferred, true);
  assert.match(subCap.reason ?? '', /sublead concurrency cap \(2\)/);

  // (c) 일반 write 워커는 activeCoding=0이어도 전체 트리 합산 treeActiveCoding>=2면 deferred
  const treeCap = evaluateConcurrencyBudget({
    isSubleadRequest: false,
    requiresWrite: true,
    decision: 'split',
    activeExplore: 0,
    activeCoding: 0,
    treeActiveCoding: 2,
    activeSubleads: 1,
  });
  assert.equal(treeCap.deferred, true);
  assert.match(treeCap.reason ?? '', /coding concurrency cap \(2\)/);
});

test('Phase 5 suggest-sublead — 비겹침 영역 그룹핑·3축 점수·DB 집계·CLI E2E', () => {
  // (a) 중첩 경로 병합, 형제 경로 분리
  assert.deepEqual(
    groupDisjointScopes(['crates/dgate-core', 'crates/dgate-core/src', 'src/ui', 'docs/']),
    ['docs', 'src/ui', 'crates/dgate-core']
  );

  // (b) 단일 영역이면 부하 높아도 분리 비권장
  const single = evaluateSubleadSuggestion({
    activeForks: 5,
    reworkOrBackpropCount: 3,
    avgVerdictLatencyMs: 400_000,
    activeWrapWorkers: 4,
    activeScopes: ['src/auth', 'src/auth/oauth'],
    multiEditOrSwarmCount: 4,
    maxGenerationOrAttempt: 3,
    largeBlastCount: 2,
  });
  assert.equal(single.recommended, false);
  assert.equal(single.suggestedSubleads, 0);

  // (c) 임시 DB에서 countTreeActiveCodingForks + collectSubleadSignalsFromDb + CLI --json 확인
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `dg-p45-${process.pid}-`));
  const dbPath = path.join(tmpDir, 'decision.db');
  const db = openDbSafe(dbPath, { busyTimeoutMs: 5000 });
  assert.ok(db);
  try {
    const scopes = ['crates/core', 'crates/gui', 'src/ui'];
    for (let i = 0; i < scopes.length; i++) {
      issueFork(db, {
        projectId: 'proj-p45',
        projectLabel: 'p45',
        route: 'delegate_swarm',
        toolClass: 'file_edit',
        decision: 'split',
        pAtGate: 0.5,
        basisAtGate: 'prior',
        forcedSplit: false,
        metadata: {
          repo_scope: scopes[i],
          door: i === 0 ? 'one-way' : 'two-way',
          blast_radius: 'x'.repeat(90),
        },
      });
    }
    assert.equal(countTreeActiveCodingForks(db), 3);

    const signals = collectSubleadSignalsFromDb(db, {
      projectId: 'proj-p45',
      activeWorkersOverride: 3,
      maxSubleadsCap: 3,
    });
    const res = evaluateSubleadSuggestion(signals);
    assert.equal(res.recommended, true);
    assert.equal(res.suggestedSubleads, 3);
    assert.equal(res.disjointGroups.length, 3);
  } finally {
    db.close();
  }

  const cli = spawnSync(
    process.execPath,
    [DG_TS, 'suggest-sublead', '--db', dbPath, '--active-workers', '3', '--max-subleads', '3', '--json'],
    { encoding: 'utf8' }
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout) as { recommended: boolean; suggestedSubleads: number };
  assert.equal(parsed.recommended, true);
  assert.equal(parsed.suggestedSubleads, 3);
});
