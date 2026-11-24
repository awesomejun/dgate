/**
 * Change② merge_danger 단위 검증 — 선택 스키마 검증·fail-closed·strict 게이트·에코.
 *
 * 목적: mattpocock/skills `pr`의 Merge Danger 어휘를 흡수한 verdict top-level 선택 필드
 * `merge_danger: {door, blast_radius}`가 TS·Rust 쌍방 구현(src/decision/verdict.ts,
 * crates/dgate-core/src/verdict.rs)과 같은 규칙으로 동작하는지 확인한다.
 *  (a) 유효한 값은 통과하고 정규화 문서에 보존된다(backprop 에코의 원천).
 *  (b) 무효한 값(door 불일치·빈 blast_radius·501자·비객체)은 구조 fail-closed → human.
 *  (c) strict 게이트(mergeDangerStrictViolation)는 유효 verdict의 부재만 거부한다.
 *  (d) off 모드는 부재를 허용한다(백워드 호환).
 *
 * 실행: `node --test tests/verdict-merge-danger.test.ts`
 * 주의: CLI E2E는 `XDG_STATE_HOME`을 임시 경로로 격리한다 — 머신 전역 dispatch-mode와 무관하게
 * off/strict를 테스트가 결정한다. 전역 상태 파일은 건드리지 않는다.
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  MERGE_DANGER_DOORS,
  mergeDangerStrictViolation,
  validateVerdictData,
  validateVerdictFile,
} from '../src/decision/verdict.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');
const FORK_ID = 'fk_mdanger0001';
const BASE_OPTS = { expectedForkId: FORK_ID } as const;

/** 테스트용 verdict 원문 — 무효 값도 끼울 수 있게 타입을 unknown 값으로 유지한다 */
function makeVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    fork_id: FORK_ID,
    decision: 'pass',
    reason: '검증 통과',
    findings: [],
    ...overrides,
  };
}

test('(a) 유효한 merge_danger → valid + 문서 보존, 누락·null은 부재 취급(off 호환)', () => {
  const r = validateVerdictData(
    makeVerdict({ merge_danger: { door: 'two-way', blast_radius: 'engine.rs verdict 검증 경로 전체' } }),
    BASE_OPTS,
  );
  assert.equal(r.valid, true, r.errors.join('; '));
  assert.deepEqual(r.document?.merge_danger, {
    door: 'two-way',
    blast_radius: 'engine.rs verdict 검증 경로 전체',
  });
  assert.deepEqual([...MERGE_DANGER_DOORS], ['one-way', 'two-way']);
  for (const door of MERGE_DANGER_DOORS) {
    const rd = validateVerdictData(makeVerdict({ merge_danger: { door, blast_radius: 'x' } }), BASE_OPTS);
    assert.equal(rd.valid, true, door);
    assert.equal(rd.document?.merge_danger?.door, door);
  }
  // 500자 경계 통과
  const edge = validateVerdictData(
    makeVerdict({ merge_danger: { door: 'one-way', blast_radius: 'b'.repeat(500) } }),
    BASE_OPTS,
  );
  assert.equal(edge.valid, true, edge.errors.join('; '));
  // 누락·null → 부재 취급
  const missing = validateVerdictData(makeVerdict(), BASE_OPTS);
  assert.equal(missing.valid, true);
  assert.equal(missing.document?.merge_danger, undefined);
  const nullMd = validateVerdictData(makeVerdict({ merge_danger: null }), BASE_OPTS);
  assert.equal(nullMd.valid, true, nullMd.errors.join('; '));
  assert.equal(nullMd.document?.merge_danger, undefined);
  // 다른 선택 필드와 공존
  const both = validateVerdictData(
    makeVerdict({
      checked_commands: ['node --test tests/'],
      merge_danger: { door: 'one-way', blast_radius: 'x' },
    }),
    BASE_OPTS,
  );
  assert.equal(both.valid, true);
  assert.deepEqual(both.document?.checked_commands, ['node --test tests/']);
});

