/**
 * W1 Decision 엔진·`dg` CLI 통합 테스트 (plan-r2.1 §7.2 + brief-w1 §4).
 *
 * 목적: 감쇠 EWMA Beta·강제 split(N7)·재시도 단일 귀속(B7)·Fork 생명주기(B1)·
 * 자기 호출 제외(B6)·프로젝트 격리·WAL 동시성·선행 버그 1/4 회귀를 통합 검증한다.
 *
 * 실행: `node --test tests/decision-engine.test.ts` (외부 의존성 0개, 임시 GEMINI_TRICK_DB_PATH 사용)
 *
 * 주의: 모든 테스트는 고유 임시 디렉터리 DB를 사용한다 — 전역 풀(__GLOBAL__) 오염이
 * 기대값에 미치는 영향을 통제하기 위해 테스트마다 DB를 새로 만든다.
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
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');

interface TestEnv {
  base: string;
  dbPath: string;
  projDir: string;
  env: NodeJS.ProcessEnv;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dgtest-${process.pid}-`));
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

/** 진짜 동시 실행(비블로킹 spawn) — WAL 다중 writer 경합 재현용 */
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

function dgStat(e: TestEnv, sql: string, ...params: (string | number | null)[]): unknown {
  const db = openDb(e.dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

/** 콜드 프로젝트에서 단일 프로젝트 스트림의 기대 사후확률(전역 풀 미러 공식 — §4.2·§4.3) */
function mirrorPosterior(records: Array<{ ok: boolean; w?: number }>, p0: number): number {
  const w = (r: { ok: boolean; w?: number }) => r.w ?? 1;
  let S = 0;
  let F = 0;
  for (const r of records) {
    S = engine.GAMMA * S + (r.ok ? w(r) : 0);
    F = engine.GAMMA * F + (r.ok ? 0 : w(r));
  }
  const Sg = S; // 단일 프로젝트 → 전역 풀이 동일 스트림을 미러
  const Fg = F;
  const lambda = Math.min(0.25, (Sg + Fg) / (Sg + Fg + 20));
  const pGlob = (engine.M0 * p0 + Sg) / (engine.M0 + Sg + Fg);
  const pHier = (1 - lambda) * p0 + lambda * pGlob;
  const alpha = engine.M0 * pHier;
  return (alpha + S) / (engine.M0 + S + F);
}

function rec(
  db: ReturnType<typeof openDb>,
  projectId: string,
  route: engine.RouteId,
  toolClass: string,
  ok: boolean,
  extra: Partial<engine.RecordInput> = {}
) {
  return engine.recordToolOutcome(db, {
    projectId,
    projectLabel: projectId,
    route,
    toolClass,
    toolName: 'test_tool',
    ok,
    source: 'cli',
    ...extra,
  });
}

// ---------------------------------------------------------------------------

test('1. 유효 4종 Route 기록 & 자유 문자열 거부 (exit 2)', () => {
  const e = makeEnv();
  try {
    for (const route of engine.ROUTE_IDS) {
      const out = dgOk(e, [
        'record',
        '--route',
        route,
        '--tool-class',
        'other',
        '--tool',
        'some_tool',
        '--ok',
        '1',
        '--project',
        e.projDir,
      ]);
      assert.equal(out.recorded, true, `${route} should record`);
    }
    // 자유 문자열 라우트 거부
    for (const bad of ['bogus_route', '어느 파일', 'sharp', '']) {
      const res = dg(e, [
        'record',
        '--route',
        bad,
        '--tool-class',
        'other',
        '--tool',
        't',
        '--ok',
        '1',
        '--project',
        e.projDir,
      ]);
      assert.equal(res.status, 2, `route "${bad}" must exit 2 (stderr: ${res.stderr})`);
    }
    // N-NEW-6: 'stream'은 source enum에 없다(DDL·CLI 통일 8값)
    const resStream = dg(e, [
      'record',
      '--route',
      'tool_select',
      '--tool-class',
      'other',
      '--tool',
      't',
      '--ok',
      '1',
      '--source',
      'stream',
      '--project',
      e.projDir,
    ]);
    assert.equal(resStream.status, 2, "--source stream must exit 2");
    const row = dgStat(
      e,
      'SELECT COUNT(*) AS n FROM decision_events WHERE project_id != ?',
      GLOBAL_PROJECT_ID
    ) as { n: number };
    assert.equal(row.n, 4);
  } finally {
    cleanupEnv(e);
  }
});

test('2. 감쇠 EWMA 콜드스타트 연속성(n=4→5 점프 0) + 500승 후 5연속 실패 p<0.70', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    const p0 = engine.priorP0('tool_select', 'shell_exec'); // 0.74
    const stream: Array<{ ok: boolean }> = [];
    let post = engine.getPosterior(db, 'projA', 'tool_select', 'shell_exec');
    assert.ok(Math.abs(post.p - p0) < 1e-9, '콜드스타트 p === p0');
    assert.equal(post.basis, 'prior');
    for (let n = 1; n <= 5; n++) {
      rec(db, 'projA', 'tool_select', 'shell_exec', true);
      stream.push({ ok: true });
      post = engine.getPosterior(db, 'projA', 'tool_select', 'shell_exec');
      const expected = mirrorPosterior(stream, p0);
      assert.ok(
        Math.abs(post.p - expected) < 1e-9,
        `n=${n}: p=${post.p} vs expected=${expected} (동일 Beta 식 연속 적용 — 점프 0)`
      );
      assert.equal(post.samples, n);
      assert.equal(post.basis, n >= engine.N_MIN ? 'measured' : 'prior', `basis at n=${n}`);
    }
    // n=4→5 경계에서 불연속 점프 없음: 두 값 모두 동일 폐쇄형과 일치(위에서 검증) +
    // 단조 연속성 확인
    const p4 = mirrorPosterior(stream.slice(0, 4), p0);
    const p5 = mirrorPosterior(stream, p0);
    assert.ok(p5 > p4, '성공 추가 시 p 단조 증가(경계에서 급락/점프 없음)');

    // 500연속 성공 → 5연속 실패
    for (let i = 0; i < 500; i++) {
      rec(db, 'projA', 'tool_select', 'shell_exec', true);
      stream.push({ ok: true });
    }
    post = engine.getPosterior(db, 'projA', 'tool_select', 'shell_exec');
    assert.ok(post.p > 0.9, `포화 p=${post.p} ≈ 0.93`);
    for (let i = 0; i < 5; i++) {
      rec(db, 'projA', 'tool_select', 'shell_exec', false);
      stream.push({ ok: false });
    }
    post = engine.getPosterior(db, 'projA', 'tool_select', 'shell_exec');
    assert.ok(
      Math.abs(post.p - mirrorPosterior(stream, p0)) < 1e-9,
      `500+5 후 p도 동일 폐쇄형(${mirrorPosterior(stream, p0).toFixed(4)})`
    );
    assert.ok(post.p < 0.7, `5연속 실패 후 p=${post.p.toFixed(4)} < 0.70 하강`);
    assert.equal(post.consecutiveErrors, 5);
    db.close();
  } finally {
    cleanupEnv(e);
  }
});

