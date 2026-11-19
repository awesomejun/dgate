/**
 * PR-A3 Fail-Closed 구조화 Verdict + Retro 포매터 단위 검증
 * (brief-pra3 §3.A·§3.C, loopforge-arch-hydrogen §4.2·§5.1 PR-A3).
 *
 * 목적: `src/decision/verdict.ts`의 3중 불변식(파일·파싱 fail-closed / fork·HEAD 결속 /
 * 모순 판정 차단)과 `buildRetroMarkdown`·`resolveGitHead`·`resolveVerdictPath`를 검증한다.
 * 모든 거부 경로는 `effectiveDecision:'human'` 폴백인지 반드시 확인한다.
 *
 * 실행: `node --test tests/verdict-retro.test.ts` (외부 의존성 0개, 임시 디렉터리 사용)
 *
 * 주의: 파일 크기·HEAD 결속 테스트는 실제 파일을 임시 디렉터리에 써서 검증한다.
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openDb, GLOBAL_PROJECT_ID } from '../src/decision/db.ts';
import {
  buildRetroMarkdown,
  resolveGitHead,
  resolveVerdictPath,
  validateVerdictData,
  validateVerdictFile,
  type VerdictDocument,
} from '../src/decision/verdict.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** 테스트용 verdict 문서 생성기 — 불변식 테스트가 필드만 바꿔 끼운다 */
function makeVerdict(overrides: Partial<VerdictDocument> = {}): VerdictDocument {
  return {
    schema_version: 1,
    fork_id: 'fk_test0123456',
    target_head: 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4',
    decision: 'pass',
    reason: '모든 완료 기준 충족 — 테스트 전수 통과',
    findings: [],
    checked_commands: ['node --test tests/'],
    artifacts: ['.herdr/verify/fk_test0123456-brief.md'],
    ...overrides,
  };
}

/** 임시 디렉터리 생성 — 테스트마다 격리되고 종료 시 정리된다 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-test-'));
}

/** 임시 디렉터리에 verdict JSON 파일을 쓰고 경로를 반환한다 */
function writeVerdictFile(dir: string, value: unknown, name = 'fk_test0123456-verdict.json'): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return filePath;
}

const BASE_OPTS = { expectedForkId: 'fk_test0123456' } as const;
const FULL_HEAD = 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4';

test('정상 pass 판정: findings 빈 배열 또는 P2/info만 → valid, effectiveDecision pass', () => {
  const empty = validateVerdictData(makeVerdict(), BASE_OPTS);
  assert.equal(empty.valid, true);
  assert.equal(empty.effectiveDecision, 'pass');
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.document?.fork_id, 'fk_test0123456');
  assert.equal(empty.document?.findings.length, 0);

  const withP2 = validateVerdictData(
    makeVerdict({
      findings: [
        { severity: 'P2', title: '경미한 네이밍 불일치', evidence: 'src/a.ts:12' },
        { severity: 'info', title: '참고 사항', evidence: '로그 3행 참조' },
      ],
    }),
    BASE_OPTS,
  );
  assert.equal(withP2.valid, true);
  assert.equal(withP2.effectiveDecision, 'pass');
  assert.equal(withP2.document?.findings.length, 2);
});

test('모순 차단: pass + P1 또는 P0 finding → valid false, effectiveDecision human', () => {
  for (const severity of ['P1', 'P0'] as const) {
    const result = validateVerdictData(
      makeVerdict({ findings: [{ severity, title: '치명 결함', evidence: 'src/a.ts:1' }] }),
      BASE_OPTS,
    );
    assert.equal(result.valid, false, `severity=${severity}`);
    assert.equal(result.effectiveDecision, 'human', `severity=${severity}`);
    assert.ok(result.errors.some((e) => e.includes('P0/P1')), `severity=${severity}`);
    assert.equal(result.document, undefined);
  }
});

