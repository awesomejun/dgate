/**
 * PB-2.5 테스트 매트릭스 (brief-pbwire §3.4): `dg.ts` CLI 4종 배선 종단 검증.
 *
 * ① `dg stats --cost --timing --json` — v2 DB 정상 집계 + v1 DB(`intervals_unavailable`)
 *    안전 반환, 양쪽 모두 읽기전용 실행 → DB 파일 sha256 불변
 * ② `dg checkpoint create/verify/restore` — CLI 왕복 + 변조 시 verify exit 1
 * ③ `dg worktree remove` — 체크포인트 저장 실패 시 **exit 4** + 워크트리 보존,
 *    정상 검증 통과 시 exit 0 + 워크트리 삭제 (safeRemoveWorktree 단일 진입)
 * ④ `dg report --out` — 저장소 내부 경로(src/·.agents/) **exit 2** + 파일 미생성,
 *    `.herdr/report/` 허용 → exit 0 + DB 불변
 * ⑤ `dg route --roster <roster.example.json> --profile claude-hybrid` — 동적
 *    θ_sharp ≈ 0.7692 노출 + 미지정 시 기존 0.70 회귀 없음
 *
 * 실행: `node --test tests/phaseb-cli-e2e.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateV1Tables, openDb } from '../src/decision/db.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');
const ROSTER_EXAMPLE = path.join(REPO_ROOT, '.herdr', 'roster.example.json');
/** --db 미지정 호출에 대한 격리용 더미 경로 (어떤 테스트도 여기에 쓰지 않는다) */
const UNUSED_DB = path.join(os.tmpdir(), `dg-pbe2e-unused-${process.pid}.db`);