test('3. 키별 1회 실패 기대값 (N2 표: 0.634 split · 0.686 split · 0.806 sharp)', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    const cases: Array<[engine.RouteId, string, number, 'sharp' | 'split']> = [
      ['tool_select', 'shell_exec', 0.634, 'split'],
      ['delegate_swarm', 'swarm_dispatch', 0.686, 'split'],
      ['file_select', 'file_read', 0.806, 'sharp'],
    ];
    for (const [route, toolClass, expected, decision] of cases) {
      const projectId = `proj_${toolClass}`;
      const res = rec(db, projectId, route, toolClass, false);
      // 전역 풀 미러(λ>0)까지 반영한 정확값 — §4.3 표 기대값(≈)과 0.01 이내
      const p0 = engine.priorP0(route, toolClass);
      const exact = mirrorPosterior([{ ok: false }], p0);
      assert.ok(Math.abs(res.pAfter - exact) < 1e-9, `${toolClass}: pAfter=${res.pAfter} vs ${exact}`);
      assert.ok(
        Math.abs(res.pAfter - expected) < 0.01,
        `${toolClass}: pAfter=${res.pAfter.toFixed(4)} ≈ ${expected} (±0.01)`
      );
      assert.equal(res.pAfter >= 0.7 ? 'sharp' : 'split', decision, `${toolClass} → ${decision}`);
    }
    db.close();
  } finally {
    cleanupEnv(e);
  }
});