test('근거 없는 fail/rework 차단: findings 없음 또는 비공백 evidence 0건 → human', () => {
  for (const decision of ['fail', 'rework'] as const) {
    const noFindings = validateVerdictData(
      makeVerdict({ decision, findings: [] }),
      BASE_OPTS,
    );
    assert.equal(noFindings.valid, false, `${decision} findings=[]`);
    assert.equal(noFindings.effectiveDecision, 'human');
    assert.ok(noFindings.errors.some((e) => e.includes('findings가 없습니다')));

    const emptyEvidence = validateVerdictData(
      makeVerdict({
        decision,
        findings: [
          { severity: 'P0', title: '결함', evidence: '   ' },
          { severity: 'P1', title: '결함2', evidence: '' },
        ],
      }),
      BASE_OPTS,
    );
    assert.equal(emptyEvidence.valid, false, `${decision} evidence 공백`);
    assert.equal(emptyEvidence.effectiveDecision, 'human');
    assert.ok(emptyEvidence.errors.some((e) => e.includes('evidence')));
  }

  // 근거 있는 fail/rework은 정상 승인된다.
  const evidenced = validateVerdictData(
    makeVerdict({
      decision: 'fail',
      findings: [{ severity: 'P0', title: '테스트 실패', evidence: 'node --test → 3 fail' }],
    }),
    BASE_OPTS,
  );
  assert.equal(evidenced.valid, true);
  assert.equal(evidenced.effectiveDecision, 'fail');
});

test('human 판정 계약: 빈 action_required 거부 → human, 명시 시 valid human', () => {
  const missing = validateVerdictData(
    makeVerdict({ decision: 'human', reason: '판정 불가' }),
    BASE_OPTS,
  );
  assert.equal(missing.valid, false);
  assert.equal(missing.effectiveDecision, 'human');
  assert.ok(missing.errors.some((e) => e.includes('action_required')));

  const empty = validateVerdictData(
    makeVerdict({ decision: 'human', action_required: '   ' }),
    BASE_OPTS,
  );
  assert.equal(empty.valid, false);
  assert.equal(empty.effectiveDecision, 'human');

  const specified = validateVerdictData(
    makeVerdict({ decision: 'human', action_required: 'API 키 발급 후 재검증 필요' }),
    BASE_OPTS,
  );
  assert.equal(specified.valid, true);
  assert.equal(specified.effectiveDecision, 'human');
  assert.equal(specified.document?.action_required, 'API 키 발급 후 재검증 필요');
});