function mkBase(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-`));
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface DgResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function dg(args: string[], env?: NodeJS.ProcessEnv): DgResult {
  const res = spawnSync(process.execPath, [DG_PATH, ...args], {
    env: env ?? { ...process.env, GEMINI_TRICK_DB_PATH: UNUSED_DB, DGATE_DB_PATH: undefined, DECISION_ORCHESTRATOR_DB_PATH: undefined },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** exit 0 + 마지막 stdout 줄을 JSON으로 파싱 */
function dgJson(args: string[], env?: NodeJS.ProcessEnv): Record<string, unknown> {
  const r = dg([...args, '--json'], env);
  assert.equal(r.status, 0, `dg ${args.join(' ')} exit=${r.status} stderr=${r.stderr}`);
  const last = r.stdout.trim().split('\n').pop()!;
  return JSON.parse(last) as Record<string, unknown>;
}

/** 비정상 종료 예상 호출 — exit code + 마지막 stdout 줄 JSON 반환 */
function dgCode(args: string[], env?: NodeJS.ProcessEnv): { r: DgResult; parsed: Record<string, unknown> | null } {
  const r = dg([...args, '--json'], env);
  let parsed: Record<string, unknown> | null = null;
  const last = r.stdout.trim().split('\n').pop();
  if (last) {
    try {
      parsed = JSON.parse(last) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { r, parsed };
}

function git(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

function initRepo(base: string): string {
  const repo = path.join(base, 'repo');
  const noHooks = path.join(base, 'nohooks');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(noHooks, { recursive: true });
  gitOk(repo, ['init', '-q']);
  gitOk(repo, ['config', 'user.email', 'pbe2e@example.com']);
  gitOk(repo, ['config', 'user.name', 'pbe2e-test']);
  gitOk(repo, ['config', 'commit.gpgsign', 'false']);
  gitOk(repo, ['config', 'core.hooksPath', noHooks]);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'v0\n');
  fs.writeFileSync(path.join(repo, 'tracked.md'), '# hello\n');
  gitOk(repo, ['add', '-A']);
  gitOk(repo, ['commit', '-qm', 'init']);
  return repo;
}

/** staged(base.txt→v2-idx) + unstaged(→v2-wt) + untracked(초안/심볼릭 링크) dirty 워크트리 */
function addWorktreeWithDirtyState(repo: string, wtName: string): string {
  const wt = path.join(path.dirname(repo), wtName);
  gitOk(repo, ['worktree', 'add', '-b', wtName, wt]);
  fs.writeFileSync(path.join(wt, 'base.txt'), 'v2-idx\n');
  gitOk(wt, ['add', 'base.txt']);
  fs.writeFileSync(path.join(wt, 'base.txt'), 'v2-wt\n');
  fs.mkdirSync(path.join(wt, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'notes', 'draft.txt'), 'draft-초안\n');
  fs.symlinkSync('notes/draft.txt', path.join(wt, 'link.txt'));
  return wt;
}

// ---------------------------------------------------------------------------

test('① dg stats — v2 정상 집계 / v1 안전 반환 / 양쪽 DB sha256 불변 + --db 우선', () => {
  const base = mkBase('pbe2e-stats');
  const now = Date.now();
  try {
    // ---------- v2 DB: 비용 컬럼 + fork_intervals ----------
    const v2Path = path.join(base, 'v2.db');
    {
      const db = openDb(v2Path);
      try {
        db.prepare(
          `INSERT INTO decision_events
             (project_id, source, route, tool_name, tool_class, ok, created_at_ms,
              input_tokens, output_tokens, cost_usd, cost_status)
           VALUES ('p1', 'wrap', 'tool_select', 'run_command', 'shell_exec', 1, ?, 1000, 500, 0.5, 'reported'),
                  ('p1', 'wrap', 'tool_select', 'run_command', 'shell_exec', 0, ?, 2000, 800, NULL, 'unknown')`
        ).run(now - 1000, now - 900);
        db.prepare(
          `INSERT INTO forks
             (fork_id, project_id, project_label, route, tool_class, decision, forced_split,
              p_at_gate, basis_at_gate, generation, attempt, status, ttl_ms, created_at_ms, last_touch_ms)
           VALUES ('f1', 'p1', 'p1', 'tool_select', 'shell_exec', 'sharp', 0, 0.8, 'prior', 1, 1, 'open', 600000, ?, ?)`
        ).run(now - 500, now - 400);
        db.prepare(
          `INSERT INTO fork_intervals (fork_id, attempt, phase, started_at_ms, ended_at_ms)
           VALUES ('f1', 1, 'exec', ?, ?), ('f1', 1, 'wait', ?, ?)`
        ).run(now - 500, now - 400, now - 400, now - 100);
      } finally {
        db.close();
      }
    }
    const v2Hash = sha256File(v2Path);
    const r2 = dgJson(['stats', '--cost', '--timing', '--db', v2Path]);
    assert.equal(r2.cmd, 'stats');
    const cost2 = r2.cost as { schema_v1: boolean; total_events: number; unknown_events: number; total_usd_display: number | null };
    assert.equal(cost2.schema_v1, false);
    assert.equal(cost2.total_events, 2);
    assert.equal(cost2.unknown_events, 1);
    assert.equal(cost2.total_usd_display, null, 'unknown 존재 → 총액 표시 금지 (C-1)');
    const timing2 = r2.timing as { intervals_unavailable: boolean; execution_ms: number; wait_ms: number };
    assert.equal(timing2.intervals_unavailable, false);
    assert.equal(timing2.execution_ms, 100, 'exec [now-500, now-400] = 100ms');
    assert.equal(timing2.wait_ms, 300, 'wait [now-400, now-100] = 300ms');
    assert.equal(sha256File(v2Path), v2Hash, 'v2 DB 파일 해시 불변 (읽기전용)');

    // ---------- v1 DB: cost_status·fork_intervals 부재 → 안전 반환 ----------
    const v1Path = path.join(base, 'v1.db');
    {
      const raw = new DatabaseSync(v1Path);
      migrateV1Tables(raw);
      raw.prepare(
        `INSERT INTO decision_events (project_id, source, route, tool_name, tool_class, ok, created_at_ms)
         VALUES ('p1', 'cli', 'tool_select', 'x', 'shell_exec', 1, ?), ('p1', 'cli', 'tool_select', 'y', 'shell_exec', 0, ?)`
      ).run(now - 100, now - 90);
      raw.close();
    }
    const v1Hash = sha256File(v1Path);
    const r1 = dgJson(['stats', '--cost', '--timing', '--db', v1Path]);
    const cost1 = r1.cost as { schema_v1: boolean; total_events: number; unknown_events: number };
    assert.equal(cost1.schema_v1, true, 'v1 DB → schema_v1 마커');
    assert.equal(cost1.total_events, 2);
    assert.equal(cost1.unknown_events, 2, 'v1은 전 건 unknown');
    const timing1 = r1.timing as { intervals_unavailable: boolean; execution_ms: number };
    assert.equal(timing1.intervals_unavailable, true, 'v1 → intervals_unavailable: true');
    assert.equal(timing1.execution_ms, 0);
    assert.equal(sha256File(v1Path), v1Hash, 'v1 DB 파일 해시 불변 (읽기전용)');

    // ---------- 플래그 선택: --cost 단독 / --timing 단독 ----------
    const rCostOnly = dgJson(['stats', '--cost', '--db', v2Path]);
    assert.ok(rCostOnly.cost !== null);
    assert.equal(rCostOnly.timing, null, '--cost 단독 시 timing 미포함');
    const rTimingOnly = dgJson(['stats', '--timing', '--db', v2Path]);
    assert.ok(rTimingOnly.timing !== null);
    assert.equal(rTimingOnly.cost, null, '--timing 단독 시 cost 미포함');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('② dg checkpoint create/verify/restore CLI 왕복 + 변조 시 verify exit 1', () => {
  const base = mkBase('pbe2e-ckpt');
  try {
    const repo = initRepo(base);
    const wt = addWorktreeWithDirtyState(repo, 'coder-cli');
    const ckptRoot = path.join(base, 'ckpt');

    const created = dgJson([
      'checkpoint', 'create',
      '--worktree', wt,
      '--run-id', 'run-cli',
      '--repo', repo,
      '--checkpoint-root', ckptRoot,
    ]);
    assert.equal(created.saved, true, `create failed: ${JSON.stringify(created.errors)}`);
    const ckptDir = created.checkpoint_dir as string;
    assert.equal(ckptDir, path.join(ckptRoot, 'run-cli', 'coder-cli'));

    const verified = dgJson(['checkpoint', 'verify', '--dir', ckptDir]);
    assert.equal(verified.valid, true, `verify failed: ${JSON.stringify(verified.errors)}`);

    const target = path.join(base, 'restore-wt');
    gitOk(repo, ['worktree', 'add', '-b', 'restore-wt', target]);
    const restored = dgJson(['checkpoint', 'restore', '--dir', ckptDir, '--target', target]);
    assert.equal(restored.restored, true, `restore failed: ${JSON.stringify(restored.errors)}`);
    assert.equal(fs.readFileSync(path.join(target, 'base.txt'), 'utf8'), 'v2-wt\n', 'unstaged 내용 복원');
    assert.equal(fs.readFileSync(path.join(target, 'notes', 'draft.txt'), 'utf8'), 'draft-초안\n', 'untracked 복원');
    assert.equal(fs.readlinkSync(path.join(target, 'link.txt')), 'notes/draft.txt', '심볼릭 링크 복원');

    // 1바이트 변조 → verify exit 1
    fs.appendFileSync(path.join(ckptDir, 'index.patch'), 'X');
    const bad = dgCode(['checkpoint', 'verify', '--dir', ckptDir]);
    assert.equal(bad.r.status, 1, `변조 체크포인트 verify는 exit 1 (got ${bad.r.status})`);
    assert.equal(bad.parsed?.valid, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('③ dg worktree remove — 체크포인트 실패 시 exit 4 + 워크트리 보존 / 정상 시 exit 0 + 삭제', () => {
  const base = mkBase('pbe2e-rm');
  try {
    const repo = initRepo(base);
    const wt = addWorktreeWithDirtyState(repo, 'coder-rm');
    const ckptRoot = path.join(base, 'ckpt-ro');
    fs.mkdirSync(ckptRoot, { recursive: true });

    // (a) 읽기전용 checkpointRoot → 저장 실패 → exit 4 + 워크트리 보존
    fs.chmodSync(ckptRoot, 0o500);
    const denied = dgCode([
      'worktree', 'remove',
      '--worktree', wt,
      '--repo', repo,
      '--run-id', 'rm-fail',
      '--checkpoint-root', ckptRoot,
    ]);
    assert.equal(denied.r.status, 4, `게이트 거부는 exit 4 (got ${denied.r.status}, stderr=${denied.r.stderr})`);
    assert.equal(denied.parsed?.removed, false);
    assert.equal(denied.parsed?.exit_code, 4);
    assert.ok(fs.existsSync(path.join(wt, 'base.txt')), '워크트리 보존');
    assert.ok(fs.existsSync(path.join(wt, 'notes', 'draft.txt')), 'untracked 파일 보존');
    fs.chmodSync(ckptRoot, 0o755);

    // (b) 정상 체크포인트 통과 → exit 0 + 워크트리 삭제 + 체크포인트 보존
    const removed = dgCode([
      'worktree', 'remove',
      '--worktree', wt,
      '--repo', repo,
      '--run-id', 'rm-ok',
      '--checkpoint-root', ckptRoot,
      '--force',
    ]);
    assert.equal(removed.r.status, 0, `정상 삭제는 exit 0 (got ${removed.r.status}, stderr=${removed.r.stderr})`);
    assert.equal(removed.parsed?.removed, true);
    assert.equal(removed.parsed?.exit_code, 0);
    assert.ok(!fs.existsSync(wt), '워크트리 삭제됨');
    const ckptDir = removed.parsed?.checkpoint_dir as string;
    assert.ok(ckptDir && fs.existsSync(ckptDir), '삭제 후에도 체크포인트는 보존(복구 가능)');
    const list = gitOk(repo, ['worktree', 'list', '--porcelain']);
    assert.ok(!list.includes(wt), 'git worktree list에서 제거');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('④ dg report --out — src/·.agents/ 거부 exit 2 + 파일 미생성 / .herdr/report 허용 + DB 불변', () => {
  const base = mkBase('pbe2e-report');
  const now = Date.now();
  try {
    const repo = path.join(base, 'repo');
    for (const d of ['src', '.agents', '.herdr/report']) {
      fs.mkdirSync(path.join(repo, d), { recursive: true });
    }
    const dbPath = path.join(base, 'rpt.db');
    {
      const db = openDb(dbPath);
      try {
        db.prepare(
          `INSERT INTO decision_events (project_id, source, route, tool_name, tool_class, ok, created_at_ms)
           VALUES ('p1', 'wrap', 'tool_select', 'run_command', 'shell_exec', 0, ?)`
        ).run(now - 100);
      } finally {
        db.close();
      }
    }
    const dbHash = sha256File(dbPath);

    // 거부: src/ · .agents/ 내부 → exit 2 + 파일 미생성 (부모 디렉터리도 미생성)
    for (const denied of [path.join(repo, 'src', 'evil.md'), path.join(repo, '.agents', 'evil.md')]) {
      const r = dg(['report', '--db', dbPath, '--repo', repo, '--out', denied, '--json']);
      assert.equal(r.status, 2, `거부 경로 ${denied} → exit 2 (got ${r.status}, stderr=${r.stderr})`);
      assert.ok(r.stderr.includes('refused') || r.stderr.includes('forbidden'), `stderr 오류 명시: ${r.stderr}`);
      assert.ok(!fs.existsSync(denied), `거부 경로 파일 미생성: ${denied}`);
    }

    // 허용: <repo>/.herdr/report/r.md → exit 0 + 파일 존재 + DB 불변
    const ok = dgJson(['report', '--db', dbPath, '--repo', repo, '--out', path.join(repo, '.herdr', 'report', 'r.md')]);
    assert.equal(ok.written, true);
    const outFile = path.join(repo, '.herdr', 'report', 'r.md');
    assert.ok(fs.existsSync(outFile), '허용 경로 리포트 생성');
    assert.ok(fs.readFileSync(outFile, 'utf8').includes('자동 적용 금지'), '마크다운 본문 기록');
    assert.equal(sha256File(dbPath), dbHash, 'report 실행 전후 DB 파일 해시 불변');

    // --out 미지정 + --json → 구조화 리포트 stdout
    const noOut = dgJson(['report', '--db', dbPath, '--repo', repo]);
    assert.equal(noOut.cmd, 'report');
    assert.equal(noOut.written, false);
    const rep = noOut.report as { command: string; schema_version: number };
    assert.equal(rep.command, 'report');
    assert.equal(rep.schema_version, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('⑤ dg route --roster/--profile → 동적 θ_sharp ≈ 0.7692 / 미지정 시 0.70 유지', () => {
  const base = mkBase('pbe2e-theta');
  try {
    const env = { ...process.env, GEMINI_TRICK_DB_PATH: path.join(base, 'rt.db'), DGATE_DB_PATH: undefined, DECISION_ORCHESTRATOR_DB_PATH: undefined };
    const r = dgJson(
      ['route', '--task-kind', 'explore_read', '--roster', ROSTER_EXAMPLE, '--profile', 'claude-hybrid'],
      env
    );
    const theta = r.sharp_threshold as number;
    assert.ok(Math.abs(theta - 0.7692) < 1e-3, `claude-hybrid θ=${theta} ≈ 0.7692 ((3.5+1.5)/(5.0+1.5))`);
    assert.equal(r.task_kind, 'explore_read');

    // roster/profile 미지정 → 기존 0.70 상수 경로 그대로 (기존 테스트 무파괴)
    const def = dgJson(['route', '--task-kind', 'explore_read'], env);
    assert.equal(def.sharp_threshold, 0.7, '기본 θ=0.70 유지');

    // gate에도 동일하게 적용
    const g = dgJson(
      ['gate', '--route', 'file_select', '--tool-class', 'file_read', '--roster', ROSTER_EXAMPLE, '--profile', 'claude-hybrid'],
      env
    );
    assert.ok(Math.abs((g.sharp_threshold as number) - 0.7692) < 1e-3, `gate θ=${g.sharp_threshold} ≈ 0.7692`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