test('4. 연속 오류 2회 강제 split + N7 키/세션 카운터 리셋 스코프 분리', () => {
  const e = makeEnv();
  try {
    // 키 카운터: (file_select, file_edit) 2실패 → 강제 split
    for (let i = 0; i < 2; i++) {
      dgOk(e, ['record', '--route', 'file_select', '--tool-class', 'file_edit', '--tool', 'edit_file', '--ok', '0', '--project', e.projDir]);
    }
    let gate = dgOk(e, ['gate', '--route', 'file_select', '--tool-class', 'file_edit', '--project', e.projDir]);
    assert.equal(gate.decision, 'split');
    assert.equal(gate.forced_split, true);
    assert.equal(gate.escalate_carbon, true);
    assert.equal(gate.forced_reason, 'consecutive_errors>=2');
    assert.equal(gate.consecutive_errors, 2);
    assert.equal(gate.session_consec_err, 0, '대화 미지정 → 세션 카운터 0 (분리 출력)');

    // N7 키 스코프: 다른 키 성공은 file_edit 키 카운터를 리셋하지 않는다
    dgOk(e, ['record', '--route', 'tool_select', '--tool-class', 'code_search', '--tool', 'grep_search', '--ok', '1', '--project', e.projDir]);
    gate = dgOk(e, ['gate', '--route', 'file_select', '--tool-class', 'file_edit', '--project', e.projDir]);
    assert.equal(gate.forced_split, true, '타 키 성공 후에도 동일 키 카운터 유지(N7)');
    assert.equal(gate.consecutive_errors, 2);

    // 동일 키 성공 → 리셋
    dgOk(e, ['record', '--route', 'file_select', '--tool-class', 'file_edit', '--tool', 'edit_file', '--ok', '1', '--project', e.projDir]);
    gate = dgOk(e, ['gate', '--route', 'file_select', '--tool-class', 'file_edit', '--project', e.projDir]);
    assert.equal(gate.forced_split, false, '동일 키 성공 → 키 카운터 리셋');

    // 세션 카운터: 대화 C1에서 2실패 → 신규 키(키 오류 0)도 세션 오류로 강제 split
    const C1 = 'conv-n7';
    for (let i = 0; i < 2; i++) {
      dgOk(e, ['record', '--route', 'tool_select', '--tool-class', 'code_search', '--tool', 'grep_search', '--ok', '0', '--conversation', C1, '--project', e.projDir]);
    }
    gate = dgOk(e, ['gate', '--route', 'tool_select', '--tool-class', 'shell_exec', '--conversation', C1, '--project', e.projDir]);
    assert.equal(gate.forced_split, true, '세션 카운터 >= 2 → 강제 split');
    assert.equal(gate.forced_reason, 'session_consec_err>=2');
    assert.equal(gate.consecutive_errors, 0, '해당 키 오류는 0 — 세션 카운터와 분리');

    // 타 대화 성공은 C1을 리셋하지 않는다
    dgOk(e, ['record', '--route', 'tool_select', '--tool-class', 'code_search', '--tool', 'grep_search', '--ok', '1', '--conversation', 'conv-other', '--project', e.projDir]);
    gate = dgOk(e, ['gate', '--route', 'tool_select', '--tool-class', 'shell_exec', '--conversation', C1, '--project', e.projDir]);
    assert.equal(gate.forced_split, true, '타 대화 성공 → C1 세션 카운터 유지(N7)');

    // 동일 대화 성공 → 세션 카운터 리셋
    dgOk(e, ['record', '--route', 'tool_select', '--tool-class', 'code_search', '--tool', 'grep_search', '--ok', '1', '--conversation', C1, '--project', e.projDir]);
    gate = dgOk(e, ['gate', '--route', 'tool_select', '--tool-class', 'shell_exec', '--conversation', C1, '--project', e.projDir]);
    assert.equal(gate.forced_split, false, '동일 대화 성공 → 세션 카운터 리셋');
    assert.equal(gate.session_consec_err, 0);
  } finally {
    cleanupEnv(e);
  }
});