test('(b) 무효 merge_danger(door·blast_radius·비객체·501자) → 구조 fail-closed → human', () => {
  const cases: unknown[] = [
    { door: 'three-way', blast_radius: 'x' },
    { door: 'ONE-WAY', blast_radius: 'x' },
    { door: 'one-way', blast_radius: '' },
    { door: 'one-way', blast_radius: '   ' },
    { door: 'one-way' },
    { blast_radius: 'x' },
    { door: 1, blast_radius: 2 },
    'nope',
    [1, 2],
  ];
  for (const md of cases) {
    const r = validateVerdictData(makeVerdict({ merge_danger: md }), BASE_OPTS);
    assert.equal(r.valid, false, JSON.stringify(md));
    assert.equal(r.effectiveDecision, 'human', JSON.stringify(md));
    assert.equal(r.document, undefined, '무효면 정규화 문서를 내지 않는다');
    assert.ok(r.errors.some((e) => e.startsWith('merge_danger')), `${JSON.stringify(md)} → ${r.errors.join('; ')}`);
  }
  const long = validateVerdictData(
    makeVerdict({ merge_danger: { door: 'one-way', blast_radius: 'b'.repeat(501) } }),
    BASE_OPTS,
  );
  assert.equal(long.valid, false);
  assert.ok(long.errors.some((e) => e.includes('merge_danger.blast_radius가 500자를 초과')), long.errors.join('; '));
  // 무효 merge_danger는 다른 오류와 누적된다(한 번에 보고)
  const combined = validateVerdictData(
    makeVerdict({ decision: 'yolo', merge_danger: { door: 'x', blast_radius: '' } }),
    BASE_OPTS,
  );
  assert.equal(combined.valid, false);
  assert.ok(combined.errors.some((e) => e.includes('알 수 없는 decision')));
  assert.ok(combined.errors.some((e) => e.startsWith('merge_danger.door')));
  assert.ok(combined.errors.some((e) => e.startsWith('merge_danger.blast_radius')));
});

