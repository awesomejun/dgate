/**
 * 환경류 실패 EWMA 격리 + 기록 시점 통계 게이트 테스트.
 *
 * 목적:
 * ① 환경류 cause(`tool_error`·`transient_network`) 실패는 라우트 EWMA·카운터
 *    (stats_summary)에 반영하지 않는다 — 감사 이벤트 행은 남긴다.
 * ② 환경류 격리는 커서(재시도 판정·세션 연속 실패)에는 영향을 주지 않는다.
 *    audit-only(`config_error`/`interrupted`)는 커서까지 격리함을 재확인한다(회귀).
 * ③ `recordStats:false`(트랜스크립트 과거 재생 등)는 통계만 건너뛰고 행·커서는 기록한다.
 * ④ `commitWrapOutcome`의 wrap 경로도 동일 규칙 — 환경류 cause는 표본 미기록.
 *
 * 실행: `node --test tests/environment-cause-isolation.test.ts`
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/decision/db.ts';
import * as engine from '../src/decision/engine.ts';

interface TestEnv {
  base: string;
  dbPath: string;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `envcause-${process.pid}-`));
  return { base, dbPath: path.join(base, 'decision.db') };
}

function cleanupEnv(e: TestEnv): void {
  fs.rmSync(e.base, { recursive: true, force: true });
}

interface StatsRow {
  ewma_success: number;
  ewma_fail: number;
  raw_samples: number;
  consecutive_errors: number;
}

function statsOf(dbPath: string, projectId: string): StatsRow | undefined {
  const db = openDb(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db
      .prepare(
        `SELECT ewma_success, ewma_fail, raw_samples, consecutive_errors
         FROM stats_summary WHERE project_id = ? AND route = 'tool_select' AND tool_class = 'shell_exec'`
      )
      .get(projectId) as StatsRow | undefined;
  } finally {
    db.close();
  }
}

function baseInput(overrides: Partial<engine.RecordInput>): engine.RecordInput {
  return {
    projectId: 'p_env',
    projectLabel: 'p_env',
    route: 'tool_select',
    toolClass: 'shell_exec',
    toolName: 'dg_wrap',
    ok: true,
    nowMs: 1000,
    ...overrides,
  };
}

test('① 환경류 tool_error 실패 → stats_summary 불변, 감사 행 기록, 커서 유지', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      engine.recordToolOutcome(db, baseInput({ ok: true }));
      const before = statsOf(e.dbPath, 'p_env');
      assert.ok(before, '기준 표본 존재');

      const res = engine.recordToolOutcome(
        db,
        baseInput({
          ok: false,
          cause: 'tool_error',
          errorSnippet: 'extension crashed',
          conversationId: 'conv-env',
          step: 5,
          nowMs: 2000,
        })
      );
      assert.equal(res.recorded, true, '감사 행은 기록된다');

      const after = statsOf(e.dbPath, 'p_env');
      assert.deepEqual(
        after,
        before,
        '환경류 tool_error는 EWMA·카운터(raw_samples·consecutive_errors 포함)를 바꾸지 않는다'
      );

      const events = db
        .prepare(`SELECT ok, cause FROM decision_events WHERE conversation_id = 'conv-env'`)
        .all() as { ok: number; cause: string | null }[];
      assert.equal(events.length, 1, '감사 이벤트 행 1건');
      assert.equal(events[0]!.ok, 0);
      assert.equal(events[0]!.cause, 'tool_error');

      // 커서는 유지 — 환경 실패 후 재시도 판정·세션 카운터는 계속 동작
      assert.equal(res.sessionConsecErr, 1, '세션 연속 실패 카운터는 환경 실패도 센다');
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('② 환경류 transient_network 실패 → stats_summary 불변, 감사 행 기록', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      engine.recordToolOutcome(db, baseInput({ ok: true }));
      const before = statsOf(e.dbPath, 'p_env');
      assert.ok(before);

      const res = engine.recordToolOutcome(
        db,
        baseInput({ ok: false, cause: 'transient_network', errorSnippet: 'ECONNRESET', nowMs: 2000 })
      );
      assert.equal(res.recorded, true);
      assert.deepEqual(statsOf(e.dbPath, 'p_env'), before, '일시적 네트워크 장애도 EWMA 격리');
      const n = db.prepare(`SELECT COUNT(*) AS n FROM decision_events`).get() as { n: number };
      assert.equal(n.n, 2, '감사 행은 2건(기준 + 환경 실패)');
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('③ recordStats:false → 통계 미반영, 행·커서는 기록(과거 재생 게이트)', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      engine.recordToolOutcome(db, baseInput({ ok: true }));
      const before = statsOf(e.dbPath, 'p_env');
      assert.ok(before);

      // 작업 실패 cause(gate_fail)라도 recordStats:false면 통계 미반영
      const res = engine.recordToolOutcome(
        db,
        baseInput({
          ok: false,
          cause: 'gate_fail',
          conversationId: 'conv-old',
          step: 3,
          recordStats: false,
          nowMs: 2000,
        })
      );
      assert.equal(res.recorded, true, '행은 기록');
      assert.deepEqual(statsOf(e.dbPath, 'p_env'), before, 'recordStats:false는 EWMA 미갱신');
      assert.equal(res.sessionConsecErr, 1, '커서는 통계 게이트와 무관하게 갱신');
      const n = db.prepare(`SELECT COUNT(*) AS n FROM decision_events`).get() as { n: number };
      assert.equal(n.n, 2);
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('④ commitWrapOutcome 환경류 cause → committed·감사 행, 표본(recorded) 0건', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      for (const cause of ['tool_error', 'transient_network'] as const) {
        const forkId = engine.issueFork(db, {
          projectId: 'p_env',
          projectLabel: 'p_env',
          route: 'tool_select',
          toolClass: 'shell_exec',
          decision: 'sharp',
          pAtGate: 0.8,
          basisAtGate: 'prior',
          forcedSplit: false,
          nowMs: 1000,
        });
        const res = engine.commitWrapOutcome(db, {
          forkId,
          projectId: 'p_env',
          projectLabel: 'p_env',
          route: 'tool_select',
          toolClass: 'shell_exec',
          ok: false,
          outcome: 'fail',
          cause,
          nowMs: 2000,
        });
        assert.equal(res.committed, true, `${cause} 커밋은 성공`);
        assert.equal(res.recorded, false, `${cause}는 표본 미기록`);
      }
      assert.equal(statsOf(e.dbPath, 'p_env'), undefined, 'EWMA 행 자체가 생기지 않는다');
      const events = db
        .prepare(`SELECT cause FROM decision_events WHERE source = 'wrap'`)
        .all() as { cause: string | null }[];
      assert.equal(events.length, 2, '감사 행은 2건 기록');
      assert.deepEqual(
        events.map((r) => r.cause).sort(),
        ['tool_error', 'transient_network'],
        '감사 행 cause 보존'
      );
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('⑤ 회귀: audit-only(config_error)는 통계·커서 모두 격리 — 환경류와 분리됨', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    try {
      engine.recordToolOutcome(db, baseInput({ ok: true }));
      const before = statsOf(e.dbPath, 'p_env');
      assert.ok(before);

      const res = engine.recordToolOutcome(
        db,
        baseInput({
          ok: false,
          cause: 'config_error',
          errorSnippet: 'command not found',
          conversationId: 'conv-cfg',
          step: 2,
          nowMs: 2000,
        })
      );
      assert.equal(res.recorded, true);
      assert.deepEqual(statsOf(e.dbPath, 'p_env'), before, 'config_error EWMA 격리 유지');
      assert.equal(res.sessionConsecErr, 0, 'config_error는 커서(세션 카운터)도 격리');
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});