test('5. 재시도 단일 귀속 불변식 (B7): retry_or_abort 1행 + 원 라우트 불변', () => {
  const e = makeEnv();
  try {
    const C = 'conv-b7';
    // step 10 실패
    dgOk(e, ['record', '--route', 'tool_select', '--tool-class', 'shell_exec', '--tool', 'run_command', '--ok', '0', '--conversation', C, '--step', '10', '--project', e.projDir]);
    // step 12 동일 tool_class 재호출 → 재시도로 판정
    const retry = dgOk(e, ['record', '--route', 'tool_select', '--tool-class', 'shell_exec', '--tool', 'run_command', '--ok', '1', '--conversation', C, '--step', '12', '--project', e.projDir]);
    assert.equal(retry.is_retry, true, '3스텝 이내 동일 클래스 재호출 → is_retry');
    assert.equal(retry.route, 'retry_or_abort');

    const orig = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE route='tool_select' AND tool_class='shell_exec'
         AND project_id = (SELECT project_id FROM decision_events WHERE is_retry = 1 LIMIT 1)`
    ) as { raw_samples: number } | undefined;
    assert.equal(orig?.raw_samples, 1, '원 라우트(tool_select/shell_exec) 표본 1건 불변');

    const retryRow = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE route='retry_or_abort' AND tool_class='shell_exec' AND project_id != ?`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number } | undefined;
    assert.equal(retryRow?.raw_samples, 1, 'retry_or_abort 단일 행 n += 1');

    const events = dgStat(
      e,
      `SELECT COUNT(*) AS n FROM decision_events WHERE conversation_id = ?`,
      C
    ) as { n: number };
    assert.equal(events.n, 2, '실행 2회 = 행 2행 (1회 실행 = 1행)');
    const retryEvent = dgStat(
      e,
      `SELECT route, is_retry FROM decision_events WHERE conversation_id = ? AND is_retry = 1`,
      C
    ) as { route: string; is_retry: number } | undefined;
    assert.equal(retryEvent?.route, 'retry_or_abort');
    assert.equal(retryEvent?.is_retry, 1);
  } finally {
    cleanupEnv(e);
  }
});

test('6. Fork 정상 닫힘 (B1): close ok → abandoned 0건 / rerouted → 통계 불변', () => {
  const e = makeEnv();
  try {
    const r1 = dgOk(e, ['route', '--task-kind', 'explore_read', '--project', e.projDir]);
    const fk1 = r1.fork_id as string;
    assert.match(fk1, /^fk_[0-9a-f]{12}$/);
    const closed = dgOk(e, ['close', '--fork', fk1, '--outcome', 'ok', '--by', 'dispatcher']);
    assert.equal(closed.status, 'ok');
    assert.equal(closed.recorded, true);

    const settled = dgOk(e, ['settle-orphans']);
    assert.equal(settled.settled, 0, '정상 닫힘 fork는 고아 정산 대상 아님');
    const abandoned = dgStat(e, `SELECT COUNT(*) AS n FROM forks WHERE status = 'abandoned'`) as { n: number };
    assert.equal(abandoned.n, 0);

    // rerouted: 통계 불변(표본 0건 추가) — §2.0
    const before = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE route='file_select' AND tool_class='file_read' AND project_id != ?`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number };
    const eventsBefore = dgStat(e, `SELECT COUNT(*) AS n FROM decision_events`) as { n: number };
    const r2 = dgOk(e, ['route', '--task-kind', 'explore_read', '--project', e.projDir]);
    const fk2 = r2.fork_id as string;
    const rerouted = dgOk(e, ['close', '--fork', fk2, '--outcome', 'rerouted', '--by', 'worker', '--reason', 'write required']);
    assert.equal(rerouted.status, 'rerouted');
    const after = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE route='file_select' AND tool_class='file_read' AND project_id != ?`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number };
    const eventsAfter = dgStat(e, `SELECT COUNT(*) AS n FROM decision_events`) as { n: number };
    assert.equal(after.raw_samples, before.raw_samples, 'rerouted 닫힘 → 원 표본 불변');
    assert.equal(eventsAfter.n, eventsBefore.n, 'rerouted 닫힘 → decision_events 추가 0건');
  } finally {
    cleanupEnv(e);
  }
});

