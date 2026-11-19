/**
 * `gemini-decision-1` Decision API 어댑터 테스트 (brief-decision-api §3).
 *
 * 전 케이스 `node:http` 로컬 목 서버(`127.0.0.1:0`) 대상 — 실제 외부 네트워크 0.
 * dg CLI는 async spawn으로 실행해 목 서버가 같은 프로세스에서 응답할 수 있게 한다.
 *
 * ① off/무키 강등 — HTTP 0·로컬 EWMA 불변
 * ② shadow 종단 — 헤더 인증·리댁션·로컬 불변·fork metadata_json 감사
 * ③ on 콜드스타트 — 로컬 split → API sharp 반영
 * ④ 하드 안전 가드 — requires_write·forced·--risk high·API risk high·gate forced
 * ⑤ measured 기반 — 기본 호출 0, --context/--api-eval 강제
 * ⑥ fail-safe — HTTP 500·깨진 JSON·타임아웃 + 키 스크럽
 * ⑦ dispatch — dry-run HTTP 0, shadow/on 감사 기록
 * ⑧ report — decisionApiShadow 집계 + DB 불변
 *
 * 실행: `node --test tests/decision-api-adapter.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { planDispatch, planDispatchWithDecisionApi } from '../scripts/dispatch.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DG_PATH = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');

const TEST_KEY = 'TEST-KEY-9f8e7d6c5b4a3210';
const CONTEXT_SECRET = 'sk-test-secret-1234567890abcdef';

// ---------- 목 서버 ----------

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface MockServer {
  server: http.Server;
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  /** 응답 지연(ms) — 타임아웃 테스트용 */
  delayMs?: number;
  /** 요청 헤더의 API 키를 응답 본문에 그대로 반영(키 스크럽 검증용) */
  echoKey?: boolean;
}

function decisionsBody(
  noul: number,
  riskTier: 'low' | 'medium' | 'high',
  inputTokens = 200,
  usageShape: 'usage' | 'usage_metadata' = 'usage'
): Record<string, unknown> {
  return {
    model: 'gemini-decision-1',
    answers: {
      should_fast_path: { noul, confidence: 0.94, reasoning: 'mock' },
      risk_tier: { choice: riskTier, reasoning: 'mock' },
    },
    // 공식 REST 응답은 usage.total_input_tokens — usage_metadata.input_tokens는 레거시 호환
    ...(usageShape === 'usage'
      ? { usage: { total_input_tokens: inputTokens, output_tokens: 0 } }
      : { usage_metadata: { input_tokens: inputTokens, output_tokens: 0 } }),
  };
}

async function startMock(handler: (req: CapturedRequest) => MockResponse): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      const out = handler(captured);
      const respond = (): void => {
        const status = out.status ?? 200;
        let payload = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
        if (out.echoKey) payload = JSON.stringify({ error: `echo ${String(req.headers['x-goog-api-key'])}` });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload);
      };
      if (out.delayMs !== undefined) setTimeout(respond, out.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------- dg CLI async 러너 ----------

interface DgResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function dgRun(args: string[], env: NodeJS.ProcessEnv): Promise<DgResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [DG_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    setTimeout(() => child.kill('SIGKILL'), 30_000);
  });
}

