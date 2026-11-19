/**
 * PB-1 테스트 매트릭스 (brief-pb1 §3.E): DDL v2 무손실 마이그레이션 + fork_intervals
 * 생명주기 + `dg attempt` 펜싱 토큰 + readOnly 호환성.
 *
 * ① 실제 v1 DDL(user_version=0, forks 18컬럼) → v2 승격: 백업·데이터 보존·백필·승격
 * ② 마이그레이션 강제 실패 → 단일 Tx 롤백으로 v1 스키마·user_version=0 무손실 보존
 * ③ 6개 자식 프로세스가 동일 v1 DB에 동시 `dg gate` → 전원 exit 0 + 단일 승격
 * ④ `readTelemetrySnapshot`이 v1·v2 양쪽에서 readOnly로 정상 동작(마이그레이션 무유발)
 * ⑤ `dg attempt` → {attempt:2,generation:1}, `--bump-gen` → {generation:2,attempt:3},
 *    구 attempt로의 fail 커밋은 펜싱 거부
 * ⑥ fork_intervals 생명주기: issue(wait) → wrap(exec→close) → settleOrphans 정리,
 *    fk_fallback은 구간 미기록
 * ⑦ F-1 회귀: 라운드마다 완전 신규(미존재) DB에 8자식 동시 `dg record` ×5 →
 *    fallback·`table forks already exists`·SQLITE_BUSY 0건, 40/40 recorded + 행수 일치
 *
 * 실행: `node --test tests/phaseb-migration.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { getSchemaVersion, hasColumn, hasTable, migrateV1Tables, openDb } from '../src/decision/db.ts';
import * as engine from '../src/decision/engine.ts';
import { readTelemetrySnapshot } from '../src/decision/telemetry.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');

interface TestEnv {
  base: string;
  dbPath: string;
  projDir: string;
  env: NodeJS.ProcessEnv;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `pb1-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const projDir = path.join(base, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  return { base, dbPath, projDir, env: { ...process.env, GEMINI_TRICK_DB_PATH: dbPath } };
}

function cleanupEnv(e: TestEnv): void {
  fs.rmSync(e.base, { recursive: true, force: true });
}

function dg(e: TestEnv, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DG_PATH, ...args], { env: e.env, encoding: 'utf8' });
}

function dgAsync(e: TestEnv, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
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

/**
 * 실제 v1 픽스처 생성 — raw `DatabaseSync`로만 만든다(`openDb`는 즉시 v2로 승격하므로).
 * forks: 정상 리스 / 절반 리스 / 손상 JSON / waiting_human 메타 / ok 행 5건.
 */