test('7. touch 이후 미정산 (B1): TTL 기준 last_touch_ms / 무touch 경과 시 abandoned+EWMA 실패', async () => {
  const e = makeEnv();
  try {
    // (a) 결정론적 엔진 검증 — 주입 시계로 경계 조건 정확 확인
    const db = openDb(e.dbPath);
    const T0 = 1_000_000;
    const fkA = engine.issueFork(db, {
      projectId: 'pT', projectLabel: 'pT', route: 'tool_select', toolClass: 'code_search',
      decision: 'sharp', pAtGate: 0.9, basisAtGate: 'prior', forcedSplit: false, ttlMs: 500, nowMs: T0,
    });
    engine.touchFork(db, fkA, undefined, T0 + 300);
    let res = engine.settleOrphans(db, T0 + 700); // touch 경과 400ms < 500ms
    assert.equal(res.settled, 0, 'touch 갱신 시각 기준 미경과 → open 유지');
    assert.equal(engine.getFork(db, fkA)!.status, 'open');

    const fkB = engine.issueFork(db, {
      projectId: 'pT', projectLabel: 'pT', route: 'tool_select', toolClass: 'shell_exec',
      decision: 'split', pAtGate: 0.6, basisAtGate: 'prior', forcedSplit: false, ttlMs: 500, nowMs: T0,
    });
    res = engine.settleOrphans(db, T0 + 700); // 생성 경과 700ms > 500ms
    assert.equal(res.settled, 1);
    assert.equal(engine.getFork(db, fkB)!.status, 'abandoned');
    assert.equal(engine.getFork(db, fkB)!.closed_by, 'ttl');
    const orphanEvents = db
      .prepare(`SELECT ok, weight, source FROM decision_events WHERE fork_id = ?`)
      .all(fkB) as Array<{ ok: number; weight: number; source: string }>;
    assert.equal(orphanEvents.length, 1);
    assert.equal(orphanEvents[0]!.ok, 0, '고아 정산 → EWMA 실패 1건');
    assert.equal(orphanEvents[0]!.source, 'ttl_orphan');
    db.close();

    // (b) 실시간 CLI 시나리오 — 병렬 부하에서 Node 프로세스 기동 지연(~40-300ms)이
    //     sleep 구간에 더해져도 판정이 흔들리지 않도록 여유 폭을 충분히 확보한다.
    //     ① touch 갱신 → 미정산(open 유지): TTL 2000ms vs 경과 ~650ms+기동 — 마진 ~1350ms
    //     ② 무touch 짧은 TTL 만료 → abandoned: sleep 350ms > TTL 150ms — 기동 0ms여도 만료 보장
    const r = dgOk(e, ['route', '--task-kind', 'code_search', '--project', e.projDir]);
    const fk = r.fork_id as string;
    dgOk(e, ['touch', '--fork', fk, '--ttl-ms', '2000']);
    await sleep(300);
    dgOk(e, ['touch', '--fork', fk]);
    await sleep(350);
    const settled = dgOk(e, ['settle-orphans']);
    assert.equal(settled.settled, 0, `touch 직후 settle → 여전히 open (fork_ids=${JSON.stringify(settled.fork_ids)})`);
    const row = dgStat(e, `SELECT status FROM forks WHERE fork_id = ?`, fk) as { status: string };
    assert.equal(row.status, 'open');

    // 무 touch 짧은 TTL 경과 → abandoned (CLI 실시간 경로)
    dgOk(e, ['touch', '--fork', fk, '--ttl-ms', '150']);
    await sleep(350);
    const settled2 = dgOk(e, ['settle-orphans']);
    assert.equal(settled2.settled, 1, `TTL 150ms 무갱신 경과(≥350ms) → abandoned (fork_ids=${JSON.stringify(settled2.fork_ids)})`);
    const row2 = dgStat(e, `SELECT status, closed_by FROM forks WHERE fork_id = ?`, fk) as { status: string; closed_by: string };
    assert.equal(row2.status, 'abandoned');
    assert.equal(row2.closed_by, 'ttl');
  } finally {
    cleanupEnv(e);
  }
});