/** exit 0 검증 + 마지막 stdout 줄 JSON 파싱 */
async function dgJson(args: string[], env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const r = await dgRun([...args, '--json'], env);
  assert.equal(r.status, 0, `dg ${args.join(' ')} exit=${r.status} stderr=${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
}

// ---------- 테스트 환경 ----------

interface TestEnv {
  base: string;
  dbPath: string;
  projDir: string;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dapi-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const projDir = path.join(base, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  return { base, dbPath, projDir };
}

function cleanupEnv(e: TestEnv): void {
  fs.rmSync(e.base, { recursive: true, force: true });
}

/**
 * 주변 env 정제 — 실제 `GEMINI_DECISION_API_KEY`·`DECISION_API*` 유출 차단.
 * `overrides`에 `undefined`를 주면 해당 변수를 삭제한다.
 */
function dgEnv(e: TestEnv, overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_TRICK_DB_PATH: e.dbPath,
    DECISION_API: 'off',
  };
  delete env.GEMINI_DECISION_API_KEY;
  delete env.DECISION_API_BASE_URL;
  delete env.DECISION_API_MODEL;
  delete env.DECISION_API_TIMEOUT_MS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function apiEnv(e: TestEnv, mock: MockServer, mode: 'off' | 'shadow' | 'on', extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return dgEnv(e, {
    DECISION_API: mode,
    GEMINI_DECISION_API_KEY: TEST_KEY,
    DECISION_API_BASE_URL: mock.baseUrl,
    ...extra,
  });
}

/** fork metadata_json의 decision_api 감사 블록 조회 */
function readDecisionApiMeta(e: TestEnv): Record<string, unknown> | null {
  const db = new DatabaseSync(e.dbPath);
  try {
    const row = db
      .prepare('SELECT metadata_json FROM forks WHERE metadata_json IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1')
      .get() as { metadata_json: string } | undefined;
    if (!row) return null;
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const da = meta['decision_api'];
    return da && typeof da === 'object' ? (da as Record<string, unknown>) : null;
  } finally {
    db.close();
  }
}

function countDecisionEvents(e: TestEnv): number {
  const db = new DatabaseSync(e.dbPath);
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_events'").get();
    if (!t) return 0;
    const row = db.prepare('SELECT COUNT(*) AS c FROM decision_events').get() as { c: number };
    return Number(row.c);
  } finally {
    db.close();
  }
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 성공 표본 n건 — file_select/file_read 동일 키 (samples >= 5 → basis measured) */
async function seedOutcomes(e: TestEnv, outcomes: Array<{ ok: 0 | 1; weight?: string }>): Promise<void> {
  const env = dgEnv(e, {});
  for (const o of outcomes) {
    const args = [
      'record',
      '--route', 'file_select',
      '--tool-class', 'file_read',
      '--tool', 'read_probe',
      '--ok', String(o.ok),
      '--project', e.projDir,
    ];
    if (o.weight) args.push('--weight', o.weight);
    await dgJson(args, env);
  }
}

// ---------------------------------------------------------------------------
// ① off 모드 + 무키 강등 — HTTP 요청 0, 로컬 EWMA 결과 불변
// ---------------------------------------------------------------------------

test('1. off 모드·무키 강등 — HTTP 0, 로컬 판정 유지', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.15, 'high') }));
  try {
    // DECISION_API=off + 키 존재 → 네트워크 0
    const off = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'off')
    );
    assert.equal(off.decision, 'sharp');
    assert.equal('decision_api' in off, false);

    // DECISION_API=on + 키 부재 → off 강등
    const noKey = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      dgEnv(e, { DECISION_API: 'on', DECISION_API_BASE_URL: mock.baseUrl })
    );
    assert.equal(noKey.decision, 'sharp');
    assert.equal('decision_api' in noKey, false);

    // --decision-api on CLI 오버라이드 + 키 부재 → off 강등
    const cliNoKey = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--decision-api', 'on'],
      dgEnv(e, { DECISION_API_BASE_URL: mock.baseUrl })
    );
    assert.equal(cliNoKey.decision, 'sharp');
    assert.equal('decision_api' in cliNoKey, false);

    // --decision-api off CLI 오버라이드가 DECISION_API=on + 키를 덮어씀 → 0
    const cliOff = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--decision-api', 'off'],
      apiEnv(e, mock, 'on')
    );
    assert.equal(cliOff.decision, 'sharp');

    assert.equal(mock.requests.length, 0, 'off/무키 경로에서 HTTP 요청 0');
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ② shadow 종단 — 헤더 인증·리댁션·로컬 불변·감사 기록
// ---------------------------------------------------------------------------

test('2. shadow — POST /v1beta/decisions + 헤더 키 + context 리댁션 + 로컬 불변 + 감사', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.15, 'high', 200) }));
  try {
    const before = countDecisionEvents(e);
    const out = await dgJson(
      [
        'route', '--task-kind', 'explore_read',
        '--project', e.projDir,
        '--context', `read this ${CONTEXT_SECRET} now`,
      ],
      apiEnv(e, mock, 'shadow')
    );

    // 요청 계약
    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1beta/decisions');
    assert.ok(!req.url.includes('?key='), 'URL에 ?key= 금지');
    assert.equal(req.headers['x-goog-api-key'], TEST_KEY);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    assert.equal(body.model, 'gemini-decision-1');
    const q = body.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
    assert.equal(q.should_fast_path?.type, 'noul');
    assert.equal(q.risk_tier?.type, 'choice');
    // noul criteria는 공식 키 true_description/false_description ('true'/'false' 금지 — live 400 확인)
    const sfpCriteria = q.should_fast_path?.criteria ?? {};
    assert.ok(sfpCriteria.true_description, 'criteria.true_description 필수');
    assert.ok(sfpCriteria.false_description, 'criteria.false_description 필수');
    assert.equal('true' in sfpCriteria, false, 'criteria.true 키 금지');
    assert.equal('false' in sfpCriteria, false, 'criteria.false 키 금지');
    const input = String(body.input);
    assert.ok(!input.includes(CONTEXT_SECRET), 'context 시크릿은 전송 전 리댁션');
    assert.ok(input.includes('route: file_select'));

    // 로컬 판정 불변 — p≈0.94 ≥ 0.70 → sharp 유지
    assert.equal(out.decision, 'sharp');
    assert.ok(Number(out.p) >= 0.7);

    // JSON 감사
    const audit = out.decision_api as Record<string, unknown>;
    assert.equal(audit.mode, 'shadow');
    assert.equal(audit.applied, false);
    assert.equal(audit.disagreed, true);
    assert.equal(audit.p_api, 0.15);
    assert.equal(audit.input_tokens, 200);
    assert.ok(Math.abs(Number(audit.cost_usd) - 0.00002) < 1e-9, `cost_usd=${audit.cost_usd}`);

    // fork metadata_json 감사
    const meta = readDecisionApiMeta(e);
    assert.ok(meta, 'forks.metadata_json.decision_api 존재');
    assert.equal(meta!.mode, 'shadow');
    assert.equal(meta!.applied, false);
    assert.equal(meta!.disagreed, true);

    // decision_events 오염 0
    assert.equal(countDecisionEvents(e), before);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ③ on 콜드스타트 — 로컬 split → API sharp 반영
// ---------------------------------------------------------------------------

test('3. on 콜드스타트 — 로컬 split(prior)이 API noul로 sharp 전환', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.91, 'low') }));
  try {
    // fail(w2), ok, fail(w2) → p ≈ 0.62 < 0.70, samples=3(prior), 연속오류 1(비강제)
    await seedOutcomes(e, [
      { ok: 0, weight: '2' },
      { ok: 1 },
      { ok: 0, weight: '2' },
    ]);
    const localOnly = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      dgEnv(e, {})
    );
    assert.equal(localOnly.decision, 'split', '로컬 prior p<0.70 → split');
    assert.ok(Number(localOnly.p) < 0.7);

    const out = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(mock.requests.length, 1);
    assert.equal(out.decision, 'sharp');
    assert.ok(Math.abs(Number(out.p) - 0.91) < 1e-9, `p=${out.p}`);
    const audit = out.decision_api as Record<string, unknown>;
    assert.equal(audit.mode, 'on');
    assert.equal(audit.applied, true);
    assert.equal(audit.p_api, 0.91);
    assert.equal(audit.local_decision, 'split');
    assert.equal(audit.api_decision, 'sharp');
    assert.equal(audit.disagreed, true);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ④ 하드 안전 가드 — API가 우회할 수 없는 split
// ---------------------------------------------------------------------------

test('4a. requires_write(single_edit) + 낙관 API → split 유지', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.99, 'low') }));
  try {
    const out = await dgJson(
      ['route', '--task-kind', 'single_edit', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(mock.requests.length, 1);
    assert.equal(out.decision, 'split');
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

test('4b. 연속 2실패 강제 split + 낙관 API → split 유지', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.99, 'low') }));
  try {
    await seedOutcomes(e, [{ ok: 0 }, { ok: 0 }]);
    const out = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(out.decision, 'split');
    assert.equal(out.forced_split, true);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

test('4c. 명시 --risk high + 낙관 API → split 유지', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.99, 'low') }));
  try {
    const out = await dgJson(
      ['route', '--task-kind', 'explore_read', '--risk', 'high', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(out.decision, 'split');
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

test('4d. API risk_tier high → 로컬 sharp도 split으로 하향', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.99, 'high') }));
  try {
    const out = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(out.decision, 'split');
    const audit = out.decision_api as Record<string, unknown>;
    assert.equal(audit.applied, true);
    assert.equal(audit.api_decision, 'split');
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

test('4e. dg gate forced split → split 유지', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.99, 'low') }));
  try {
    await seedOutcomes(e, [{ ok: 0 }, { ok: 0 }]);
    const out = await dgJson(
      ['gate', '--route', 'file_select', '--tool-class', 'file_read', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(out.decision, 'split');
    assert.equal(out.forced_split, true);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ⑤ measured 기반 — 기본 호출 0, --context/--api-eval만 강제
// ---------------------------------------------------------------------------

test('5. measured 기반 — on도 API 생략, --context/--api-eval만 강제', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.5, 'low') }));
  try {
    await seedOutcomes(e, [{ ok: 1 }, { ok: 1 }, { ok: 1 }, { ok: 1 }, { ok: 1 }]);
    const base = await dgJson(['route', '--task-kind', 'explore_read', '--project', e.projDir], dgEnv(e, {}));
    assert.equal(base.basis, 'measured');

    const skip = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(skip.decision, 'sharp');
    assert.equal('decision_api' in skip, false);
    assert.equal(mock.requests.length, 0, 'measured 기반은 API 호출 0');

    const forced = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--api-eval'],
      apiEnv(e, mock, 'on')
    );
    assert.equal(mock.requests.length, 1, '--api-eval은 measured에서도 호출');
    assert.ok('decision_api' in forced);

    const ctx = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--context', 'extra context'],
      apiEnv(e, mock, 'on')
    );
    assert.equal(mock.requests.length, 2, '--context도 measured에서 호출');
    assert.ok('decision_api' in ctx);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ⑥ fail-safe — HTTP 500·깨진 JSON·타임아웃 + 키 스크럽
// ---------------------------------------------------------------------------

test('6a. HTTP 500(키 에코) — exit 0, 로컬 폴백, 키 누출 0', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ status: 500, echoKey: true }));
  try {
    const r = await dgRun(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir, '--json'],
      apiEnv(e, mock, 'on')
    );
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes(TEST_KEY), 'stdout에 키 없음');
    assert.ok(!r.stderr.includes(TEST_KEY), 'stderr에 키 없음');
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    assert.equal(out.decision, 'sharp');
    const audit = out.decision_api as Record<string, unknown>;
    assert.equal(audit.ok, false);
    assert.equal(audit.applied, false);
    assert.ok(!String(audit.error).includes(TEST_KEY), '감사 error에 키 없음');
    // SQLite 파일 바이트에도 키 없음 (metadata_json 영속 경로 포함)
    const dbBytes = fs.readFileSync(e.dbPath);
    assert.ok(!dbBytes.includes(Buffer.from(TEST_KEY)), 'DB 파일에 키 없음');
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

test('6b. 깨진 JSON 응답 — exit 0, 로컬 폴백', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: 'not-json{{{' }));
  try {
    const out = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'on')
    );
    assert.equal(out.decision, 'sharp');
    const audit = out.decision_api as Record<string, unknown>;
    assert.equal(audit.ok, false);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

test('6c. 타임아웃(80ms < 지연 350ms) — exit 0, 로컬 폴백', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.99, 'low'), delayMs: 350 }));
  try {
    const out = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'on', { DECISION_API_TIMEOUT_MS: '80' })
    );
    assert.equal(out.decision, 'sharp');
    const audit = out.decision_api as Record<string, unknown>;
    assert.equal(audit.ok, false);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ⑦ dispatch — dry-run HTTP 0, shadow/on 감사 기록
// ---------------------------------------------------------------------------

test('7. dispatch — dryRun on HTTP 0 / shadow·on 감사 / off는 planDispatch 동등', async () => {
  const e = makeEnv();
  const mock = await startMock(() => ({ body: decisionsBody(0.91, 'low') }));
  const env = { GEMINI_DECISION_API_KEY: TEST_KEY, DECISION_API_BASE_URL: mock.baseUrl };
  try {
    // dryRun + on → HTTP 0
    const dry = await planDispatchWithDecisionApi({
      taskKind: 'explore_read',
      repoDir: e.projDir,
      dbPath: e.dbPath,
      dryRun: true,
      decisionApi: 'on',
      env,
      runId: 'api001',
    });
    assert.equal(dry.ok, true);
    assert.equal(mock.requests.length, 0, 'dryRun은 HTTP 0');
    assert.equal(dry.decision_api, undefined);

    // off → planDispatch와 동등 (decision_api 없음)
    const off = await planDispatchWithDecisionApi({
      taskKind: 'explore_read',
      repoDir: e.projDir,
      dbPath: e.dbPath,
      decisionApi: 'off',
      env,
      runId: 'api002',
    });
    const plain = planDispatch({ taskKind: 'explore_read', repoDir: e.projDir, dbPath: e.dbPath, runId: 'api003' });
    assert.equal(off.decision, plain.decision);
    assert.equal(off.decision_api, undefined);
    assert.equal(mock.requests.length, 0);

    // shadow 비-dry-run → 요청 + 감사 + 로컬 불변 + fork 메타데이터
    const shadow = await planDispatchWithDecisionApi({
      taskKind: 'explore_read',
      repoDir: e.projDir,
      dbPath: e.dbPath,
      decisionApi: 'shadow',
      env,
      runId: 'api004',
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(shadow.decision, 'sharp');
    assert.equal(shadow.decision_api?.mode, 'shadow');
    assert.equal(shadow.decision_api?.applied, false);
    const meta = readDecisionApiMeta(e);
    assert.ok(meta, 'dispatch fork에 decision_api 메타데이터');

    // on 비-dry-run → applied + p 주입
    const on = await planDispatchWithDecisionApi({
      taskKind: 'explore_read',
      repoDir: e.projDir,
      dbPath: e.dbPath,
      decisionApi: 'on',
      env,
      runId: 'api005',
    });
    assert.equal(mock.requests.length, 2);
    assert.equal(on.decision, 'sharp');
    assert.equal(on.decision_api?.applied, true);
    assert.ok(Math.abs(Number(on.p) - 0.91) < 1e-9, `plan.p=${on.p}`);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ⑧ report — decisionApiShadow 집계 + DB 해시 불변
// ---------------------------------------------------------------------------

test('8. dg report --json — shadow 집계 노출 + DB 불변', async () => {
  const e = makeEnv();
  let phase = 0;
  const mock = await startMock(() => {
    phase += 1;
    return { body: phase === 1 ? decisionsBody(0.15, 'high', 200) : decisionsBody(0.95, 'low', 100) };
  });
  try {
    // shadow 평가 2건 생성: ① disagreed(split vs sharp) ② agreed(sharp)
    await dgJson(['route', '--task-kind', 'explore_read', '--project', e.projDir], apiEnv(e, mock, 'shadow'));
    await dgJson(['route', '--task-kind', 'explore_read', '--project', e.projDir], apiEnv(e, mock, 'shadow'));
    assert.equal(mock.requests.length, 2);

    const hashBefore = sha256File(e.dbPath);
    const rep = await dgJson(['report', '--db', e.dbPath, '--repo', e.projDir], dgEnv(e, {}));
    const shadow = (rep.report as Record<string, unknown>).decisionApiShadow as Record<string, unknown>;
    assert.equal(shadow.total, 2);
    assert.equal(shadow.ok, 2);
    assert.equal(shadow.shadow_count, 2);
    assert.equal(shadow.on_applied_count, 0);
    assert.equal(shadow.disagreed, 1, '0.15+high만 불일치');
    assert.equal(shadow.disagreement_rate, 0.5);
    assert.equal(shadow.total_input_tokens, 300);
    assert.ok(Math.abs(Number(shadow.total_cost_usd) - 0.00003) < 1e-9, `cost=${shadow.total_cost_usd}`);
    assert.equal(sha256File(e.dbPath), hashBefore, 'report 실행 전후 DB 불변');

    // 마크다운 섹션 — total > 0이므로 출력
    const mdPath = path.join(e.base, 'report.md');
    const repMd = await dgRun(['report', '--db', e.dbPath, '--repo', e.projDir, '--out', mdPath], dgEnv(e, {}));
    assert.equal(repMd.status, 0, repMd.stderr);
    const md = fs.readFileSync(mdPath, 'utf8');
    assert.ok(md.includes('## Decision API Shadow 요약'));
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});

// ---------------------------------------------------------------------------
// ⑨ usage shape 호환 — 공식 usage.total_input_tokens + 레거시 usage_metadata.input_tokens
// ---------------------------------------------------------------------------

test('9. usage shape — 공식 usage.total_input_tokens(기본) + 레거시 usage_metadata.input_tokens 모두 파싱', async () => {
  const e = makeEnv();
  let shape: 'usage' | 'usage_metadata' = 'usage';
  const mock = await startMock(() => ({ body: decisionsBody(0.8, 'low', 150, shape) }));
  try {
    // ① 공식 shape — usage.total_input_tokens
    const official = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'shadow')
    );
    let audit = official.decision_api as Record<string, unknown>;
    assert.equal(audit.ok, true);
    assert.equal(audit.input_tokens, 150, 'usage.total_input_tokens 파싱');
    assert.equal(audit.cost_status, 'estimated');

    // ② 레거시 shape — usage_metadata.input_tokens
    shape = 'usage_metadata';
    const legacy = await dgJson(
      ['route', '--task-kind', 'explore_read', '--project', e.projDir],
      apiEnv(e, mock, 'shadow')
    );
    audit = legacy.decision_api as Record<string, unknown>;
    assert.equal(audit.ok, true);
    assert.equal(audit.input_tokens, 150, 'usage_metadata.input_tokens 파싱');
    assert.equal(audit.cost_status, 'estimated');
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
    cleanupEnv(e);
  }
});
