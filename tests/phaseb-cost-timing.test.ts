/**
 * PB-2A 테스트 매트릭스 (brief-pb2a §3.D): 비용 인식 동적 θ_sharp + 비용 통계 +
 * 구간 합집합 타이밍 통계.
 *
 * ① θ_sharp 경계 검산: quota-saver = 정확히 0.70, claude-hybrid ≈ 0.7692,
 *    상한 0.90 clamp, κ_quota 50% 이하 → 1.0 / 100% → 2.0
 * ② dispatch 연동: claude-hybrid 로스터에서 p = 0.74 < 0.7692 → split,
 *    quota-saver에서는 0.74 >= 0.70 → sharp (동일 p에서 프로필별 분기)
 * ③ computeCostStats: unknown 존재 시 total_usd_display === null,
 *    reported/estimated 분리 합산, v1 DB 안전 반환
 * ④ unionIntervalsMs & computeTimingStats: [0,100]+[50,150] → union 150/sum 200/
 *    gain 50, 비정상 구간 dropped, v1 DB(fork_intervals 부재) 안전 반환
 * ⑤ engine evaluateRoute/evaluateGate: sharpThreshold 파라미터 치환 + 기본 0.70
 *
 * 실행: `node --test tests/phaseb-cost-timing.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateV1Tables, openDb, resolveProjectIdentity } from '../src/decision/db.ts';
import { evaluateGate, evaluateRoute } from '../src/decision/engine.ts';
import {
  computeCostStats,
  computeDynamicSharpThreshold,
  computeQuotaMultiplier,
  computeTimingStats,
  unionIntervalsMs,
} from '../src/decision/stats.ts';
import { builtinRosterConfig, loadRosterConfig, resolveRosterProfile, type RosterProfile } from '../src/decision/roster.ts';
import { planDispatch } from '../scripts/dispatch.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ROSTER_EXAMPLE = path.join(REPO_ROOT, '.herdr', 'roster.example.json');

interface TestEnv {
  base: string;
  dbPath: string;
  repoDir: string;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `pb2a-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const repoDir = path.join(base, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  return { base, dbPath, repoDir };
}

function cleanupEnv(e: TestEnv): void {
  fs.rmSync(e.base, { recursive: true, force: true });
}

/** stats_summary에 p=0.74 (tool_select/code_search) 행을 심는다 — S=2.0, F=80/37 → p=7.52/10.1622=0.74 */
function seedPosterior74(dbPath: string, projectId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO stats_summary
         (project_id, project_label, route, tool_class, ewma_success, ewma_fail, raw_samples, consecutive_errors, updated_at_ms)
       VALUES (?, ?, 'tool_select', 'code_search', 2.0, ?, 10, 0, 1000)`
    ).run(projectId, 'seed', 80 / 37);
  } finally {
    db.close();
  }
}

function writeRoster(base: string, name: string, json: unknown): string {
  const p = path.join(base, name);
  fs.writeFileSync(p, JSON.stringify(json, null, 2));
  return p;
}

// ---------------------------------------------------------------------------

test('① θ_sharp 경계 검산: quota-saver 0.70 · claude-hybrid 0.7692 · 상한 0.90 · κ_quota 곡선', () => {
  const quotaSaver = builtinRosterConfig().profiles['quota-saver']!;
  const t1 = computeDynamicSharpThreshold({ profile: quotaSaver });
  assert.ok(Math.abs(t1.threshold - 0.7) < 1e-12, `quota-saver θ=${t1.threshold} — 기존 0.70 상수와 정확히 일치해야 함`);
  assert.ok(Math.abs(t1.exploreCost - 1.0) < 1e-12);
  assert.ok(Math.abs(t1.leadCost - 5.0) < 1e-12);
  assert.equal(t1.exploreMultiplier, 1.0);
  assert.equal(t1.leadMultiplier, 1.0);

  // 실제 .herdr/roster.example.json의 claude-hybrid (explore 3.5, lead 5.0) → (3.5+1.5)/(5.0+1.5)
  const loaded = loadRosterConfig({ rosterPath: ROSTER_EXAMPLE });
  const hyb = resolveRosterProfile(loaded.config, 'claude-hybrid').profile;
  const t2 = computeDynamicSharpThreshold({ profile: hyb });
  assert.ok(Math.abs(t2.threshold - 0.7692) < 1e-3, `claude-hybrid θ=${t2.threshold} ≈ 0.7692`);
  assert.ok(Math.abs(t2.exploreCost - 3.5) < 1e-12);
  assert.ok(Math.abs(t2.leadCost - 5.0) < 1e-12);

  // 상한 clamp: 탐색이 리드보다 훨씬 비싼 프로필 → 0.90
  const expensiveExplore: RosterProfile = {
    roles: {
      lead: { cli: 'custom', pricing: { relativeCost: 1.0 } },
      explore: { cli: 'custom', pricing: { relativeCost: 100.0 } },
      coder: { cli: 'custom' },
      verifier: { cli: 'custom' },
      advisor: { cli: 'custom' },
    },
  };
  const t3 = computeDynamicSharpThreshold({ profile: expensiveExplore });
  assert.equal(t3.threshold, 0.9, 'explore >> lead → ceil 0.90 clamp');

  // κ_quota(b) = 1 + 4·max(0, used/budget − 0.5)²
  assert.equal(computeQuotaMultiplier(0, 20), 1, 'budget 0% → 1.0');
  assert.equal(computeQuotaMultiplier(10, 20), 1, 'budget 50% → 1.0');
  assert.equal(computeQuotaMultiplier(20, 20), 2, 'budget 100% → 2.0');
  assert.equal(computeQuotaMultiplier(0, 0), 1, 'budget 미정의 → 중립 1.0');
  assert.equal(computeQuotaMultiplier(5, -1), 1, 'budget 음수 → 중립 1.0');
  assert.ok(Math.abs(computeQuotaMultiplier(15, 20) - 1.25) < 1e-12, 'budget 75% → 1.25');

  // 버킷 사용량이 θ에 실제 반영되는지: explore 버킷 소진 시 θ 상승
  const hybridLike: RosterProfile = {
    dailyTurnBudgets: { opencodex: 20 },
    roles: {
      lead: { cli: 'claude', model: 'claude-sonnet-4-6', pricing: { relativeCost: 5.0 } },
      explore: { cli: 'pi', pricing: { relativeCost: 3.5 } },
      coder: { cli: 'custom' },
      verifier: { cli: 'custom' },
      advisor: { cli: 'custom' },
    },
  };
  const cool = computeDynamicSharpThreshold({ profile: hybridLike });
  assert.ok(Math.abs(cool.threshold - 0.7692) < 1e-3);
  const hot = computeDynamicSharpThreshold({ profile: hybridLike, bucketUsage: { opencodex: 20 } });
  assert.equal(hot.exploreMultiplier, 2.0, 'opencodex 버킷 100% 소진 → κ=2.0');
  assert.ok(Math.abs(hot.exploreCost - 7.0) < 1e-12);
  assert.equal(hot.threshold, 0.9, '탐색 비용 급등 → 상한 clamp (8.5/6.5=1.31→0.90)');
});

test('② dispatch 연동: claude-hybrid p=0.74 → split / quota-saver p=0.74 → sharp + sharp_threshold 노출', () => {
  const e = makeEnv();
  try {
    const identity = resolveProjectIdentity(e.repoDir);
    seedPosterior74(e.dbPath, identity.projectId);

    const hybridRoster = writeRoster(e.base, 'roster-hybrid.json', {
      defaultProfile: 'claude-hybrid',
      profiles: {
        'claude-hybrid': {
          roles: {
            lead: { pricing: { relativeCost: 5.0 } },
            explore: { pricing: { relativeCost: 3.5 } },
          },
        },
      },
    });
    const saverRoster = writeRoster(e.base, 'roster-saver.json', {
      defaultProfile: 'quota-saver',
      profiles: {},
    });

    const hybridPlan = planDispatch({
      taskKind: 'code_search',
      repoDir: e.repoDir,
      dbPath: e.dbPath,
      dryRun: true,
      rosterPath: hybridRoster,
    });
    assert.equal(hybridPlan.ok, true);
    assert.ok(Math.abs((hybridPlan.p ?? 0) - 0.74) < 1e-6, `시드된 p=${hybridPlan.p} ≈ 0.74`);
    assert.ok(Math.abs(hybridPlan.sharp_threshold - 0.7692) < 1e-3, `claude-hybrid θ=${hybridPlan.sharp_threshold} ≈ 0.7692`);
    assert.equal(hybridPlan.decision, 'split', '0.74 < 0.7692 → split 분기 (기존 상수였다면 sharp였을 지점)');

    const saverPlan = planDispatch({
      taskKind: 'code_search',
      repoDir: e.repoDir,
      dbPath: e.dbPath,
      dryRun: true,
      rosterPath: saverRoster,
    });
    assert.equal(saverPlan.ok, true);
    assert.ok(Math.abs(saverPlan.sharp_threshold - 0.7) < 1e-12, `quota-saver θ=${saverPlan.sharp_threshold} = 0.70`);
    assert.equal(saverPlan.decision, 'sharp', '0.74 >= 0.70 → sharp 유지 (기존 상수 동작과 일치)');
  } finally {
    cleanupEnv(e);
  }
});

test('③ computeCostStats: unknown → total_usd_display null · 분리 합산 · v1 안전 반환', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      const ins = db.prepare(
        `INSERT INTO decision_events
           (project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_status)
         VALUES (?, 'wrap', 'tool_select', 'x', 'shell_exec', 1, 1.0, 0, ?, ?, ?, ?, ?, ?, ?)`
      );
      // reported 2건 ($1.00 + $0.50), estimated 1건 ($0.25), unknown 2건 (cost_usd NULL)
      ins.run('p_cost', 1000, 100_000, 50_000, 10_000, 5_000, 1.0, 'reported');
      ins.run('p_cost', 1100, 200_000, 80_000, 20_000, 8_000, 0.5, 'reported');
      ins.run('p_cost', 1200, 50_000, 20_000, 5_000, 2_000, 0.25, 'estimated');
      ins.run('p_cost', 1300, null, null, null, null, null, 'unknown');
      ins.run('p_cost', 1400, null, null, null, null, null, 'unknown');

      const s = computeCostStats(db);
      assert.equal(s.schema_v1, false);
      assert.equal(s.total_events, 5);
      assert.deepEqual(s.by_status, { reported: 2, estimated: 1, unknown: 2 });
      assert.ok(Math.abs(s.reported_usd - 1.5) < 1e-9, 'reported 분리 합산');
      assert.ok(Math.abs(s.estimated_usd - 0.25) < 1e-9, 'estimated 분리 합산');
      assert.ok(Math.abs(s.known_usd - 1.75) < 1e-9, 'known_usd = reported + estimated');
      assert.equal(s.unknown_events, 2);
      assert.equal(s.total_usd_display, null, '불변식 C-1: unknown>0 → 총액 null ($0 위장 금지)');
      assert.equal(s.tokens.input, 350_000, '토큰 합계');
      assert.equal(s.per_status.reported.events, 2);
      assert.equal(s.per_status.unknown.events, 2);
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('③-b computeCostStats: unknown 0건 → total_usd_display 합산 · days 필터 · v1 안전 반환', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      const nowMs = Date.now();
      const ins = db.prepare(
        `INSERT INTO decision_events
           (project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_status)
         VALUES (?, 'wrap', 'tool_select', 'x', 'shell_exec', 1, 1.0, 0, ?, 100, 50, 0, 0, ?, ?)`
      );
      ins.run('p2', nowMs - 1000, 2.0, 'reported');
      ins.run('p2', nowMs - 900, 0.5, 'estimated');
      const s = computeCostStats(db, { projectId: 'p2' });
      assert.equal(s.unknown_events, 0);
      assert.ok(s.total_usd_display !== null && Math.abs(s.total_usd_display - 2.5) < 1e-9, '전 건 known → 합계 2.5 표시');
      assert.ok(Math.abs(s.known_usd - 2.5) < 1e-9);

      // days 필터: 미래 윈도(0일)면 최근 1초 전 행은 제외될 수 있음 → 날짜 경계 의존성 없이 days=30 재확인
      const s30 = computeCostStats(db, { projectId: 'p2', days: 30 });
      assert.equal(s30.total_events, 2);
      const sOther = computeCostStats(db, { projectId: 'p_none' });
      assert.equal(sOther.total_events, 0);
      assert.equal(sOther.total_usd_display, 0, 'unknown 0 + known 0 → 합계 0 허용');
    } finally {
      db.close();
    }

    // v1 DB: cost_status 컬럼 부재 → 안전 반환
    const v1Path = path.join(e.base, 'v1.db');
    const raw = new DatabaseSync(v1Path);
    migrateV1Tables(raw);
    raw
      .prepare(
        `INSERT INTO decision_events (project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms)
         VALUES ('p1', 'wrap', 'tool_select', 'x', 'shell_exec', 1, 1.0, 0, 1000),
                ('p1', 'cli', 'tool_select', 'y', 'shell_exec', 1, 1.0, 0, 1100)`
      )
      .run();
    const v1 = computeCostStats(raw);
    assert.equal(v1.schema_v1, true, 'v1 DB → schema_v1 마커');
    assert.equal(v1.total_events, 2);
    assert.equal(v1.unknown_events, 2, 'v1은 전 건 unknown');
    assert.equal(v1.reported_usd, 0);
    assert.equal(v1.estimated_usd, 0);
    assert.equal(v1.total_usd_display, null, 'v1 합계는 절대 표시 안 함');
    assert.deepEqual(v1.by_status, { reported: 0, estimated: 0, unknown: 2 });
    raw.close();
  } finally {
    cleanupEnv(e);
  }
});

test('④ unionIntervalsMs & computeTimingStats: 합집합·dropped·parallel_gain·v1 안전 반환', () => {
  // 단위: 병렬 겹침 [0,100]+[50,150] → union 150, sum 200
  const u = unionIntervalsMs([
    { start: 0, end: 100 },
    { start: 50, end: 150 },
  ]);
  assert.equal(u.unionMs, 150);
  assert.equal(u.sumMs, 200);
  assert.equal(u.dropped, 0);

  // 비정상 구간 dropped + 인접 병합
  const u2 = unionIntervalsMs([
    { start: 0, end: 100 },
    { start: 150, end: 50 }, // 역전 → dropped
    { start: 100, end: 200 }, // 인접(s == curE) → 병합
  ]);
  assert.equal(u2.dropped, 1);
  assert.equal(u2.unionMs, 200, '[0,100]+[100,200] 인접 병합 → 빈틈 없는 200');
  assert.equal(u2.sumMs, 200);

  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      const mkFork = db.prepare(
        `INSERT INTO forks
           (fork_id, project_id, project_label, route, tool_class, decision, forced_split, p_at_gate, basis_at_gate,
            generation, attempt, status, closed_by, ttl_ms, created_at_ms, last_touch_ms, closed_at_ms)
         VALUES (?, 'p_t', 'p_t', 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 1, 1, 'ok', 'worker', 600000, 0, 0, 200)`
      );
      mkFork.run('f1');
      mkFork.run('f2');
      mkFork.run('f3'); // 구간 없는 레거시 fork → coverage 분모만

      const iv = db.prepare(
        `INSERT INTO fork_intervals (fork_id, attempt, phase, started_at_ms, ended_at_ms) VALUES (?, 1, ?, ?, ?)`
      );
      // f1: exec [0,100], wait [100,200]
      iv.run('f1', 'exec', 0, 100);
      iv.run('f1', 'wait', 100, 200);
      // f2: exec [50,150] — f1 exec와 병렬 겹침
      iv.run('f2', 'exec', 50, 150);
      iv.run('f2', 'wait', 150, 200);
      // 윈도(nowMs=200) 이후 미래 구간 — clip 결과 end < start → dropped
      iv.run('f1', 'wait', 500, 600);

      const t = computeTimingStats(db, { projectId: 'p_t', nowMs: 200 });
      assert.equal(t.intervals_unavailable, false);
      assert.equal(t.execution_ms, 150, 'exec 합집합 [0,100]∪[50,150] = 150');
      assert.equal(t.sum_execution_ms, 200, 'exec 단순 합 = 200');
      assert.equal(t.parallel_gain_ms, 50, '병렬 절약 = 200−150 = 50');
      assert.equal(t.wait_ms, 100, 'wait 합집합 [100,200]∪[150,200] = 100');
      assert.equal(t.wall_ms, 200, '전체 구간 0~200');
      assert.equal(t.dropped, 1, '미래 구간 clip 후 end<start → dropped');
      assert.equal(t.forks_total, 3);
      assert.equal(t.forks_with_intervals, 2);
      assert.ok(Math.abs(t.coverage_ratio - 2 / 3) < 1e-9, 'coverage = 구간 보유 2 / 전체 3');
      assert.equal(t.human_wait_ms, 0);
    } finally {
      db.close();
    }

    // v1 DB: fork_intervals 부재 → 안전 반환
    const v1Path = path.join(e.base, 'v1t.db');
    const raw = new DatabaseSync(v1Path);
    migrateV1Tables(raw);
    const tv = computeTimingStats(raw);
    assert.equal(tv.intervals_unavailable, true, 'v1 → intervals_unavailable 마커');
    assert.equal(tv.coverage_ratio, 0);
    assert.equal(tv.execution_ms, 0);
    assert.equal(tv.sum_execution_ms, 0);
    assert.equal(tv.parallel_gain_ms, 0);
    assert.equal(tv.wait_ms, 0);
    assert.equal(tv.human_wait_ms, 0);
    assert.equal(tv.wall_ms, 0);
    assert.equal(tv.dropped, 0);
    raw.close();
  } finally {
    cleanupEnv(e);
  }
});

test('⑤ engine evaluateRoute/evaluateGate: sharpThreshold 파라미터 치환 + 기본 0.70', () => {
  const e = makeEnv();
  try {
    const identity = resolveProjectIdentity(e.repoDir);
    seedPosterior74(e.dbPath, identity.projectId);
    const db = openDb(e.dbPath, { readOnly: true });
    try {
      // 기본(0.70): p=0.74 → sharp / θ=0.80 주입: split
      const rDef = evaluateRoute(db, { projectId: identity.projectId, taskKind: 'code_search' });
      assert.ok(rDef);
      assert.equal(rDef.decision, 'sharp', '기본 θ=0.70 → p=0.74 sharp');
      assert.equal(rDef.sharpThreshold, 0.7);
      const rHigh = evaluateRoute(db, { projectId: identity.projectId, taskKind: 'code_search', sharpThreshold: 0.8 });
      assert.ok(rHigh);
      assert.equal(rHigh.decision, 'split', 'θ=0.80 → p=0.74 split');
      assert.equal(rHigh.sharpThreshold, 0.8);

      const gDef = evaluateGate(db, { projectId: identity.projectId, route: 'tool_select', toolClass: 'code_search' });
      assert.equal(gDef.decision, 'sharp');
      assert.equal(gDef.sharpThreshold, 0.7);
      const gHigh = evaluateGate(db, {
        projectId: identity.projectId,
        route: 'tool_select',
        toolClass: 'code_search',
        sharpThreshold: 0.8,
      });
      assert.equal(gHigh.decision, 'split');
      assert.equal(gHigh.sharpThreshold, 0.8);

      // forcedSplit 우선 — p·θ와 무관하게 split
      const gForced = evaluateGate(db, {
        projectId: identity.projectId,
        route: 'tool_select',
        toolClass: 'code_search',
        conversationId: 'conv_forced_test',
        sharpThreshold: 0.8,
      });
      // session_consec_err 없음 → forced 아님 (p 경로만 검증)
      assert.equal(gForced.forcedSplit, false);
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});
