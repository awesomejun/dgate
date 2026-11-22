/**
 * PR-A2 생명주기 펜싱 + `dg wrap` 실행 계약 테스트 (brief-pra2 §3, §6 테스트 매트릭스).
 *
 * 목적:
 * ① 산출물 계약(`--require-artifact`) 미충족 → `artifact_missing` + fork fail
 * ② stdout `rerouted` 마커 → 비표본 rerouted 전이 + stats_summary 0건
 * ③ 동시 `settleOrphans` 경합 → 정확히 1건의 `ttl_orphan`(weight 1.0)
 * ④ 고아 정산 후 지연 도착한 wrap 커밋 → `committed:false` + 이중 표본 0건
 * ⑤ 무출력 자식 `--stall-ms` 워치독 → 프로세스 그룹 킬 + `stall` 분류 + 하트비트 정지
 * ⑥ `config_error`(exit 127) → decision_events 감사만, EWMA/카운터 미오염
 * ⑦ gen/attempt 비대칭 펜스 → stale_generation/stale_attempt 거부, ok는 attempt 무시
 * ⑧ 이중 역귀속 차단 — 동일 fork 재 backprop 거부
 *
 * 실행: `node --test tests/fencing-lifecycle.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openDb, GLOBAL_PROJECT_ID } from '../src/decision/db.ts';
import * as engine from '../src/decision/engine.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');

interface TestEnv {
  base: string;
  dbPath: string;
  projDir: string;
  env: NodeJS.ProcessEnv;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `pra2-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const projDir = path.join(base, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  return { base, dbPath, projDir, env: { ...process.env, GEMINI_TRICK_DB_PATH: dbPath, DGATE_DB_PATH: undefined, DECISION_ORCHESTRATOR_DB_PATH: undefined } };
}

function cleanupEnv(e: TestEnv): void {
  fs.rmSync(e.base, { recursive: true, force: true });
}

function dg(e: TestEnv, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DG_PATH, ...args], { env: e.env, encoding: 'utf8' });
}

function dgAsync(
  e: TestEnv,
  args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [DG_PATH, ...args], { env: e.env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ status: code, stdout, stderr }));
    p.on('error', (err) => resolve({ status: null, stdout, stderr: String(err) }));
  });
}

function dgOk(e: TestEnv, args: string[]): Record<string, unknown> {
  const res = dg(e, [...args, '--json']);
  assert.equal(res.status, 0, `dg ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function dgStat(e: TestEnv, sql: string, ...params: (string | number | null)[]): unknown {
  const db = openDb(e.dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function dgStatAll(e: TestEnv, sql: string, ...params: (string | number | null)[]): unknown[] {
  const db = openDb(e.dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** wrap stderr 마지막 줄의 JSON 요약 파싱 */
function wrapSummary(res: SpawnSyncReturns<string>): Record<string, unknown> {
  const lines = res.stderr.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

/** open fork 발행 — route 게이트 경유(실제 경로 검증) */
function issueOpenFork(e: TestEnv): string {
  const out = dgOk(e, ['route', '--task-kind', 'explore_read', '--project', e.projDir]);
  return out.fork_id as string;
}

// ---------------------------------------------------------------------------

test('① artifact 계약: --require-artifact 미존재 → artifact_missing + fork fail', () => {
  const e = makeEnv();
  try {
    const forkId = issueOpenFork(e);
    const missing = path.join(e.base, 'missing.md');
    const res = dg(e, [
      'wrap', '--route', 'file_select', '--tool-class', 'file_read',
      '--fork', forkId, '--require-artifact', missing,
      '--project', e.projDir, '--', 'node', '-e', 'process.exit(0)',
    ]);
    const summary = wrapSummary(res);
    assert.equal(summary.ok, 0);
    assert.equal(summary.cause, 'artifact_missing');
    assert.equal(summary.outcome, 'fail');
    assert.equal(summary.committed, true);
    const fork = dgStat(e, `SELECT status, metadata_json FROM forks WHERE fork_id = ?`, forkId) as {
      status: string;
      metadata_json: string;
    };
    assert.equal(fork.status, 'fail');
    assert.equal(JSON.parse(fork.metadata_json).cause, 'artifact_missing');
  } finally {
    cleanupEnv(e);
  }
});

test('② stdout rerouted 마커: --require-stdout-nonempty + rerouted 선두 → 비표본 rerouted', () => {
  const e = makeEnv();
  try {
    const forkId = issueOpenFork(e);
    const res = dg(e, [
      'wrap', '--route', 'file_select', '--tool-class', 'file_read',
      '--fork', forkId, '--require-stdout-nonempty',
      '--project', e.projDir, '--', 'node', '-e', "console.log('rerouted\\nwrite needed')",
    ]);
    assert.equal(res.status, 0, `wrap exit: ${res.status}`);
    const summary = wrapSummary(res);
    assert.equal(summary.outcome, 'rerouted');
    assert.equal(summary.recorded, false);
    const fork = dgStat(e, `SELECT status FROM forks WHERE fork_id = ?`, forkId) as { status: string };
    assert.equal(fork.status, 'rerouted');
    // rerouted는 통계 미반영 — stats_summary 표본 0건(§3.3)
    const stat = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id != ? AND route = 'file_select' AND tool_class = 'file_read'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number } | undefined;
    assert.equal(stat?.raw_samples ?? 0, 0, 'rerouted가 stats_summary를 오염시킴');
  } finally {
    cleanupEnv(e);
  }
});