test('8. Neon backprop: ok fork → backprop_fail 전환 + p 하락', () => {
  const e = makeEnv();
  try {
    const r = dgOk(e, ['route', '--task-kind', 'explore_read', '--project', e.projDir]);
    const fk = r.fork_id as string;
    const closed = dgOk(e, ['close', '--fork', fk, '--outcome', 'ok', '--by', 'dispatcher']);
    const pBefore = closed.p_after as number;

    const bp = dgOk(e, ['backprop', '--fork', fk, '--penalty', '2.0', '--reason', 'verifier FAIL']);
    assert.equal(bp.status, 'backprop_fail');
    assert.equal(bp.neon_verdict, 'fail');
    assert.equal(bp.weight_applied, 2.0);
    assert.ok((bp.p_after as number) < pBefore, `p ${pBefore.toFixed(4)} → ${(bp.p_after as number).toFixed(4)} 하락`);

    const forkRow = dgStat(e, `SELECT status, closed_by, neon_verdict FROM forks WHERE fork_id = ?`, fk) as {
      status: string; closed_by: string; neon_verdict: string;
    };
    assert.equal(forkRow.status, 'backprop_fail');
    assert.equal(forkRow.closed_by, 'verifier');
    assert.equal(forkRow.neon_verdict, 'fail');
    const ev = dgStat(
      e,
      `SELECT weight, source FROM decision_events WHERE fork_id = ? AND source = 'neon_backprop'`,
      fk
    ) as { weight: number; source: string };
    assert.equal(ev.weight, 2.0);
  } finally {
    cleanupEnv(e);
  }
});

test('9. 프로젝트 격리 (Shrinkage λ<=0.25): A 20연패 후 B 콜드 p >= 0.70', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    for (let i = 0; i < 20; i++) {
      rec(db, 'projA', 'file_select', 'file_read', false);
    }
    const postB = engine.getPosterior(db, 'projB', 'file_select', 'file_read');
    assert.equal(postB.samples, 0, 'B 콜드스타트');
    assert.equal(postB.lambda, 0.25, '전역 풀 가중치 상한 λ_max=0.25');
    assert.ok(postB.p >= 0.7, `B의 p=${postB.p.toFixed(4)} >= 0.70 (의도: 0.75·0.94 + 0.25·p_glob)`);
    assert.equal(postB.basis, 'prior');
    // A 자체는 20연패 반영으로 급락
    const postA = engine.getPosterior(db, 'projA', 'file_select', 'file_read');
    assert.ok(postA.p < 0.7, `A p=${postA.p.toFixed(4)} < 0.70`);
    db.close();
  } finally {
    cleanupEnv(e);
  }
});

test('10. 자기 호출 제외 (B6): src/decision/dg.ts·dg-hook.ts 포함 명령 표본 0건', () => {
  const e = makeEnv();
  try {
    const db = openDb(e.dbPath);
    const r1 = rec(db, 'pSelf', 'tool_select', 'shell_exec', true, {
      toolName: 'run_command',
      commandLine: 'node ./src/decision/dg.ts route --task-kind explore_read',
    });
    assert.equal(r1.recorded, false);
    assert.equal(r1.reason, 'self-invocation');
    const r2 = rec(db, 'pSelf', 'tool_select', 'shell_exec', true, {
      toolName: 'run_command',
      commandLine: 'node .agents/hooks/dg-hook.ts --collect',
    });
    assert.equal(r2.recorded, false);
    db.close();

    // CLI 경로(--command)도 동일 제외
    const out = dgOk(e, [
      'record', '--route', 'tool_select', '--tool-class', 'shell_exec', '--tool', 'run_command',
      '--ok', '1', '--command', 'node src/decision/dg.ts gate --route tool_select',
      '--project', e.projDir,
    ]);
    assert.equal(out.recorded, false);
    assert.equal(out.reason, 'self-invocation');

    const row = dgStat(
      e,
      `SELECT COUNT(*) AS n FROM stats_summary WHERE route='tool_select' AND tool_class='shell_exec' AND project_id != ?`,
      GLOBAL_PROJECT_ID
    ) as { n: number };
    assert.equal(row.n, 0, '자기 호출 → 표본 0건 (로컬 행 미생성)');
    const globalRow = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id = ? AND route='tool_select' AND tool_class='shell_exec'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number } | undefined;
    assert.equal(globalRow?.raw_samples ?? 0, 0, '전역 풀도 미갱신');
  } finally {
    cleanupEnv(e);
  }
});