test('Fail-Closed 파일 검증: 미존재·64KB 초과·깨진 JSON·schema_version 불일치 → 전부 human', () => {
  const dir = makeTempDir();
  try {
    // 1. 파일 미존재
    const missing = validateVerdictFile(path.join(dir, 'nope-verdict.json'), BASE_OPTS);
    assert.equal(missing.valid, false);
    assert.equal(missing.effectiveDecision, 'human');
    assert.ok(missing.errors.some((e) => e.includes('찾을 수 없습니다')));

    // 2. 64KB 초과 — 사이즈 게이트가 파싱보다 먼저 거부한다
    const hugePath = writeVerdictFile(
      dir,
      makeVerdict({ reason: 'x'.repeat(70_000) }),
      'huge-verdict.json',
    );
    assert.ok(fs.statSync(hugePath).size > 65536, '사전 조건: 파일이 64KB 초과');
    const huge = validateVerdictFile(hugePath, BASE_OPTS);
    assert.equal(huge.valid, false);
    assert.equal(huge.effectiveDecision, 'human');
    assert.ok(huge.errors.some((e) => e.includes('크기 초과')));

    // maxBytes 옵션으로 상한을 낮추면 더 작은 파일도 거부된다
    const smallPath = writeVerdictFile(dir, makeVerdict(), 'small-verdict.json');
    const tightened = validateVerdictFile(smallPath, { ...BASE_OPTS, maxBytes: 10 });
    assert.equal(tightened.valid, false);
    assert.equal(tightened.effectiveDecision, 'human');

    // 3. 깨진 JSON
    const brokenPath = writeVerdictFile(
      dir,
      '{"schema_version": 1, "fork_id": "fk_test0123456", "decision":',
      'broken-verdict.json',
    );
    const broken = validateVerdictFile(brokenPath, BASE_OPTS);
    assert.equal(broken.valid, false);
    assert.equal(broken.effectiveDecision, 'human');
    assert.ok(broken.errors.some((e) => e.includes('파싱 실패')));

    // 4. schema_version 불일치
    const badSchemaPath = writeVerdictFile(
      dir,
      makeVerdict({ schema_version: 2 as unknown as 1 }),
      'badschema-verdict.json',
    );
    const badSchema = validateVerdictFile(badSchemaPath, BASE_OPTS);
    assert.equal(badSchema.valid, false);
    assert.equal(badSchema.effectiveDecision, 'human');
    assert.ok(badSchema.errors.some((e) => e.includes('schema_version')));

    // 5. 정상 파일은 승인 — 파일 경로 검증의 행복 경로
    const okPath = writeVerdictFile(dir, makeVerdict());
    const ok = validateVerdictFile(okPath, BASE_OPTS);
    assert.equal(ok.valid, true);
    assert.equal(ok.effectiveDecision, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('불변식 2 — fork_id 불일치(Replay)와 target_head 불일치(Stale) 거부', () => {
  const dir = makeTempDir();
  try {
    const replayPath = writeVerdictFile(dir, makeVerdict({ fork_id: 'fk_other9999999' }));
    const replay = validateVerdictFile(replayPath, BASE_OPTS);
    assert.equal(replay.valid, false);
    assert.equal(replay.effectiveDecision, 'human');
    assert.ok(replay.errors.some((e) => e.includes('fork_id 불일치')));

    const stalePath = writeVerdictFile(dir, makeVerdict({ target_head: 'f'.repeat(40) }));
    const stale = validateVerdictFile(stalePath, { ...BASE_OPTS, expectedHead: FULL_HEAD });
    assert.equal(stale.valid, false);
    assert.equal(stale.effectiveDecision, 'human');
    assert.ok(stale.errors.some((e) => e.includes('Stale Verdict')));

    // expectedHead 지정 시 target_head 누락도 Stale 거부
    const noHeadPath = writeVerdictFile(
      dir,
      makeVerdict({ target_head: undefined }),
      'nohead-verdict.json',
    );
    const noHead = validateVerdictFile(noHeadPath, { ...BASE_OPTS, expectedHead: FULL_HEAD });
    assert.equal(noHead.valid, false);
    assert.equal(noHead.effectiveDecision, 'human');
    assert.ok(noHead.errors.some((e) => e.includes('target_head가 없습니다')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('불변식 2 — HEAD 결속 규칙: full 일치·7자 이상 prefix 허용, 6자 prefix는 거부', () => {
  // full sha 일치
  const full = validateVerdictData(makeVerdict(), { ...BASE_OPTS, expectedHead: FULL_HEAD });
  assert.equal(full.valid, true);

  // 문서가 7자 약칭 → 허용 (shorter=7 ≥ 7)
  const shortDoc = validateVerdictData(makeVerdict({ target_head: FULL_HEAD.slice(0, 7) }), {
    ...BASE_OPTS,
    expectedHead: FULL_HEAD,
  });
  assert.equal(shortDoc.valid, true);

  // expectedHead가 약칭이고 문서가 full sha → 허용
  const shortExpected = validateVerdictData(makeVerdict(), {
    ...BASE_OPTS,
    expectedHead: FULL_HEAD.slice(0, 7),
  });
  assert.equal(shortExpected.valid, true);

  // 6자 약칭은 모호 → 거부
  const tooShort = validateVerdictData(makeVerdict({ target_head: FULL_HEAD.slice(0, 6) }), {
    ...BASE_OPTS,
    expectedHead: FULL_HEAD,
  });
  assert.equal(tooShort.valid, false);
  assert.equal(tooShort.effectiveDecision, 'human');

  // prefix가 아닌 7자 → 불일치 거부
  const wrongPrefix = validateVerdictData(
    makeVerdict({ target_head: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }),
    { ...BASE_OPTS, expectedHead: FULL_HEAD },
  );
  assert.equal(wrongPrefix.valid, false);
});

test('불변식 1 — 스키마 위반 전수 fail-closed: reason·decision·finding 필드 이상', () => {
  const cases: Array<{ name: string; doc: unknown; errorIncludes: string }> = [
    { name: 'JSON 객체 아님', doc: 'pass', errorIncludes: 'JSON 객체가 아닙니다' },
    { name: '배열', doc: [], errorIncludes: 'JSON 객체가 아닙니다' },
    { name: '알 수 없는 decision', doc: makeVerdict({ decision: 'ok' as never }), errorIncludes: '알 수 없는 decision' },
    { name: 'reason 빈 문자열', doc: makeVerdict({ reason: '   ' }), errorIncludes: 'reason가 빈' },
    {
      name: 'reason 4000자 초과',
      doc: makeVerdict({ reason: 'x'.repeat(4001) }),
      errorIncludes: '초과',
    },
    {
      name: 'finding title 500자 초과',
      doc: makeVerdict({
        findings: [{ severity: 'P2', title: 't'.repeat(501), evidence: 'src/a.ts' }],
      }),
      errorIncludes: 'title',
    },
    {
      name: '허용 외 severity',
      doc: makeVerdict({
        findings: [{ severity: 'P3' as never, title: '제목', evidence: 'src/a.ts' }],
      }),
      errorIncludes: 'severity',
    },
    { name: 'findings 비배열', doc: makeVerdict({ findings: 'none' as never }), errorIncludes: 'findings가 배열' },
  ];

  for (const { name, doc, errorIncludes } of cases) {
    const result = validateVerdictData(doc, BASE_OPTS);
    assert.equal(result.valid, false, name);
    assert.equal(result.effectiveDecision, 'human', name);
    assert.ok(
      result.errors.some((e) => e.includes(errorIncludes)),
      `${name}: ${result.errors.join(' | ')}`,
    );
  }
});

test('resolveVerdictPath: .herdr/verify/<forkId>-verdict.json SSOT 경로 반환', () => {
  assert.equal(
    resolveVerdictPath('/repo', 'fk_abc123'),
    path.join('/repo', '.herdr', 'verify', 'fk_abc123-verdict.json'),
  );
  const winStyle = resolveVerdictPath('/repo/dir', 'fk_x');
  assert.ok(winStyle.endsWith(`.herdr${path.sep}verify${path.sep}fk_x-verdict.json`));
});

test('resolveGitHead: 워크트리 HEAD sha 반환, 비 repo 디렉터리는 null', () => {
  const head = resolveGitHead(REPO_ROOT);
  assert.ok(head !== null);
  assert.match(head!, /^[0-9a-f]{40}$/);

  assert.equal(resolveGitHead(path.join(os.tmpdir(), 'no-such-dir-verdict')), null);
});

test('buildRetroMarkdown: 제목·요약 표·실패 도구 상위 5건 절단·권고 목록 생성', () => {
  const tools = Array.from({ length: 7 }, (_, i) => ({
    toolName: `tool_${i + 1}`,
    count: 10 - i,
    lastError: i === 0 ? 'exit 1: 테스트 실패' : undefined,
  }));
  const markdown = buildRetroMarkdown({
    forkId: 'fk_retro000001',
    projectLabel: 'Gemini Trick',
    route: 'tool_select',
    toolClass: 'shell_exec',
    status: 'backprop_fail',
    attempts: 3,
    cause: 'gate_fail',
    reworkCount: 2,
    reason: '같은 오류 2회 반복',
    topFailedTools: tools,
    recommendations: ['로컬 재현 후 단위 테스트 우선', '캐시 무효화', '문서 갱신', '4번째는 잘림'],
  });

  assert.ok(markdown.startsWith('# Loop Retro — fk_retro000001'));
  assert.ok(markdown.includes('- 프로젝트: Gemini Trick'));
  assert.ok(markdown.includes('| 상태 | backprop_fail |'));
  assert.ok(markdown.includes('| 원인 | gate_fail |'));
  assert.ok(markdown.includes('| 시도 횟수 | 3 |'));
  assert.ok(markdown.includes('| 재작업 횟수 | 2 |'));
  assert.ok(markdown.includes('> reason: 같은 오류 2회 반복'));

  // 상위 5건 절단: tool_1..tool_5는 포함, tool_6·tool_7은 제외
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(markdown.includes(`tool_${i}`), `tool_${i} 포함`);
  }
  assert.ok(!markdown.includes('tool_6'));
  assert.ok(!markdown.includes('tool_7'));
  assert.ok(markdown.includes('| exit 1: 테스트 실패 |'));
  assert.ok(markdown.includes('1. 로컬 재현 후 단위 테스트 우선'));
  assert.ok(markdown.includes('2. 캐시 무효화'));
  assert.ok(markdown.includes('3. 문서 갱신'));
  assert.ok(!markdown.includes('4번째는 잘림'), '권고는 최대 3줄');
});

test('buildRetroMarkdown: sanitize 콜백 적용·빈 입력 폴백·줄바꿈 정규화', () => {
  const markdown = buildRetroMarkdown({
    forkId: 'fk_retro000002',
    route: 'file_select',
    toolClass: 'file_read',
    status: 'ttl_orphan',
    topFailedTools: [{ toolName: 'edit_file', count: 4, lastError: 'sk-abcdef0123456789 노출\n2째 줄' }],
    recommendations: [],
    sanitize: (s) => s.replaceAll('sk-abcdef0123456789', '<redacted>'),
  });

  // sanitize는 절단 이전 전체 문자열에 적용된다 — 시크릿이 절단으로 가르지지 않는다
  assert.ok(!markdown.includes('sk-abcdef0123456789'));
  assert.ok(markdown.includes('<redacted>'));
  // 줄바꿈은 표 구조를 깨지 않게 한 줄로 정규화된다
  assert.ok(markdown.includes('<redacted> 노출 2째 줄'));

  // attempts·cause 미지정은 '-', 권고 비면 안내 문구로 폴백
  assert.ok(markdown.includes('| 시도 횟수 | - |'));
  assert.ok(markdown.includes('| 원인 | - |'));
  assert.ok(markdown.includes('권고 없음'));

  // 실패 도구 0건 폴백
  const empty = buildRetroMarkdown({
    forkId: 'fk_retro000003',
    route: 'retry_or_abort',
    toolClass: 'other',
    status: 'ok',
    topFailedTools: [],
    recommendations: ['동일 유지'],
  });
  assert.ok(empty.includes('(실패 도구 표본 없음)'));
  assert.ok(empty.includes('1. 동일 유지'));
});

// ===========================================================================
// CLI E2E — `dg backprop --verdict-file` + `dg retro` 통합 배선 (brief-pra2 §6)
// ===========================================================================

const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');
const E2E_HEAD = 'b7c8d9e0f1b7c8d9e0f1b7c8d9e0f1b7c8d9e0f1';

interface CliEnv {
  base: string;
  dbPath: string;
  projDir: string;
  env: NodeJS.ProcessEnv;
}

function makeCliEnv(): CliEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `pra3e2e-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const projDir = path.join(base, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  return { base, dbPath, projDir, env: { ...process.env, GEMINI_TRICK_DB_PATH: dbPath, DGATE_DB_PATH: undefined, DECISION_ORCHESTRATOR_DB_PATH: undefined } };
}

function dgRun(e: CliEnv, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DG_PATH, ...args], { env: e.env, encoding: 'utf8' });
}

/** dg route로 open fork 1개 발행 → fork_id */
function issueE2eFork(e: CliEnv): string {
  const res = dgRun(e, ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--json']);
  assert.equal(res.status, 0, `route 실패: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  return (JSON.parse(lines[lines.length - 1]!) as { fork_id: string }).fork_id;
}

function e2eStat(e: CliEnv, sql: string, ...params: (string | number | null)[]): unknown {
  const db = openDb(e.dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

/** verdict 문서 파일 생성 — fork_id·target_head를 실제 fork와 일치시킨다 */
function writeE2eVerdict(dir: string, forkId: string, overrides: Record<string, unknown> = {}): string {
  const doc = {
    schema_version: 1,
    fork_id: forkId,
    target_head: E2E_HEAD,
    decision: 'pass',
    reason: 'all checks passed',
    findings: [],
    ...overrides,
  };
  const p = path.join(dir, `${forkId}-verdict.json`);
  fs.writeFileSync(p, JSON.stringify(doc), 'utf8');
  return p;
}

test('CLI E2E: pass verdict + 일치 head → exit 0, fork → ok', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    const vf = writeE2eVerdict(e.base, forkId);
    const res = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf,
      '--expected-head', E2E_HEAD, '--json',
    ]);
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}\n${res.stdout}`);
    const fork = e2eStat(e, `SELECT status, closed_by FROM forks WHERE fork_id = ?`, forkId) as {
      status: string;
      closed_by: string;
    };
    assert.equal(fork.status, 'ok');
    assert.equal(fork.closed_by, 'verifier');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('CLI E2E: pass 판정 + P1 finding → exit 3, escalate_human + waiting_human + EWMA 미오염', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    const vf = writeE2eVerdict(e.base, forkId, {
      findings: [{ severity: 'P1', title: '블로킹 결함', evidence: 'src/x.ts:1' }],
    });
    const res = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf,
      '--expected-head', E2E_HEAD, '--json',
    ]);
    assert.equal(res.status, 3, `exit ${res.status}: ${res.stderr}`);
    const lines = res.stdout.trim().split('\n');
    const out = JSON.parse(lines[lines.length - 1]!) as {
      action: string;
      exit_code: number;
      valid: boolean;
    };
    assert.equal(out.action, 'escalate_human');
    assert.equal(out.valid, false, 'pass+P1은 무효 → fail-closed');
    const fork = e2eStat(e, `SELECT status, metadata_json FROM forks WHERE fork_id = ?`, forkId) as {
      status: string;
      metadata_json: string;
    };
    const meta = JSON.parse(fork.metadata_json) as { waiting_human?: boolean };
    assert.equal(meta.waiting_human, true, 'waiting_human 미설정');
    assert.notEqual(fork.status, 'ok', '무효 verdict가 fork를 ok로 닫으면 안 됨');
    // EWMA 미오염 — pass판정 표본이 기록되지 않았다
    const stat = e2eStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id != ? AND route = 'file_select' AND tool_class = 'file_read'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number } | undefined;
    assert.equal(stat?.raw_samples ?? 0, 0);
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('CLI E2E: --expected-head 생략 + pass 판정 + P1 finding → exit 3 fail-closed (B-1 회귀)', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    const vf = writeE2eVerdict(e.base, forkId, {
      findings: [{ severity: 'P1', title: '블로킹 결함', evidence: 'src/x.ts:1' }],
    });
    // --expected-head 미지정 — 과거엔 null이 넘어가 TypeError→exit 0 거짓 성공이었다
    const res = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf, '--json',
    ]);
    assert.equal(res.status, 3, `exit ${res.status}: ${res.stderr}`);
    const lines = res.stdout.trim().split('\n');
    const out = JSON.parse(lines[lines.length - 1]!) as {
      action: string;
      valid: boolean;
    };
    assert.equal(out.action, 'escalate_human');
    assert.equal(out.valid, false);
    const fork = e2eStat(e, `SELECT status, metadata_json FROM forks WHERE fork_id = ?`, forkId) as {
      status: string;
      metadata_json: string;
    };
    const meta = JSON.parse(fork.metadata_json) as { waiting_human?: boolean };
    assert.equal(meta.waiting_human, true, 'waiting_human 미설정');
    assert.equal(fork.status, 'open', '무효 verdict가 fork를 ok로 닫으면 안 됨');
    // EWMA 미오염 — 무효 판정이 표본을 남기면 안 됨
    const stat = e2eStat(
      e,
      `SELECT raw_samples FROM stats_summary WHERE project_id != ? AND route = 'file_select' AND tool_class = 'file_read'`,
      GLOBAL_PROJECT_ID
    ) as { raw_samples: number } | undefined;
    assert.equal(stat?.raw_samples ?? 0, 0);
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('CLI E2E: --expected-head 생략 + 정상 pass verdict → exit 0, fork → ok (B-1 회귀)', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    const vf = writeE2eVerdict(e.base, forkId);
    const res = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf, '--json',
    ]);
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}\n${res.stdout}`);
    const lines = res.stdout.trim().split('\n');
    const out = JSON.parse(lines[lines.length - 1]!) as {
      action: string;
      valid: boolean;
    };
    assert.equal(out.action, 'pass');
    assert.equal(out.valid, true);
    const fork = e2eStat(e, `SELECT status, closed_by FROM forks WHERE fork_id = ?`, forkId) as {
      status: string;
      closed_by: string;
    };
    assert.equal(fork.status, 'ok');
    assert.equal(fork.closed_by, 'verifier');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('CLI E2E: stale-head verdict → exit 3, escalate_human', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    const vf = writeE2eVerdict(e.base, forkId, {
      target_head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    const res = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf,
      '--expected-head', E2E_HEAD, '--json',
    ]);
    assert.equal(res.status, 3, `stale head인데 exit ${res.status}`);
    const lines = res.stdout.trim().split('\n');
    const out = JSON.parse(lines[lines.length - 1]!) as { action: string; valid: boolean };
    assert.equal(out.action, 'escalate_human');
    assert.equal(out.valid, false);
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('CLI E2E: rework --max-reworks 1 → 1회차 rework(exit 0), 2회차 예산 소진 escalate(exit 3)', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    const vf = writeE2eVerdict(e.base, forkId, {
      decision: 'rework',
      reason: 'minor fixes needed',
      findings: [{ severity: 'P2', title: '수정 필요', evidence: 'src/y.ts:5' }],
    });
    const first = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf,
      '--expected-head', E2E_HEAD, '--max-reworks', '1', '--json',
    ]);
    assert.equal(first.status, 0, `1회차 exit ${first.status}: ${first.stderr}`);
    const out1 = JSON.parse(first.stdout.trim().split('\n').pop()!) as { action: string };
    assert.equal(out1.action, 'rework');
    // fork는 재작업을 위해 open 유지 + rework_count=1
    const fork1 = e2eStat(e, `SELECT status, metadata_json FROM forks WHERE fork_id = ?`, forkId) as {
      status: string;
      metadata_json: string;
    };
    assert.equal(fork1.status, 'open');
    assert.equal((JSON.parse(fork1.metadata_json) as { rework_count?: number }).rework_count, 1);

    const second = dgRun(e, [
      'backprop', '--fork', forkId, '--verdict-file', vf,
      '--expected-head', E2E_HEAD, '--max-reworks', '1', '--json',
    ]);
    assert.equal(second.status, 3, `2회차 exit ${second.status}`);
    const out2 = JSON.parse(second.stdout.trim().split('\n').pop()!) as { action: string };
    assert.equal(out2.action, 'escalate_human');
    const fork2 = e2eStat(e, `SELECT metadata_json FROM forks WHERE fork_id = ?`, forkId) as {
      metadata_json: string;
    };
    assert.equal(
      (JSON.parse(fork2.metadata_json) as { waiting_human?: boolean }).waiting_human,
      true,
      '예산 소진 시 waiting_human 미설정'
    );
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});

test('CLI E2E: dg retro --fork --out → cause·실패 도구·리댁션 마크다운 생성', () => {
  const e = makeCliEnv();
  try {
    const forkId = issueE2eFork(e);
    // 프로젝트 실패 표본 시딩 — 시크릿 포함 오류 (기록 시점에 이미 리댁션돼야 함)
    const rec = dgRun(e, [
      'record', '--route', 'tool_select', '--tool-class', 'shell_exec',
      '--tool', 'run_command', '--ok', '0',
      '--error', 'Authorization: Bearer tok-secret987654321 rejected',
      '--project', e.projDir, '--json',
    ]);
    assert.equal(rec.status, 0, `record 실패: ${rec.stderr}`);
    // fork를 gate_fail(backprop_fail)로 전이해 cause 규약 필드 생성
    const bp = dgRun(e, ['backprop', '--fork', forkId, '--penalty', '2.0', '--reason', 'verifier FAIL', '--json']);
    assert.equal(bp.status, 0, `backprop 실패: ${bp.stderr}`);

    const outMd = path.join(e.base, 'retro', `${forkId}-retro.md`);
    const res = dgRun(e, ['retro', '--fork', forkId, '--out', outMd]);
    assert.equal(res.status, 0, `retro 실패 (exit ${res.status}): ${res.stderr}`);
    assert.ok(fs.existsSync(outMd), 'retro 마크다운 미생성');
    const md = fs.readFileSync(outMd, 'utf8');
    assert.ok(md.includes(forkId), 'fork_id 누락');
    assert.ok(md.includes('gate_fail'), 'cause 필드 누락');
    assert.ok(md.includes('run_command'), '실패 도구 요약 누락');
    assert.ok(!md.includes('tok-secret987654321'), '시크릿 평문 잔존 — 리댁션 실패');
    assert.ok(md.includes('<redacted>'), '리댁션 마커 부재');
  } finally {
    fs.rmSync(e.base, { recursive: true, force: true });
  }
});