test('③ 동시 settleOrphans 경합: 정확히 1건의 ttl_orphan, weight 1.0 유지', async () => {
  const e = makeEnv();
  try {
    // stale open fork 1개 직접 발행 (과거 시각으로)
    const db = openDb(e.dbPath);
    try {
      engine.issueFork(db, {
        projectId: 'p_conc',
        projectLabel: 'p_conc',
        route: 'tool_select',
        toolClass: 'shell_exec',
        decision: 'sharp',
        pAtGate: 0.8,
        basisAtGate: 'prior',
        forcedSplit: false,
        ttlMs: 500,
        nowMs: Date.now() - 60_000,
      });
    } finally {
      db.close();
    }
    // 8개 프로세스가 동시에 정산 — Zero-TOCTOU로 정확히 1개만 커밋해야 한다
    const results = await Promise.all(
      Array.from({ length: 8 }, () => dgAsync(e, ['settle-orphans', '--json']))
    );
    const settledSum = results.reduce((acc, r) => {
      const lines = r.stdout.trim().split('\n');
      const parsed = JSON.parse(lines[lines.length - 1]!) as { settled: number };
      return acc + (parsed.settled ?? 0);
    }, 0);
    assert.equal(settledSum, 1, `동시 정산 총량 ${settledSum} — 1이어야 함`);
    const events = dgStatAll(
      e,
      `SELECT weight, source FROM decision_events WHERE source = 'ttl_orphan'`
    ) as { weight: number; source: string }[];
    assert.equal(events.length, 1, `ttl_orphan 이벤트 ${events.length}건 — 1이어야 함`);
    assert.equal(events[0]!.weight, 1.0, 'ttl_orphan weight 1.0 유지(§3.1-B)');
    const stat = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id = 'p_conc' AND route = 'tool_select' AND tool_class = 'shell_exec'`
    ) as { raw_samples: number };
    assert.equal(stat.raw_samples, 1, '고아 정산 표본은 정확히 1건');
  } finally {
    cleanupEnv(e);
  }
});

test('④ 고아 정산 후 지연 도착 wrap 커밋: committed:false + 이중 표본 0건', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      const t0 = Date.now() - 120_000;
      const forkId = engine.issueFork(db, {
        projectId: 'p_stale',
        projectLabel: 'p_stale',
        route: 'tool_select',
        toolClass: 'shell_exec',
        decision: 'sharp',
        pAtGate: 0.8,
        basisAtGate: 'prior',
        forcedSplit: false,
        ttlMs: 500,
        nowMs: t0,
      });
      // 고아 정산이 먼저 fork를 닫는다 (ttl_orphan 1표본)
      const settled = engine.settleOrphans(db, t0 + 60_000);
      assert.equal(settled.settled, 1);
      // 지연 도착한 wrap 커밋 — stale 거부 + 표본 미기록
      const res = engine.commitWrapOutcome(db, {
        forkId,
        projectId: 'p_stale',
        projectLabel: 'p_stale',
        route: 'tool_select',
        toolClass: 'shell_exec',
        ok: true,
        outcome: 'ok',
        cause: 'ok_pass',
        nowMs: t0 + 70_000,
      });
      assert.equal(res.committed, false);
      assert.equal(res.reason, 'stale_or_closed');
      assert.equal(res.recorded, false);
      const events = dgStatAll(
        e,
        `SELECT source FROM decision_events WHERE fork_id = ?`,
        forkId
      ) as { source: string }[];
      assert.equal(events.length, 1, 'ttl_orphan 단 1건만 — 지연 커밋의 이중 표본 0건');
      assert.equal(events[0]!.source, 'ttl_orphan');
      const stat = dgStat(
        e,
        `SELECT raw_samples FROM stats_summary WHERE project_id = 'p_stale' AND route = 'tool_select' AND tool_class = 'shell_exec'`
      ) as { raw_samples: number };
      assert.equal(stat.raw_samples, 1, '표본 중복 오염 방지');
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('⑤ 무출력 워치독: --stall-ms 250 자식 킬 + stall 분류 + 하트비트 정지', () => {
  const e = makeEnv();
  try {
    const forkId = issueOpenFork(e);
    const res = dg(e, [
      'wrap', '--route', 'file_select', '--tool-class', 'file_read',
      '--fork', forkId, '--stall-ms', '250', '--kill-grace-ms', '300',
      '--heartbeat-ms', '100',
      '--project', e.projDir, '--', 'node', '-e', 'setTimeout(()=>{}, 10000)',
    ]);
    const summary = wrapSummary(res);
    assert.equal(summary.stalled, true, '워치독이 자식을 킬하지 못함');
    assert.equal(summary.cause, 'stall');
    assert.equal(summary.outcome, 'fail');
    assert.notEqual(res.status, 0, '스톨된 자식은 비정상 종료 코드');
    const fork = dgStat(
      e,
      `SELECT status, last_touch_ms, created_at_ms, closed_at_ms, metadata_json FROM forks WHERE fork_id = ?`,
      forkId
    ) as { status: string; last_touch_ms: number; created_at_ms: number; metadata_json: string };
    assert.equal(fork.status, 'fail');
    assert.equal(JSON.parse(fork.metadata_json).cause, 'stall');
    // 생존 리스(B1): 무출력 자식도 킬 전 생존 중에는 touch된다(생존=리스).
    // 킬 이후 하트비트 정지는 “종료(closed_at_ms) 이후 touch 없음”으로 검증 —
    // 무출력 갱신 자체는 decision-engine 7c가 결정적으로 담당한다.
    assert.ok(fork.last_touch_ms >= fork.created_at_ms, 'last_touch 선행 불변 위반');
    assert.ok(fork.last_touch_ms < fork.closed_at_ms, '종료 후 touch 발생 — 킬 후 하트비트 정지 위반');
  } finally {
    cleanupEnv(e);
  }
});

test('⑥ config_error 격리: exit 127 → 감사 이벤트만, stats/카운터 미오염', () => {
  const e = makeEnv();
  try {
    const res = dg(e, [
      'wrap', '--route', 'tool_select', '--tool-class', 'shell_exec',
      '--project', e.projDir, '--', 'node', '-e', 'process.exit(127)',
    ]);
    const summary = wrapSummary(res);
    assert.equal(summary.ok, 0);
    assert.equal(summary.cause, 'config_error');
    assert.equal(summary.committed, true);
    const forkId = summary.fork_id as string;
    const fork = dgStat(
      e,
      `SELECT status, metadata_json FROM forks WHERE fork_id = ?`,
      forkId
    ) as { status: string; metadata_json: string };
    assert.equal(fork.status, 'fail');
    assert.equal(JSON.parse(fork.metadata_json).cause, 'config_error');
    // 감사 로그는 존재하되
    const events = dgStatAll(
      e,
      `SELECT source, ok FROM decision_events WHERE fork_id = ?`,
      forkId
    ) as { source: string; ok: number }[];
    assert.equal(events.length, 1, 'config_error 감사 이벤트 1건');
    assert.equal(events[0]!.source, 'wrap');
    // EWMA·전역풀·연속 오류 카운터는 모두 미오염(§3.1-B 격리)
    const stat = dgStat(
      e,
      `SELECT raw_samples, consecutive_errors FROM stats_summary WHERE project_id != ? AND route = 'tool_select' AND tool_class = 'shell_exec'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number; consecutive_errors: number } | undefined;
    assert.equal(stat?.raw_samples ?? 0, 0, 'config_error가 프로젝트 EWMA를 오염시킴');
    assert.equal(stat?.consecutive_errors ?? 0, 0, 'consecutive_errors 가산됨');
    const glob = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id = ? AND route = 'tool_select' AND tool_class = 'shell_exec'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number } | undefined;
    assert.equal(glob?.raw_samples ?? 0, 0, 'config_error가 __GLOBAL__을 오염시킴');
  } finally {
    cleanupEnv(e);
  }
});