test('validateVerdictFile: merge_danger 무효 → fail-closed, 유효 → 파일 경로로도 보존', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdanger-file-'));
  try {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify(makeVerdict({ merge_danger: { door: 'x', blast_radius: '' } })));
    const rb = validateVerdictFile(bad, BASE_OPTS);
    assert.equal(rb.valid, false);
    assert.equal(rb.effectiveDecision, 'human');
    const ok = path.join(dir, 'ok.json');
    fs.writeFileSync(ok, JSON.stringify(makeVerdict({ merge_danger: { door: 'one-way', blast_radius: 'README만' } })));
    const ro = validateVerdictFile(ok, BASE_OPTS);
    assert.equal(ro.valid, true, ro.errors.join('; '));
    assert.deepEqual(ro.document?.merge_danger, { door: 'one-way', blast_radius: 'README만' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(c)(d) mergeDangerStrictViolation: strict+유효 verdict 부재만 거부, off·무효·있음은 통과', () => {
  const withMd = validateVerdictData(
    makeVerdict({ merge_danger: { door: 'one-way', blast_radius: 'x' } }),
    BASE_OPTS,
  );
  const withoutMd = validateVerdictData(makeVerdict(), BASE_OPTS);
  const invalid = validateVerdictData(makeVerdict({ decision: 'yolo' }), BASE_OPTS);
  const invalidMd = validateVerdictData(makeVerdict({ merge_danger: { door: 'x', blast_radius: 'y' } }), BASE_OPTS);
  // (d) off: 언제나 통과
  assert.equal(mergeDangerStrictViolation('off', withoutMd), null);
  assert.equal(mergeDangerStrictViolation('off', invalid), null);
  assert.equal(mergeDangerStrictViolation('off', invalidMd), null);
  // (c) strict: 유효 verdict에 merge_danger 없으면 거부 메시지, 있으면 통과
  const violation = mergeDangerStrictViolation('strict', withoutMd);
  assert.ok(violation !== null);
  assert.ok(violation.includes('merge_danger'), violation);
  assert.ok(violation.includes('dg dispatch-mode off'), '해제 방법 안내 포함');
  assert.equal(mergeDangerStrictViolation('strict', withMd), null);
  // 무효 verdict(merge_danger 무효 포함)는 게이트를 통과해 기존 exit 3 경로를 탄다
  assert.equal(mergeDangerStrictViolation('strict', invalid), null);
  assert.equal(mergeDangerStrictViolation('strict', invalidMd), null);
});

// ---------------------------------------------------------------------------
// CLI E2E — off/strict 모드 배선(XDG_STATE_HOME 격리, 전역 상태 파일 무변경)
// ---------------------------------------------------------------------------

function makeE2eDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdanger-${prefix}-${process.pid}-`));
}

function mkEnv(dbPath: string, xdgStateHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GEMINI_TRICK_DB_PATH: dbPath,
    DGATE_DB_PATH: undefined,
    DECISION_ORCHESTRATOR_DB_PATH: undefined,
    XDG_STATE_HOME: xdgStateHome,
  };
}

function dgRun(env: NodeJS.ProcessEnv, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DG_PATH, ...args], { env, encoding: 'utf8' });
}

function lastJson<T>(res: SpawnSyncReturns<string>): T {
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as T;
}

function issueFork(env: NodeJS.ProcessEnv, projDir: string): string {
  const res = dgRun(env, ['route', '--task-kind', 'explore_read', '--project', projDir, '--json']);
  assert.equal(res.status, 0, `route 실패: ${res.stderr}`);
  return lastJson<{ fork_id: string }>(res).fork_id;
}

function writeVerdict(base: string, forkId: string, withMergeDanger: boolean): string {
  const doc = makeVerdict({ fork_id: forkId, reason: 'all checks passed' });
  if (withMergeDanger) {
    doc['merge_danger'] = { door: 'two-way', blast_radius: 'verdict 스키마 확장' };
  }
  const p = path.join(base, `${forkId}-verdict.json`);
  fs.writeFileSync(p, JSON.stringify(doc), 'utf8');
  return p;
}

interface BackpropJson {
  action: string;
  exit_code: number;
  valid: boolean;
  errors: string[];
  merge_danger: { door: string; blast_radius: string } | null;
}

test('CLI E2E: off는 부재 허용(exit 0), strict는 부재 exit 2 / 있음 exit 0 + 에코 / 무효는 exit 3', () => {
  const base = makeE2eDir('e2e');
  const dbPath = path.join(base, 'decision.db');
  const projDir = path.join(base, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const xstateOff = path.join(base, 'xstate-off'); // 부재 → off
  const xstateStrict = path.join(base, 'xstate-strict');
  fs.mkdirSync(path.join(xstateStrict, 'dgate'), { recursive: true });
  fs.writeFileSync(path.join(xstateStrict, 'dgate', 'dispatch-mode'), 'strict\n', 'utf8');
  try {
    // (d) off: merge_danger 없어도 exit 0, 출력에는 null 에코
    const envOff = mkEnv(dbPath, xstateOff);
    const f1 = issueFork(envOff, projDir);
    const r1 = dgRun(envOff, ['backprop', '--fork', f1, '--verdict-file', writeVerdict(base, f1, false), '--json']);
    assert.equal(r1.status, 0, `off 부재 → exit 0: ${r1.stderr}\n${r1.stdout}`);
    assert.equal(lastJson<BackpropJson>(r1).merge_danger, null);
    // off: 있으면 exit 0 + 그대로 에코
    const f2 = issueFork(envOff, projDir);
    const r2 = dgRun(envOff, ['backprop', '--fork', f2, '--verdict-file', writeVerdict(base, f2, true), '--json']);
    assert.equal(r2.status, 0, `off 있음 → exit 0: ${r2.stderr}\n${r2.stdout}`);
    assert.deepEqual(lastJson<BackpropJson>(r2).merge_danger, { door: 'two-way', blast_radius: 'verdict 스키마 확장' });

    // (c) strict: 부재 → UsageError exit 2, fork는 닫히지 않는다
    const envStrict = mkEnv(dbPath, xstateStrict);
    const f3 = issueFork(envStrict, projDir);
    const r3 = dgRun(envStrict, ['backprop', '--fork', f3, '--verdict-file', writeVerdict(base, f3, false), '--json']);
    assert.equal(r3.status, 2, `strict 부재 → exit 2: ${r3.stderr}\n${r3.stdout}`);
    assert.ok(`${r3.stderr}\n${r3.stdout}`.includes('merge_danger'), '거부 사유에 merge_danger 언급');
    // strict: 있으면 exit 0 + 에코
    const f4 = issueFork(envStrict, projDir);
    const r4 = dgRun(envStrict, ['backprop', '--fork', f4, '--verdict-file', writeVerdict(base, f4, true), '--json']);
    assert.equal(r4.status, 0, `strict 있음 → exit 0: ${r4.stderr}\n${r4.stdout}`);
    assert.deepEqual(lastJson<BackpropJson>(r4).merge_danger, { door: 'two-way', blast_radius: 'verdict 스키마 확장' });
    // strict: 무효 verdict(모순)는 게이트가 아니라 기존 fail-closed exit 3
    const f5 = issueFork(envStrict, projDir);
    const badPath = path.join(base, `${f5}-bad-verdict.json`);
    fs.writeFileSync(
      badPath,
      JSON.stringify(
        makeVerdict({
          fork_id: f5,
          findings: [{ severity: 'P0', title: '치명', evidence: 'src/x.ts:1' }],
        }),
      ),
      'utf8',
    );
    const r5 = dgRun(envStrict, ['backprop', '--fork', f5, '--verdict-file', badPath, '--json']);
    assert.equal(r5.status, 3, `strict 무효 → exit 3: ${r5.stderr}\n${r5.stdout}`);
    const out5 = lastJson<BackpropJson>(r5);
    assert.equal(out5.action, 'escalate_human');
    assert.equal(out5.valid, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