test('11. route 결정표: single_edit → split (sharp 거부) / explore_read → sharp + fork_id', () => {
  const e = makeEnv();
  try {
    const edit = dgOk(e, ['route', '--task-kind', 'single_edit', '--project', e.projDir]);
    assert.equal(edit.decision, 'split', 'requires_write=true → 구조적으로 sharp 배제');
    assert.equal(edit.requires_write, true);
    assert.equal(edit.route, 'file_select');
    assert.equal(edit.tool_class, 'file_edit');
    assert.match(edit.fork_id as string, /^fk_[0-9a-f]{12}$/);

    const explore = dgOk(e, ['route', '--task-kind', 'explore_read', '--project', e.projDir]);
    assert.equal(explore.decision, 'sharp', '콜드스타트 p0=0.94 ≥ 0.70, low risk, err<2 → sharp');
    assert.equal(explore.route, 'file_select');
    assert.equal(explore.tool_class, 'file_read');
    assert.equal(explore.risk_level, 'low');
    assert.equal(explore.ttl_ms, 600000);
    assert.match(explore.fork_id as string, /^fk_[0-9a-f]{12}$/);

    // task_kind 검증: 자유 문자열 거부 (exit 2)
    const bad = dg(e, ['route', '--task-kind', 'do_everything', '--project', e.projDir]);
    assert.equal(bad.status, 2);
    // static_check은 sharp 자격 없음 (verify-plan-r2.1 추가 관찰)
    const staticCheck = dgOk(e, ['route', '--task-kind', 'static_check', '--project', e.projDir]);
    assert.equal(staticCheck.decision, 'split', 'static_check sharpEligible=false');
  } finally {
    cleanupEnv(e);
  }
});

test('12. dg wrap: 종료코드 자동 기록 + fork 자동 닫힘 (exit 0 / exit 1)', () => {
  const e = makeEnv();
  try {
    const okRes = dg(e, [
      'wrap', '--route', 'tool_select', '--tool-class', 'code_search', '--project', e.projDir,
      '--', 'node', '-e', 'process.exit(0)',
    ]);
    assert.equal(okRes.status, 0, 'wrap exit 코드 패스스루(0)');
    const okSummary = JSON.parse((okRes.stderr.trim().split('\n').pop())!) as Record<string, unknown>;
    assert.equal(okSummary.ok, 1);
    assert.equal(okSummary.exit_code, 0);
    assert.equal(okSummary.recorded, true);
    assert.equal(okSummary.closed, true);
    assert.match(okSummary.fork_id as string, /^fk_[0-9a-f]{12}$/);

    const failRes = dg(e, [
      'wrap', '--route', 'tool_select', '--tool-class', 'code_search', '--project', e.projDir,
      '--', 'node', '-e', 'process.exit(1)',
    ]);
    assert.equal(failRes.status, 1, 'wrap exit 코드 패스스루(1)');
    const failSummary = JSON.parse((failRes.stderr.trim().split('\n').pop())!) as Record<string, unknown>;
    assert.equal(failSummary.ok, 0);
    assert.equal(failSummary.exit_code, 1);
    assert.equal(failSummary.recorded, true);
    assert.equal(failSummary.closed, true);

    const statuses = openDb(e.dbPath, { readOnly: true, busyTimeoutMs: 1000 });
    try {
      const rows = statuses
        .prepare(`SELECT status, closed_by FROM forks ORDER BY created_at_ms`)
        .all() as Array<{ status: string; closed_by: string }>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.status, 'ok');
      assert.equal(rows[0]!.closed_by, 'worker');
      assert.equal(rows[1]!.status, 'fail');
      const evCount = statuses
        .prepare(`SELECT COUNT(*) AS n FROM decision_events WHERE source = 'wrap'`)
        .get() as { n: number };
      assert.equal(evCount.n, 2, 'wrap 표본 2건 (source=wrap)');
    } finally {
      statuses.close();
    }
  } finally {
    cleanupEnv(e);
  }
});