test('⑦ 비대칭 펜스: stale gen 거부 + ok는 attempt 불일치 허용 + fail은 거부', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      const base = {
        projectId: 'p_fence',
        projectLabel: 'p_fence',
        route: 'tool_select' as engine.RouteId,
        toolClass: 'shell_exec',
        decision: 'sharp' as const,
        pAtGate: 0.8,
        basisAtGate: 'prior' as const,
        forcedSplit: false,
      };
      // gen 불일치 → outcome 무관 전면 거부
      const fkGen = engine.issueFork(db, { ...base, ttlMs: 600_000 });
      const g1 = engine.commitWrapOutcome(db, {
        forkId: fkGen, ...base, ok: false, outcome: 'fail', cause: 'tool_error', expectedGen: 2,
      });
      assert.equal(g1.committed, false);
      assert.equal(g1.reason, 'stale_generation');
      // attempt 불일치 + fail → 거부
      const fkAtt = engine.issueFork(db, { ...base, ttlMs: 600_000 });
      const a1 = engine.commitWrapOutcome(db, {
        forkId: fkAtt, ...base, ok: false, outcome: 'fail', cause: 'tool_error', expectedAttempt: 9,
      });
      assert.equal(a1.committed, false);
      assert.equal(a1.reason, 'stale_attempt');
      // attempt 불일치 + ok → 비대칭 펜스: gen만 검증하므로 커밋됨
      const fkOk = engine.issueFork(db, { ...base, ttlMs: 600_000 });
      const o1 = engine.commitWrapOutcome(db, {
        forkId: fkOk, ...base, ok: true, outcome: 'ok', cause: 'ok_pass', expectedAttempt: 9,
      });
      assert.equal(o1.committed, true, 'ok 결과는 attempt 펜스를 타지 않아야 함(비대칭)');
      assert.equal(o1.recorded, true);
      // 동일 fork 재커밋 → 이미 닫힘
      const o2 = engine.commitWrapOutcome(db, {
        forkId: fkOk, ...base, ok: false, outcome: 'fail', cause: 'tool_error',
      });
      assert.equal(o2.committed, false);
      assert.equal(o2.reason, 'stale_or_closed');
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('⑧ 이중 역귀속 차단: 동일 fork 재 backprop 거부 + 표본 1건만', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      const forkId = engine.issueFork(db, {
        projectId: 'p_bp',
        projectLabel: 'p_bp',
        route: 'tool_select',
        toolClass: 'shell_exec',
        decision: 'sharp',
        pAtGate: 0.8,
        basisAtGate: 'prior',
        forcedSplit: false,
        ttlMs: 600_000,
      });
      const first = engine.backpropFork(db, forkId, 2.0, 'verifier FAIL', { cause: 'gate_fail' });
      assert.equal(first.committed, true);
      // 이미 backprop_fail — 두 번째 호출은 거부(사전 검사 throw 또는 committed:false)
      assert.throws(() => engine.backpropFork(db, forkId, 2.0), /cannot backprop/);
      const events = dgStatAll(
        e,
        `SELECT weight FROM decision_events WHERE fork_id = ? AND source = 'neon_backprop'`,
        forkId
      ) as { weight: number }[];
      assert.equal(events.length, 1, '이중 역귀속 이벤트 차단');
      assert.equal(events[0]!.weight, 2.0, 'gate_fail weight 2.0(§3.1-B)');
      const fork = dgStat(e, `SELECT status, metadata_json FROM forks WHERE fork_id = ?`, forkId) as {
        status: string;
        metadata_json: string;
      };
      assert.equal(fork.status, 'backprop_fail');
      assert.equal(JSON.parse(fork.metadata_json).cause, 'gate_fail');
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});