function buildV1Db(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  migrateV1Tables(raw);
  const ins = raw.prepare(
    `INSERT INTO forks
       (fork_id, project_id, project_label, conversation_id, route, tool_class, decision,
        forced_split, p_at_gate, basis_at_gate, status, closed_by, neon_verdict,
        ttl_ms, created_at_ms, last_touch_ms, closed_at_ms, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run('fk_norm', 'p1', 'p1', null, 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 'open', null, null, 600000, 1000, 1000, null,
    JSON.stringify({ gen: 2, attempt: 3, lease_owner: 'sess-1', lease_until_ms: 99999, repo_scope: '/x' }));
  ins.run('fk_half', 'p1', 'p1', null, 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 'open', null, null, 600000, 1000, 1000, null,
    JSON.stringify({ lease_owner: 'sess-2' })); // 절반 리스 — owner만 있고 expires 없음
  ins.run('fk_corrupt', 'p1', 'p1', null, 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 'open', null, null, 600000, 1000, 1000, null,
    '{not valid json');
  ins.run('fk_wait', 'p1', 'p1', null, 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 'open', null, null, 600000, 1000, 1000, null,
    JSON.stringify({ waiting_human: true, waiting_since_ms: 500 }));
  ins.run('fk_ok', 'p1', 'p1', null, 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 'ok', 'worker', null, 600000, 1000, 1000, 2000,
    JSON.stringify({ gen: 1, attempt: 1 }));
  raw
    .prepare(
      `INSERT INTO stats_summary
         (project_id, project_label, route, tool_class, ewma_success, ewma_fail, raw_samples, consecutive_errors, updated_at_ms)
       VALUES ('p1', 'p1', 'tool_select', 'shell_exec', 2.0, 1.0, 5, 0, 1000)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO decision_events
         (project_id, source, route, tool_name, tool_class, ok, weight, is_retry, created_at_ms, error_snippet)
       VALUES
         ('p1', 'wrap', 'tool_select', 'x', 'shell_exec', 0, 1.0, 0, 1000, 'cause=stall; boom'),
         ('p1', 'cli', 'tool_select', 'y', 'shell_exec', 1, 1.0, 0, 1100, NULL)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO session_cursor (conversation_id, project_id, has_hook_coverage, session_consec_err, updated_at_ms)
       VALUES ('conv1', 'p1', 1, 0, 1000)`
    )
    .run();
  raw
    .prepare(`INSERT INTO agy_budget (day, turns_used, sessions_started, updated_at_ms) VALUES ('2026-01-01', 3, 1, 1000)`)
    .run();
  raw.close();
}

/**
 * 무손실 해시 — 마이그레이션이 의도적으로 바꾸는 값(forks.status의 waiting_human 승격)만
 * 제외한 모든 테이블·컬럼의 직렬화 스냅숏. forks는 status를 제외한 17개 공유 컬럼.
 */
function snapshotDb(db: DatabaseSync): string {
  const parts: string[] = [];
  const forkColsNoStatus =
    'fork_id,project_id,project_label,conversation_id,route,tool_class,decision,forced_split,p_at_gate,basis_at_gate,closed_by,neon_verdict,ttl_ms,created_at_ms,last_touch_ms,closed_at_ms,metadata_json';
  parts.push(`forks=${JSON.stringify(db.prepare(`SELECT ${forkColsNoStatus} FROM forks ORDER BY fork_id`).all())}`);
  parts.push(`stats=${JSON.stringify(db.prepare('SELECT * FROM stats_summary ORDER BY project_id,route,tool_class').all())}`);
  const eventCols =
    'event_id,dedupe_key,fork_id,project_id,conversation_id,source,route,tool_name,tool_class,ok,weight,is_retry,target_hash,error_snippet,created_at_ms';
  parts.push(`events=${JSON.stringify(db.prepare(`SELECT ${eventCols} FROM decision_events ORDER BY event_id`).all())}`);
  parts.push(`cursor=${JSON.stringify(db.prepare('SELECT * FROM session_cursor ORDER BY conversation_id').all())}`);
  parts.push(`budget=${JSON.stringify(db.prepare('SELECT * FROM agy_budget ORDER BY day').all())}`);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function backupFiles(base: string): string[] {
  return fs.readdirSync(base).filter((f) => f.includes('.v1.bak.'));
}

interface IntervalRow {
  fork_id: string;
  attempt: number;
  phase: string;
  started_at_ms: number;
  ended_at_ms: number | null;
}

// ---------------------------------------------------------------------------

test('① v1→v2 무손실 마이그레이션: 백업·보존 해시·리스 백필·waiting_human 승격·컬럼 신설', () => {
  const e = makeEnv();
  try {
    buildV1Db(e.dbPath);
    const pre = new DatabaseSync(e.dbPath);
    const preHash = snapshotDb(pre);
    assert.equal(getSchemaVersion(pre), 0, 'v1 픽스처는 user_version=0');
    assert.equal(pre.prepare('PRAGMA table_info(forks)').all().length, 18, 'v1 forks는 18컬럼');
    pre.close();

    const db = openDb(e.dbPath);
    try {
      assert.equal(getSchemaVersion(db), 2, 'user_version이 2로 승격');
      assert.ok(backupFiles(e.base).length >= 1, '.v1.bak.* 백업 파일 미생성');
      // 무손실: status 승격을 제외한 모든 데이터 동일
      assert.equal(snapshotDb(db), preHash, '마이그레이션 데이터 손실 감지');
      // forks 행 수 보존
      assert.equal((db.prepare('SELECT COUNT(*) n FROM forks').get() as { n: number }).n, 5);
      const rows = new Map(
        (
          db.prepare(
            `SELECT fork_id, status, closed_by, generation, attempt, lease_owner, lease_expires_ms, metadata_json FROM forks`
          ).all() as {
            fork_id: string;
            status: string;
            closed_by: string | null;
            generation: number;
            attempt: number;
            lease_owner: string | null;
            lease_expires_ms: number | null;
            metadata_json: string | null;
          }[]
        ).map((r) => [r.fork_id, r])
      );
      const norm = rows.get('fk_norm')!;
      assert.equal(norm.generation, 2, 'metadata gen 승격');
      assert.equal(norm.attempt, 3, 'metadata attempt 승격');
      assert.equal(norm.lease_owner, 'sess-1', '유효 리스 owner 백필');
      assert.equal(norm.lease_expires_ms, 99999, '유효 리스 expires 백필');
      const half = rows.get('fk_half')!;
      assert.equal(half.lease_owner, null, '절반 리스 owner는 NULL 정규화');
      assert.equal(half.lease_expires_ms, null, '절반 리스 expires는 NULL 정규화');
      assert.equal(half.generation, 1);
      const corrupt = rows.get('fk_corrupt')!;
      assert.equal(corrupt.lease_owner, null, '손상 JSON은 리스 NULL');
      assert.equal(corrupt.lease_expires_ms, null);
      assert.equal(corrupt.generation, 1, '손상 JSON은 gen 기본 1');
      assert.equal(corrupt.status, 'open');
      assert.equal(rows.get('fk_wait')!.status, 'waiting_human', 'waiting_human 메타 → status 승격');
      const okRow = rows.get('fk_ok')!;
      assert.equal(okRow.status, 'ok', 'ok 행은 ok 유지(승격 대상 아님)');
      assert.equal(okRow.closed_by, 'worker');
      // 신규 오브젝트
      assert.ok(hasTable(db, 'fork_intervals'), 'fork_intervals 신설');
      for (const col of ['cause', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'cost_status']) {
        assert.ok(hasColumn(db, 'decision_events', col), `decision_events.${col} 미추가`);
      }
      // cause 백필: cause= 접두 에러만 enum으로
      const ev = db.prepare(`SELECT cause FROM decision_events WHERE error_snippet LIKE 'cause=%'`).get() as { cause: string };
      assert.equal(ev.cause, 'stall', '레거시 cause= 접두 백필');
      const evNull = db.prepare('SELECT cause FROM decision_events WHERE error_snippet IS NULL').get() as { cause: string | null };
      assert.equal(evNull.cause, null, '접두 없는 행은 cause NULL 유지');
      assert.ok(hasColumn(db, 'forks', 'generation') && hasColumn(db, 'forks', 'attempt'));
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('② 마이그레이션 강제 실패: 단일 Tx 롤백 → v1 스키마·데이터·user_version=0 보존', () => {
  const e = makeEnv();
  try {
    buildV1Db(e.dbPath);
    // 리빌드 대상 테이블명과 충돌하는 오브젝트를 심어 DDL 실패 유발
    const raw = new DatabaseSync(e.dbPath);
    raw.exec('CREATE TABLE forks_v2 (x INTEGER)');
    raw.close();
    assert.throws(() => openDb(e.dbPath), /forks_v2|already exists|migration/i);
    // 롤백 후 v1 상태 그대로 — raw 핸들로만 검증(openDb는 재시도 후 다시 throw)
    const chk = new DatabaseSync(e.dbPath);
    try {
      assert.equal(getSchemaVersion(chk), 0, '롤백 후에도 user_version=0 유지');
      assert.equal(hasColumn(chk, 'forks', 'generation'), false, 'v1 forks 그대로');
      assert.equal((chk.prepare('SELECT COUNT(*) n FROM forks').get() as { n: number }).n, 5, '데이터 행 보존');
      const fork = chk.prepare(`SELECT status, metadata_json FROM forks WHERE fork_id = 'fk_norm'`).get() as {
        status: string;
        metadata_json: string;
      };
      assert.equal(fork.status, 'open');
      assert.equal(JSON.parse(fork.metadata_json).gen, 2, '원본 메타 보존');
      assert.equal(hasTable(chk, 'fork_intervals'), false, 'fork_intervals도 롤백');
    } finally {
      chk.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('③ 동시 마이그레이션: 6개 자식 `dg gate` → 전원 exit 0 + 단일 승격 user_version=2', async () => {
  const e = makeEnv();
  try {
    buildV1Db(e.dbPath);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        dgAsync(e, ['gate', '--route', 'tool_select', '--tool-class', 'shell_exec', '--project', e.projDir, '--json'])
      )
    );
    for (const [i, r] of results.entries()) {
      assert.equal(r.status, 0, `child ${i} exit ${r.status}: ${r.stderr.slice(0, 300)}`);
      const parsed = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { fork_id: string };
      assert.match(parsed.fork_id, /^fk_/, 'gate가 fork 발행');
    }
    const db = openDb(e.dbPath, { readOnly: true, busyTimeoutMs: 1000 });
    try {
      assert.equal(getSchemaVersion(db), 2, '정확히 1회 승격 후 user_version=2');
      assert.equal((db.prepare('SELECT COUNT(*) n FROM forks').get() as { n: number }).n, 5 + 6, 'v1 5행 + 신규 gate 6행');
      assert.ok(hasTable(db, 'fork_intervals'));
    } finally {
      db.close();
    }
    assert.ok(backupFiles(e.base).length >= 1, '마이그레이션 백업 파일 존재');
  } finally {
    cleanupEnv(e);
  }
});

test('④ telemetry readOnly 하위호환: v1·v2 모두 live:true + 4라우트, v1은 승격 없음', () => {
  const e = makeEnv();
  try {
    buildV1Db(e.dbPath);
    // v1(user_version=0) readOnly 스냅숏 — 마이그레이션을 유발하지 않아야 한다
    const snapV1 = readTelemetrySnapshot(e.dbPath, e.projDir);
    assert.equal(snapV1.live, true, 'v1 DB live 스냅숏');
    assert.equal(snapV1.routes.length, 4, '4라우트 반환');
    const chk = new DatabaseSync(e.dbPath);
    try {
      assert.equal(getSchemaVersion(chk), 0, 'readOnly 스냅숏 후에도 v1 유지(승격 무유발)');
    } finally {
      chk.close();
    }
    // v2 승격 후 스냅숏도 정상
    const w = openDb(e.dbPath);
    w.close();
    const snapV2 = readTelemetrySnapshot(e.dbPath, e.projDir);
    assert.equal(snapV2.live, true, 'v2 DB live 스냅숏');
    assert.equal(snapV2.routes.length, 4);
  } finally {
    cleanupEnv(e);
  }
});

test('⑤ dg attempt: attempt+1 / --bump-gen gen+1·attempt+1 / 구 attempt 펜싱 거부', () => {
  const e = makeEnv();
  try {
    const issueDb = openDb(e.dbPath);
    const forkId = engine.issueFork(issueDb, {
      projectId: 'p_att',
      projectLabel: 'p_att',
      route: 'tool_select',
      toolClass: 'shell_exec',
      decision: 'sharp',
      pAtGate: 0.8,
      basisAtGate: 'prior',
      forcedSplit: false,
    });
    issueDb.close();
    const r1 = dgOk(e, ['attempt', '--fork', forkId]);
    assert.equal(r1.attempt, 2, 'dg attempt → attempt 2');
    assert.equal(r1.generation, 1, 'dg attempt → generation 유지');
    assert.equal(r1.fork_id, forkId);
    const r2 = dgOk(e, ['attempt', '--fork', forkId, '--bump-gen']);
    assert.equal(r2.generation, 2, '--bump-gen → generation 2');
    assert.equal(r2.attempt, 3, '--bump-gen → attempt도 +1');
    // 구 attempt(1)로 fail 커밋 → attempt 펜싱 거부
    const db = openDb(e.dbPath);
    try {
      const res = engine.commitWrapOutcome(db, {
        forkId,
        projectId: 'p_att',
        projectLabel: 'p_att',
        route: 'tool_select',
        toolClass: 'shell_exec',
        ok: false,
        outcome: 'fail',
        cause: 'tool_error',
        expectedAttempt: 1,
      });
      assert.equal(res.committed, false, '구 attempt 커밋 허용됨');
      assert.equal(res.reason, 'stale_attempt');
      // fork는 여전히 열려 있다(거부된 커밋이 상태를 바꾸지 않음)
      const fork = engine.getFork(db, forkId)!;
      assert.equal(fork.status, 'open');
      assert.equal(fork.attempt, 3);
      assert.equal(fork.generation, 2);
    } finally {
      db.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('⑥ fork_intervals 생명주기: issue(wait)→wrap(exec·close)→settle 정리·fk_fallback 생략', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    let forkId: string;
    try {
      forkId = engine.issueFork(db, {
        projectId: 'p_iv',
        projectLabel: 'p_iv',
        route: 'tool_select',
        toolClass: 'shell_exec',
        decision: 'sharp',
        pAtGate: 0.8,
        basisAtGate: 'prior',
        forcedSplit: false,
        ttlMs: 600_000,
      });
      const iv = db
        .prepare('SELECT phase, attempt, ended_at_ms FROM fork_intervals WHERE fork_id = ?')
        .all(forkId) as IntervalRow[];
      assert.equal(iv.length, 1, 'issueFork가 wait 구간 1건 생성');
      assert.equal(iv[0]!.phase, 'wait');
      assert.equal(iv[0]!.attempt, 1);
      assert.equal(iv[0]!.ended_at_ms, null, '발행 직후 wait 구간은 열려 있음');
    } finally {
      db.close();
    }

    // dg wrap: 스폰 시 exec 구간 → 커밋 시 전부 종결
    const res = dg(e, [
      'wrap', '--route', 'tool_select', '--tool-class', 'shell_exec',
      '--fork', forkId!, '--project', e.projDir, '--',
      'node', '-e', 'process.exit(0)',
    ]);
    assert.equal(res.status, 0, `wrap exit ${res.status}: ${res.stderr}`);
    const summary = JSON.parse(res.stderr.trim().split('\n').at(-1)!) as { committed: boolean; outcome: string };
    assert.equal(summary.committed, true);

    const db2 = openDb(e.dbPath);
    try {
      const ivAll = db2
        .prepare('SELECT phase, attempt, ended_at_ms FROM fork_intervals WHERE fork_id = ? ORDER BY interval_id')
        .all(forkId!) as IntervalRow[];
      const phases = ivAll.map((r) => r.phase);
      assert.ok(phases.includes('exec'), 'exec 구간 미기록');
      assert.ok(phases.includes('wait'), 'wait 구간 미기록');
      assert.equal(
        ivAll.filter((r) => r.ended_at_ms === null).length,
        0,
        '커밋 후 열린 구간 잔존'
      );

      // 고아 정산이 열린 구간도 함께 닫는다
      const orphan = engine.issueFork(db2, {
        projectId: 'p_iv2',
        projectLabel: 'p_iv2',
        route: 'tool_select',
        toolClass: 'shell_exec',
        decision: 'sharp',
        pAtGate: 0.8,
        basisAtGate: 'prior',
        forcedSplit: false,
        ttlMs: 500,
        nowMs: Date.now() - 60_000,
      });
      const settled = engine.settleOrphans(db2, Date.now());
      assert.ok(settled.forkIds.includes(orphan), 'stale fork 미정산');
      assert.equal(
        (db2.prepare('SELECT COUNT(*) n FROM fork_intervals WHERE fork_id = ? AND ended_at_ms IS NULL').get(orphan) as { n: number }).n,
        0,
        '정산 후 열린 구간 잔존'
      );

      // fk_fallback: 합성 ID는 구간 미기록(§3.2)
      engine.recordForkIntervalStart(db2, { forkId: 'fk_fallback_dead00', attempt: 1, phase: 'exec', nowMs: Date.now() });
      assert.equal(
        (db2.prepare(`SELECT COUNT(*) n FROM fork_intervals WHERE fork_id = 'fk_fallback_dead00'`).get() as { n: number }).n,
        0,
        'fk_fallback 구간이 기록됨'
      );
    } finally {
      db2.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('⑦ F-1 회귀: 라운드마다 미존재 DB에 8자식 동시 record = 40/40 무손실·경합 에러 0건', async () => {
  const e = makeEnv();
  try {
    // 라운드마다 완전 신규(미존재) DB — 신규 생성 경합(F-1)을 매 라운드 재현
    for (let round = 0; round < 5; round++) {
      const roundDb = path.join(e.base, `decision-r${round}.db`);
      const roundEnv: TestEnv = {
        ...e,
        dbPath: roundDb,
        env: { ...process.env, GEMINI_TRICK_DB_PATH: roundDb },
      };
      const batch = await Promise.all(
        Array.from({ length: 8 }, () =>
          dgAsync(roundEnv, [
            'record', '--route', 'tool_select', '--tool-class', 'shell_exec', '--tool', 'run_command',
            '--ok', '1', '--project', e.projDir, '--json',
          ])
        )
      );
      for (const [i, c] of batch.entries()) {
        assert.equal(c.status, 0, `r${round} child ${i} exit=${c.status} stderr=${c.stderr}`);
        assert.ok(!c.stderr.includes('[dg] db fallback'), `r${round} child ${i} db fallback: ${c.stderr}`);
        assert.ok(!c.stderr.includes('already exists'), `r${round} child ${i} DDL 경합: ${c.stderr}`);
        assert.ok(!c.stderr.includes('SQLITE_BUSY'), `r${round} child ${i} SQLITE_BUSY: ${c.stderr}`);
        const out = JSON.parse(c.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
        assert.equal(out.recorded, true, `r${round} child ${i} 미기록: ${JSON.stringify(out)}`);
      }
      const chk = new DatabaseSync(roundDb);
      try {
        assert.equal(
          (chk.prepare('SELECT COUNT(*) n FROM decision_events').get() as { n: number }).n,
          8,
          `r${round} decision_events 8/8 미달`
        );
        assert.equal(getSchemaVersion(chk), 2, `r${round} user_version=2 아님`);
      } finally {
        chk.close();
      }
    }
  } finally {
    cleanupEnv(e);
  }
});
