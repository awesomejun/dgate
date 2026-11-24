/**
 * Change ①·③ — 디스패처 `--brief-file` 브리프 게이트·`--after <fork_id>` fork 의존성 검증.
 *
 * 실행: `node --test tests/dispatch-brief.test.ts`
 * 주의: CLI E2E는 `XDG_STATE_HOME`을 임시 경로로 격리한다 — 머신 전역 dispatch-mode
 * (strict 포함)·전역 roster(XDG_CONFIG_HOME)와 무관하게 동작한다(전역 상태 파일 무변경).
 * TS·Rust 동일 규칙: Rust 대응은 `crates/dgate-cli/src/commands/dispatch.rs` 단위 테스트와
 * `crates/dgate-cli/tests/cli_e2e.rs`가 담당한다.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planDispatch, validateBriefFileBytes, validateBriefText } from '../scripts/dispatch.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH_PATH = path.join(REPO_ROOT, 'scripts', 'dispatch.ts');
const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');

const VALID_BRIEF = [
  '# Verifier Brief — fk_test',
  '',
  '- fork_id: fk_test',
  '- 원래 요구사항: 테스트',
  '- diff 경로: git diff main...HEAD',
  '- 테스트 명령과 결과: node --test tests/ → pass',
  '',
  '## Standards',
  '',
  '- 위반 없음',
  '',
  '## Spec',
  '',
  '- 요구사항 충족',
  '',
  '## Merge Danger',
  '',
  'door: two-way',
  'blast_radius: 테스트 경로 전반',
  '',
].join('\n');

interface E2eEnv {
  base: string;
  dbPath: string;
  projDir: string;
  xstateOff: string;
  xstateStrict: string;
  envOff: NodeJS.ProcessEnv;
  envStrict: NodeJS.ProcessEnv;
}

function makeE2eEnv(): E2eEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dgbrief-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const projDir = path.join(base, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  // XDG 격리 — 상태(dispatch-mode)·설정(전역 roster) 모두 임시 경로
  const xstateOff = path.join(base, 'xstate-off'); // 부재 → off
  const xstateStrict = path.join(base, 'xstate-strict');
  fs.mkdirSync(path.join(xstateStrict, 'dgate'), { recursive: true });
  fs.writeFileSync(path.join(xstateStrict, 'dgate', 'dispatch-mode'), 'strict\n', 'utf8');
  const common = {
    ...process.env,
    GEMINI_TRICK_DB_PATH: dbPath,
    DGATE_DB_PATH: undefined,
    DECISION_ORCHESTRATOR_DB_PATH: undefined,
    HERDR_ROSTER_PATH: undefined,
    XDG_CONFIG_HOME: path.join(base, 'xconfig'),
  };
  return {
    base,
    dbPath,
    projDir,
    xstateOff,
    xstateStrict,
    envOff: { ...common, XDG_STATE_HOME: xstateOff },
    envStrict: { ...common, XDG_STATE_HOME: xstateStrict },
  };
}

function dispatchRun(env: NodeJS.ProcessEnv, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [DISPATCH_PATH, ...args], { env, encoding: 'utf8' });
}

function dgRun(env: NodeJS.ProcessEnv, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [DG_PATH, ...args], { env, encoding: 'utf8' });
}

function lastJson<T>(res: ReturnType<typeof spawnSync>): T {
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as T;
}

function writeBrief(base: string, name: string, text: string): string {
  const p = path.join(base, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// 검증기(순수 함수) — TS `validateBriefText`·`validateBriefFileBytes`
// ---------------------------------------------------------------------------

test('검증기: 유효 브리프는 위반 0건', () => {
  assert.deepEqual(validateBriefText(VALID_BRIEF), []);
  assert.deepEqual(validateBriefFileBytes(Buffer.from(VALID_BRIEF, 'utf8')), []);
  // CRLF 허용(행 끝 \r 정규화)
  assert.deepEqual(validateBriefText(VALID_BRIEF.replace(/\n/g, '\r\n')), []);
});

test('검증기: ## Spec 헤딩 누락 → 위반 1건', () => {
  const v = validateBriefText(VALID_BRIEF.replace('## Spec\n', ''));
  assert.equal(v.length, 1);
  assert.match(v[0]!, /## Spec/);
});

test('검증기: door 무효 → 위반', () => {
  const v = validateBriefText(VALID_BRIEF.replace('door: two-way', 'door: maybe'));
  assert.equal(v.length, 1);
  assert.match(v[0]!, /door/);
});

test('검증기: blast_radius 빈값 → 위반 / 500자 초과 → 위반', () => {
  const empty = validateBriefText(VALID_BRIEF.replace('blast_radius: 테스트 경로 전반', 'blast_radius:   '));
  assert.equal(empty.length, 1);
  assert.match(empty[0]!, /blast_radius/);
  const long = validateBriefText(
    VALID_BRIEF.replace('blast_radius: 테스트 경로 전반', `blast_radius: ${'x'.repeat(501)}`)
  );
  assert.equal(long.length, 1);
  assert.match(long[0]!, /500자/);
});

test('검증기: 64KB 초과 → 크기 위반 / 무효 UTF-8 → 인코딩 위반', () => {
  const big = Buffer.alloc(64 * 1024 + 1, 0x61);
  assert.equal(validateBriefFileBytes(big).length, 1);
  assert.match(validateBriefFileBytes(big)[0]!, /64KB/);
  const badUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.deepEqual(validateBriefFileBytes(badUtf8), ['유효한 UTF-8 아님']);
});

// ---------------------------------------------------------------------------
// CLI 게이트(Change ①) — strict/off 배선, XDG_STATE_HOME 격리
// ---------------------------------------------------------------------------

test('게이트: strict + --brief-file 부재 → exit 2(fail-closed) / off + 부재 → 정상 진행', () => {
  const e = makeE2eEnv();
  try {
    const strict = dispatchRun(e.envStrict, ['--task-kind', 'explore_read', '--repo', e.projDir, '--dry-run']);
    assert.equal(strict.status, 2, `strict 부재 → exit 2: ${strict.stderr}\n${strict.stdout}`);
    assert.match(strict.stderr, /strict 모드: --brief-file 필수/);

    const off = dispatchRun(e.envOff, ['--task-kind', 'explore_read', '--repo', e.projDir, '--dry-run', '--json']);
    assert.equal(off.status, 0, `off 부재 → exit 0: ${off.stderr}\n${off.stdout}`);
    assert.equal(lastJson<{ ok: boolean }>(off).ok, true);
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('게이트: 무효 브리프 → off·strict 양 모드 exit 2 + 위반 나열', () => {
  const e = makeE2eEnv();
  try {
    const bad = writeBrief(e.base, 'bad-brief.md', 'no headings here\n');
    for (const [label, env] of [['off', e.envOff], ['strict', e.envStrict]] as const) {
      const res = dispatchRun(env, ['--task-kind', 'explore_read', '--repo', e.projDir, '--dry-run', '--brief-file', bad]);
      assert.equal(res.status, 2, `${label} 무효 브리프 → exit 2: ${res.stderr}\n${res.stdout}`);
      assert.match(res.stderr, /## Standards 헤딩 없음/);
      assert.match(res.stderr, /blast_radius/);
    }
    // 읽기 불가(부재 파일)도 exit 2 — 명시적 입력은 반드시 유효해야 한다
    const missing = dispatchRun(e.envOff, [
      '--task-kind', 'explore_read', '--repo', e.projDir, '--dry-run',
      '--brief-file', path.join(e.base, 'nope.md'),
    ]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /읽기 실패/);
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('게이트: 유효 브리프 → 워커 커맨드 프롬프트에 {brief}=경로 문장 주입(sharp·split)', () => {
  const e = makeE2eEnv();
  try {
    const brief = writeBrief(e.base, 'ok-brief.md', VALID_BRIEF);
    // split 경로(리드) — risk 강제 승격으로 확정
    const split = dispatchRun(e.envStrict, [
      '--task-kind', 'single_edit', '--repo', e.projDir, '--dry-run', '--json', '--brief-file', brief,
    ]);
    assert.equal(split.status, 0, `strict 유효 브리프 → exit 0: ${split.stderr}\n${split.stdout}`);
    const splitPlan = lastJson<{ decision: string; hcCommands: string[][] }>(split);
    assert.equal(splitPlan.decision, 'split');
    const leadCmd = splitPlan.hcCommands[0]!.join(' ');
    assert.match(leadCmd, /브리프 파일을 먼저 읽고 두 축\(Standards\/Spec\)과 Merge Danger을 따르라: /);
    assert.ok(leadCmd.includes(brief), '주입된 문장은 브리프 경로로 치환된다');
    assert.ok(!leadCmd.includes('{brief}'), '{brief} 플레이스홀더는 잔존하지 않는다');
    // sharp 경로(탐색) — explore_read + low risk + prior p≥θ_sharp
    const sharp = dispatchRun(e.envOff, [
      '--task-kind', 'explore_read', '--repo', e.projDir, '--dry-run', '--json', '--brief-file', brief,
    ]);
    const sharpPlan = lastJson<{ decision: string; hcCommands: string[][] }>(sharp);
    assert.equal(sharp.status, 0, sharp.stderr);
    assert.equal(sharpPlan.decision, 'sharp');
    assert.ok(sharpPlan.hcCommands[0]!.join(' ').includes(brief));
    // 브리프 없으면 문장 없음(기존 프롬프트와 동일)
    const plain = dispatchRun(e.envOff, ['--task-kind', 'single_edit', '--repo', e.projDir, '--dry-run', '--json']);
    const plainPlan = lastJson<{ hcCommands: string[][] }>(plain);
    assert.ok(!plainPlan.hcCommands[0]!.join(' ').includes('브리프 파일을'));
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --after <fork_id>(Change ③) — ready-frontier
// ---------------------------------------------------------------------------

interface ForkRow {
  fork_id: string;
  status: string;
  metadata_json: string | null;
}

function forkRows(dbPath: string): ForkRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT fork_id, status, metadata_json FROM forks ORDER BY created_at_ms').all() as ForkRow[];
  } finally {
    db.close();
  }
}

test('--after: fork 미발견 → ok:false exit 2', () => {
  const e = makeE2eEnv();
  try {
    const res = dispatchRun(e.envOff, [
      '--task-kind', 'single_edit', '--repo', e.projDir, '--dry-run', '--db', e.dbPath, '--after', 'fk_nope', '--json',
    ]);
    assert.equal(res.status, 2, res.stderr);
    const plan = lastJson<{ ok: boolean; reason: string | null }>(res);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, '--after fork not found: fk_nope');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('--after: 살아 있는 fork(open) → deferred + reason, fork 미발행·커맨드 0', () => {
  const e = makeE2eEnv();
  try {
    const gate = dgRun(e.envOff, ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--json']);
    assert.equal(gate.status, 0, gate.stderr);
    const fk = lastJson<{ fork_id: string }>(gate).fork_id;
    assert.ok(fk.startsWith('fk_'));
    const res = dispatchRun(e.envOff, [
      '--task-kind', 'single_edit', '--repo', e.projDir, '--db', e.dbPath, '--after', fk, '--json',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const plan = lastJson<{ ok: boolean; deferred: boolean; reason: string | null; forkId: string; hcCommands: string[][] }>(res);
    assert.equal(plan.ok, true);
    assert.equal(plan.deferred, true);
    assert.equal(plan.reason, `after_fork ${fk} not closed (status=open)`);
    assert.equal(plan.hcCommands.length, 0);
    assert.ok(!plan.forkId!.startsWith('fk_') || plan.forkId!.startsWith('fk_dry_'), '실제 fork는 미발행(가명만)');
    assert.equal(forkRows(e.dbPath).length, 1, 'DB에는 종속 fork 1건만 존재');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('--after: 닫힌 fork(ok) → 정상 발행 + metadata.after_fork 스탬프', () => {
  const e = makeE2eEnv();
  try {
    const gate = dgRun(e.envOff, ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--json']);
    const fk = lastJson<{ fork_id: string }>(gate).fork_id;
    const close = dgRun(e.envOff, ['close', '--fork', fk, '--outcome', 'ok', '--by', 'dispatcher', '--json']);
    assert.equal(close.status, 0, close.stderr);
    const res = dispatchRun(e.envOff, [
      '--task-kind', 'single_edit', '--repo', e.projDir, '--db', e.dbPath, '--after', fk, '--json',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const plan = lastJson<{ ok: boolean; deferred: boolean; forkId: string; hcCommands: string[][] }>(res);
    assert.equal(plan.ok, true);
    assert.equal(plan.deferred, false);
    assert.ok(plan.forkId!.startsWith('fk_'));
    assert.equal(plan.hcCommands.length, 1, '리드 승격 커맨드 1건');
    const rows = forkRows(e.dbPath);
    const issued = rows.find((r) => r.fork_id === plan.forkId);
    assert.ok(issued, '발행 fork 행 존재');
    const meta = JSON.parse(issued!.metadata_json ?? '{}') as Record<string, unknown>;
    assert.equal(meta['after_fork'], fk, 'metadata.after_fork 스탬프');
    assert.equal(meta['dispatch'], true, 'dispatch:true 표식(Rust 정렬)');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// deferred fork dispatch:true 표식 정렬(Change ①-5) — Rust 구현과 동일하게
// 모든 dispatch 발급 fork가 표식을 가진다(strict wrap 게이트 통과 근거).
// ---------------------------------------------------------------------------

test('정렬: 동시성 상한으로 deferred된 fork도 dispatch:true 스탬프', () => {
  const e = makeE2eEnv();
  try {
    const plan = planDispatch({
      taskKind: 'single_edit',
      repoDir: e.projDir,
      dbPath: e.dbPath,
      runId: 'dead01',
      activeCoding: 2, // coding 동시성 상한 도달 → deferred
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.deferred, true);
    assert.match(plan.reason ?? '', /coding concurrency cap/);
    const rows = forkRows(e.dbPath);
    assert.equal(rows.length, 1, 'deferred도 fork는 발행된다(기존 형상)');
    const meta = JSON.parse(rows[0]!.metadata_json ?? '{}') as Record<string, unknown>;
    assert.equal(meta['dispatch'], true, 'deferred fork dispatch:true — Rust issue_fork 정렬');
    assert.equal(meta['repo_scope'], undefined, 'deferred는 스코프 리스를 홀드하지 않는다');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('--help는 strict 브리프 게이트보다 먼저 exit 0 (Rust cmd_dispatch와 동일 순서)', () => {
  const e = makeE2eEnv();
  try {
    const r = dispatchRun(e.envStrict, ['--help']);
    assert.equal(r.status, 0, `exit 0 (stderr=${r.stderr})`);
    assert.match(r.stdout, /--brief-file/);
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});