test('13. WAL 동시성: 8자식 × 20회 동시 record = 160/160 무손실·BUSY 0건', async () => {
  const e = makeEnv();
  try {
    const children: Array<{ status: number | null; stdout: string; stderr: string }> = [];
    // 20라운드 × 8동시 (비동기 spawn — 동시 writer 8 — §0 실측 재현)
    for (let round = 0; round < 20; round++) {
      const batch = await Promise.all(
        Array.from({ length: 8 }, () =>
          dgAsync(e, [
            'record', '--route', 'tool_select', '--tool-class', 'shell_exec', '--tool', 'run_command',
            '--ok', '1', '--project', e.projDir, '--json',
          ])
        )
      );
      children.push(...batch);
    }
    for (const [i, c] of children.entries()) {
      assert.equal(c.status, 0, `child ${i} exit=${c.status} stderr=${c.stderr}`);
      assert.ok(!c.stderr.includes('SQLITE_BUSY'), `child ${i} SQLITE_BUSY: ${c.stderr}`);
      const out = JSON.parse((c.stdout.trim().split('\n').pop())!) as Record<string, unknown>;
      assert.equal(out.recorded, true, `child ${i} recorded (fallback 여부: ${JSON.stringify(out)})`);
      assert.equal(out.fallback, undefined, `child ${i} 폴백 아님`);
    }
    const events = dgStat(e, `SELECT COUNT(*) AS n FROM decision_events`) as { n: number };
    assert.equal(events.n, 160, '160/160 무손실');
    const stats = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE route='tool_select' AND tool_class='shell_exec' AND project_id != ?`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number };
    assert.equal(stats.raw_samples, 160);
    const globalStats = dgStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id = ? AND route='tool_select' AND tool_class='shell_exec'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number };
    assert.equal(globalStats.raw_samples, 160, '전역 풀 병행 갱신 160/160');
  } finally {
    cleanupEnv(e);
  }
});

test('14. cli.ts --snapshot 정상 exit 0 + quadBus 원자적 쓰기·동일 페이로드 스킵', async () => {
  // (a) 스냅샷 회귀 (선행 버그 1·4 수정 후에도 데모 렌더 정상)
  const snapEnv = { ...process.env } as NodeJS.ProcessEnv;
  delete snapEnv.GEMINI_TRICK_DB_PATH;
  const snap = spawnSync(
    process.execPath,
    [CLI_PATH, '--snapshot', '--time', '10', '--cols', '148', '--rows', '43'],
    { cwd: REPO_ROOT, env: snapEnv, encoding: 'utf8' }
  );
  assert.equal(snap.status, 0, `snapshot exit=${snap.status} stderr=${snap.stderr}`);
  assert.ok(snap.stdout.length > 1000, '스냅샷 프레임 출력 존재');

  // (b) quadBus 원자적 쓰기 (선행 버그 #4)
  const { QuadBusServer, QUAD_STATE_FILE } = await import('../src/ipc/quadBus.ts');
  const tmpDir = os.tmpdir();
  const tmpPrefix = path.basename(QUAD_STATE_FILE) + '.tmp.';
  const cleanTmp = () => {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(tmpPrefix)) fs.rmSync(path.join(tmpDir, f), { force: true });
    }
  };
  cleanTmp();
  try {
    const server = new QuadBusServer(() => {});
    const stateA = { mode: 'demo', simTime: 1, marker: 'A' };
    const stateB = { mode: 'demo', simTime: 2, marker: 'B' };
    server.broadcast({ type: 'state', state: stateA });
    assert.ok(fs.existsSync(QUAD_STATE_FILE), '상태 파일 기록');
    assert.equal(JSON.parse(fs.readFileSync(QUAD_STATE_FILE, 'utf8')).marker, 'A');
    const written1 = fs.statSync(QUAD_STATE_FILE);

    await sleep(20);
    server.broadcast({ type: 'state', state: { ...stateA } }); // 동일 페이로드 → 스킵
    await sleep(20);
    const written2 = fs.statSync(QUAD_STATE_FILE);
    assert.equal(JSON.parse(fs.readFileSync(QUAD_STATE_FILE, 'utf8')).marker, 'A', '동일 페이로드 스킵');
    assert.equal(written2.mtimeMs, written1.mtimeMs, '동일 페이로드 → 파일 미기록');

    server.broadcast({ type: 'state', state: stateB }); // 250ms 이내 → 쓰로틀
    await sleep(20);
    assert.equal(JSON.parse(fs.readFileSync(QUAD_STATE_FILE, 'utf8')).marker, 'A', '250ms 쓰로틀 내 변경 스킵');

    await sleep(300);
    server.broadcast({ type: 'state', state: stateB }); // 쓰로틀 경과 → 기록
    await sleep(20);
    assert.equal(JSON.parse(fs.readFileSync(QUAD_STATE_FILE, 'utf8')).marker, 'B', '쓰로틀 경과 후 원자적 기록');

    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.startsWith(tmpPrefix));
    assert.deepEqual(leftovers, [], '원자적 rename — .tmp 잔존 0건');
    server.close();
  } finally {
    cleanTmp();
    try {
      fs.rmSync(QUAD_STATE_FILE, { force: true });
    } catch {
      /* 무시 */
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
