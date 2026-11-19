/**
 * PR-A1 시크릿 방어 3중 경계 테스트 (brief-pra1 §3.D).
 *
 * 목적: `redactSecrets`(env 실측값 + 패턴 세트, 무예외) ·
 * `buildSanitizedChildEnv`(민감 키 제거 + 허용·안전 키 보존) ·
 * `agentRunner` REST 폴백(`?key=` URL 부재 + `x-goog-api-key` 헤더) ·
 * `agyStreamMapper`(`tool_info.output`·`errorSnippet` 리댁션)를 검증한다.
 *
 * 실행: `node --test tests/redact-security.test.ts`
 * 주의: 각 테스트는 고유 임시 GEMINI_TRICK_DB_PATH를 쓰고 fetch·env를 복원한다.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildSanitizedChildEnv, redactSecrets } from '../src/decision/redact.ts';
import { openDb } from '../src/decision/db.ts';
import { createInitialState } from '../src/state/store.ts';
import { applyAgyEvent } from '../src/backend/agyStreamMapper.ts';
import { AgentRunner } from '../src/backend/agentRunner.ts';

// ---------------------------------------------------------------------------
// 환경 스캐폴딩

interface TestEnv {
  base: string;
  dbPath: string;
  restore: () => void;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `pra1-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const prevDb = process.env.GEMINI_TRICK_DB_PATH;
  process.env.GEMINI_TRICK_DB_PATH = dbPath;
  return {
    base,
    dbPath,
    restore() {
      if (prevDb === undefined) delete process.env.GEMINI_TRICK_DB_PATH;
      else process.env.GEMINI_TRICK_DB_PATH = prevDb;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function eventRows(dbPath: string): Record<string, unknown>[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDb(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db.prepare(`SELECT * FROM decision_events ORDER BY event_id`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 1. redactSecrets — env 실측값 스크러빙

test('1. redactSecrets: env 시크릿(>=8자) 원문·encodeURIComponent 치환 + <8자 더미 유지', () => {
  const prevKey = process.env.PRA1_TEST_API_KEY;
  const prevShort = process.env.PRA1_SHORT_TOKEN;
  // 특수문자 포함 — URL 인코딩 시 형태가 달라지는 값
  process.env.PRA1_TEST_API_KEY = 'pra1sec+ret/key=99ab';
  process.env.PRA1_SHORT_TOKEN = 'tiny';
  try {
    const encoded = encodeURIComponent('pra1sec+ret/key=99ab');
    const out = redactSecrets(
      `raw=pra1sec+ret/key=99ab encoded=${encoded} short=tiny tail`
    );
    assert.ok(!out.includes('pra1sec+ret/key=99ab'), '원문 시크릿 잔존');
    assert.ok(!out.includes(encoded), '인코딩 시크릿 잔존');
    assert.ok(out.includes('<redacted>'), 'redacted 마커 부재');
    assert.ok(out.includes('short=tiny'), '짧은 더미 값 오치환 — <8자는 유지돼야 함');
  } finally {
    if (prevKey === undefined) delete process.env.PRA1_TEST_API_KEY;
    else process.env.PRA1_TEST_API_KEY = prevKey;
    if (prevShort === undefined) delete process.env.PRA1_SHORT_TOKEN;
    else process.env.PRA1_SHORT_TOKEN = prevShort;
  }
});

// ---------------------------------------------------------------------------
// 2. redactSecrets — 패턴 세트 + 무예외

test('2. redactSecrets: URL·userinfo·Bearer·헤더·키 접두어 마스킹 + 무예외', () => {
  const cases: Array<{ input: string; must: string[]; absent: string[] }> = [
    {
      input: 'GET https://api.example.com/v1?key=SUPERSECRET123&page=2',
      must: ['key=<redacted>'],
      absent: ['SUPERSECRET123'],
    },
    {
      input: 'https://user:passw0rd-xyz@example.com/path',
      must: ['https://user:<redacted>@example.com'],
      absent: ['passw0rd-xyz'],
    },
    {
      input: 'Authorization: Bearer tok-abcdef1234567890',
      must: ['Authorization: Bearer <redacted>'],
      absent: ['tok-abcdef1234567890'],
    },
    {
      input: 'x-goog-api-key: AIzaSyTESTKEY0123456789abcdef',
      must: ['x-goog-api-key: <redacted>'],
      absent: ['AIzaSyTESTKEY0123456789abcdef'],
    },
    {
      input: 'OPENAI_API_KEY=sk-proj-abcdef0123456789zz',
      must: ['OPENAI_API_KEY=<redacted>'],
      absent: ['sk-proj-abcdef0123456789zz'],
    },
    {
      input: 'token ghp_0123456789abcdefghijKL end',
      must: ['<redacted>'],
      absent: ['ghp_0123456789abcdefghijKL'],
    },
    {
      input: 'aws AKIAIOSFODNN7EXAMPLE leak',
      must: ['<redacted>'],
      absent: ['AKIAIOSFODNN7EXAMPLE'],
    },
    {
      input: 'curl -H "Authorization: Basic QWxhZGRpbjpPcGVuU2VzYW1l" https://x',
      must: ['Authorization: Basic <redacted>'],
      absent: ['QWxhZGRpbjpPcGVuU2VzYW1l'],
    },
  ];
  for (const c of cases) {
    const out = redactSecrets(c.input);
    for (const m of c.must) assert.ok(out.includes(m), `[${c.input}] → ${out} (missing ${m})`);
    for (const a of c.absent) assert.ok(!out.includes(a), `[${c.input}] 평문 잔존: ${out}`);
  }

  // 무예외(Zero-Throw) — 어떤 입력도 예외를 던지지 않는다
  const weird: string[] = [
    '',
    ' ',
    'key=',
    '%',
    '\0\0\0',
    'a'.repeat(200_000),
    '???key&&&===###',
    'Bearer',
    'https://@',
    'AIza',
    '한국어 시크릿 테스트 🔑',
  ];
  for (const w of weird) {
    assert.doesNotThrow(() => redactSecrets(w));
    assert.equal(typeof redactSecrets(w), 'string');
  }
  assert.doesNotThrow(() => redactSecrets('x', ['AIzaSyEXTRA0000000000key'] as const));
  assert.ok(
    !redactSecrets('call AIzaSyEXTRA0000000000key now', ['AIzaSyEXTRA0000000000key']).includes(
      'AIzaSyEXTRA0000000000key'
    ),
    'extraValues 스크러빙 실패'
  );
});

// ---------------------------------------------------------------------------
// 3. buildSanitizedChildEnv

test('3. buildSanitizedChildEnv: 민감 키 제거 + allowKeys·HERDR_*·DB 경로 보존', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'ko_KR.UTF-8',
    LC_ALL: 'ko_KR.UTF-8',
    XDG_CONFIG_HOME: '/home/u/.config',
    TMPDIR: '/tmp',
    OPENAI_API_KEY: 'sk-proj-secret000000000000',
    GH_TOKEN: 'ghp_secret00000000000000000',
    AWS_SECRET_ACCESS_KEY: 'awssecret0000000000',
    AWS_SESSION_TOKEN: 'awsession00000000000',
    GEMINI_API_KEY: 'gemini-secret0000000000',
    HERDR_DB_WRITE: '1',
    HERDR_AGY_STALL_MS: '120000',
    DECISION_READONLY: '1',
    GEMINI_TRICK_DB_PATH: '/tmp/x.db',
    AGY_BIN: '/usr/local/bin/agy',
    NORMAL_FLAG: 'keepme',
  };
  const env = buildSanitizedChildEnv({ baseEnv, allowKeys: ['GEMINI_API_KEY'] });
  // 제거 대상 — allowKeys에 없는 민감 키
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.AWS_SESSION_TOKEN, undefined);
  // allowKeys 명시 허용
  assert.equal(env.GEMINI_API_KEY, 'gemini-secret0000000000');
  // 안전 기본 키·접두사 보존
  for (const k of [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'TMPDIR',
    'HERDR_DB_WRITE',
    'HERDR_AGY_STALL_MS',
    'DECISION_READONLY',
    'GEMINI_TRICK_DB_PATH',
    'AGY_BIN',
    'NORMAL_FLAG',
  ]) {
    assert.ok(k in env, `${k} 누락`);
  }
  // extraEnv 병합 + undefined 삭제 계약
  const merged = buildSanitizedChildEnv({
    baseEnv,
    allowKeys: ['GEMINI_API_KEY'],
    extraEnv: { HERDR_DELEGATE_MODE: 'hc', NORMAL_FLAG: undefined },
  });
  assert.equal(merged.HERDR_DELEGATE_MODE, 'hc');
  assert.equal(merged.NORMAL_FLAG, undefined);
  // allowKeys 미지정 시 GEMINI_API_KEY도 제거
  const strict = buildSanitizedChildEnv({ baseEnv });
  assert.equal(strict.GEMINI_API_KEY, undefined);
});

// ---------------------------------------------------------------------------
// 4. agentRunner REST — ?key= 부재 + x-goog-api-key 헤더 + timeout signal

test('4. agentRunner REST: URL에 ?key= 부재, x-goog-api-key 헤더·AbortSignal 전달', async () => {
  const e = makeEnv();
  const prevKey = process.env.GEMINI_API_KEY;
  const origFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'unit-test-key-12345678';
  const calls: Array<{ url: string; headers: Record<string, string>; signal: unknown }> = [];
  try {
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      const i = init as { headers?: Record<string, string>; signal?: unknown };
      calls.push({
        url: String(url),
        headers: i?.headers ?? {},
        signal: i?.signal,
      });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '완료' }] } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const state = createInitialState('live');
    const runner = new AgentRunner({ preference: 'api', autoApprove: true });
    assert.equal(runner.backend, 'gemini-api');
    await runner.runPrompt('응답해줘', state, () => {});

    assert.ok(calls.length >= 1, 'fetch 미호출');
    for (const c of calls) {
      assert.ok(!/(\?|&)key=/.test(c.url), `URL에 ?key= 잔존: ${c.url}`);
      assert.ok(!c.url.includes('unit-test-key-12345678'), `URL에 평문 키 잔존: ${c.url}`);
      assert.equal(c.headers['x-goog-api-key'], 'unit-test-key-12345678');
      assert.ok(c.signal instanceof AbortSignal, 'AbortSignal 미전달');
    }
    assert.equal(state.phase, '완료');
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    e.restore();
  }
});

test('4b. askNeonVerify REST 폴백도 ?key= 없이 헤더로 키 전달', async () => {
  const e = makeEnv();
  const prevKey = process.env.GEMINI_API_KEY;
  const origFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'neon-test-key-87654321';
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  try {
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      const i = init as { headers?: Record<string, string> };
      calls.push({ url: String(url), headers: i?.headers ?? {} });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '[PASS] 회귀 없음' }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const state = createInitialState('live');
    const runner = new AgentRunner({ preference: 'api', autoApprove: true });
    runner.askNeonVerify('검증 대상', state, () => {});
    // fire-and-forget — 최대 3초 폴링으로 완료 대기
    const deadline = Date.now() + 3_000;
    while (state.neonState === 'run' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(calls.length, 1, 'neon fetch 미호출');
    const c = calls[0]!;
    assert.ok(!/(\?|&)key=/.test(c.url), `URL에 ?key= 잔존: ${c.url}`);
    assert.equal(c.headers['x-goog-api-key'], 'neon-test-key-87654321');
    assert.equal(state.neonState, 'pass');
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    e.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. agyStreamMapper — tool_info.output 로그 + errorSnippet DB 리댁션

test('5. agyStreamMapper: tool_info.output·error 시크릿이 로그·DB에 평문으로 남지 않는다', () => {
  const e = makeEnv();
  const SECRET_A = 'AIzaSyLEAKYKEY0123456789abcd';
  const SECRET_B = 'Bearer tok-livekey-987654321';
  try {
    const state = createInitialState('live');
    applyAgyEvent(state, {
      event: 'init',
      conversation_id: 'c-redact',
      init: { model: 'gemini-4-argon-high' },
    });
    // tool_info.output에 키 접두어 시크릿 → 로그 경로
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-redact',
        step_index: 7,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'env' },
          output: `dump ${SECRET_A} and ${SECRET_B} done`,
        },
      },
    });
    // tool_info.error에 시크릿 → errorSnippet DB 경로
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-redact',
        step_index: 8,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'curl https://x' },
          error: `HTTP 401 — ${SECRET_A} rejected (${SECRET_B})`,
        },
      },
    });

    const logs = state.logs.map((l) => l.message).join('\n');
    assert.ok(!logs.includes(SECRET_A), `로그에 평문 시크릿 잔존:\n${logs}`);
    assert.ok(
      !logs.includes('tok-livekey-987654321'),
      `로그에 Bearer 평문 잔존:\n${logs}`
    );
    assert.ok(logs.includes('<redacted>'), '리댁션 마커가 로그에 없음');

    const rows = eventRows(e.dbPath);
    assert.ok(rows.length >= 1, 'DB 표본 부재');
    const snippets = rows.map((r) => String(r['error_snippet'] ?? '')).join('\n');
    assert.ok(!snippets.includes(SECRET_A), `error_snippet 평문 잔존: ${snippets}`);
    assert.ok(!snippets.includes('tok-livekey-987654321'), 'error_snippet Bearer 잔존');
    assert.ok(snippets.includes('<redacted>'), 'error_snippet 리댁션 마커 부재');

    // result 이벤트의 error 경로도 리댁션
    applyAgyEvent(state, {
      event: 'result',
      result: {
        conversation_id: 'c-redact',
        status: 'ERROR',
        error: `fatal: ${SECRET_A}`,
      },
    });
    const logs2 = state.logs.map((l) => l.message).join('\n');
    assert.ok(!logs2.includes(SECRET_A), 'result error 로그에 평문 잔존');
    assert.ok(!state.latestAdvice.includes(SECRET_A), 'latestAdvice 평문 잔존');
  } finally {
    e.restore();
  }
});
