/**
 * W2-A 백엔드 수집 파이프라인 멱등·에러 판정 통합 테스트 (brief-w2a §5.1~§5.2).
 *
 * 목적: agyStreamMapper·transcriptMapper·agentRunner(REST 폴백)가 SQLite SSOT에
 * 중복 없이 1회씩만 기록하고, N5(step_index)·B6(M>1 귀속)·N6(본문 에러 판정)·
 * 자기 호출 제외·데모 격리 가드를 지키는지 자동 검증한다.
 *
 * 실행: `node --test tests/mappers-idempotency.test.ts`
 * 주의: 각 테스트는 고유 임시 GEMINI_TRICK_DB_PATH·임시 transcript를 쓰고,
 * 매퍼는 process.cwd() 프로젝트로 귀속되므로 전역 풀 오염이 없다.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openDb, resolveProjectIdentity } from '../src/decision/db.ts';
import { markHookCoverage } from '../src/decision/telemetry.ts';
import { createInitialState } from '../src/state/store.ts';
import { applyAgyEvent } from '../src/backend/agyStreamMapper.ts';
import {
  applyTranscriptStep,
  attachTranscriptWatcher,
  type TranscriptStep,
  type TranscriptToolCall,
} from '../src/backend/transcriptMapper.ts';
import { AgentRunner } from '../src/backend/agentRunner.ts';
import type { AppState, RunMode } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 환경 스캐폴딩

interface TestEnv {
  base: string;
  dbPath: string;
  prevDb: string | undefined;
  restore: () => void;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `w2a-${process.pid}-`));
  const dbPath = path.join(base, 'decision.db');
  const prevDb = process.env.GEMINI_TRICK_DB_PATH;
  const prevDgateDb = process.env.DGATE_DB_PATH;
  const prevDoDb = process.env.DECISION_ORCHESTRATOR_DB_PATH;
  process.env.GEMINI_TRICK_DB_PATH = dbPath;
  delete process.env.DGATE_DB_PATH;
  delete process.env.DECISION_ORCHESTRATOR_DB_PATH;
  return {
    base,
    dbPath,
    prevDb,
    restore() {
      if (prevDb === undefined) delete process.env.GEMINI_TRICK_DB_PATH;
      else process.env.GEMINI_TRICK_DB_PATH = prevDb;
      if (prevDgateDb === undefined) delete process.env.DGATE_DB_PATH;
      else process.env.DGATE_DB_PATH = prevDgateDb;
      if (prevDoDb === undefined) delete process.env.DECISION_ORCHESTRATOR_DB_PATH;
      else process.env.DECISION_ORCHESTRATOR_DB_PATH = prevDoDb;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function newState(mode: RunMode): AppState {
  return createInitialState(mode);
}

// ---------------------------------------------------------------------------
// transcript fixture

function userStep(idx: number, text = '작업 지시'): TranscriptStep {
  return {
    step_index: idx,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-11-19T09:00:00Z',
    content: `<USER_REQUEST>${text}</USER_REQUEST>`,
  };
}

function plannerStep(idx: number, toolCalls: TranscriptToolCall[]): TranscriptStep {
  return {
    step_index: idx,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-19T09:00:01Z',
    model: 'gemini-4-argon-high',
    tool_calls: toolCalls,
  };
}

function genericStep(
  idx: number,
  status: string,
  body: string,
  error?: string
): TranscriptStep {
  return {
    step_index: idx,
    source: 'MODEL',
    type: 'GENERIC',
    status,
    created_at: '2026-11-19T09:00:02Z',
    content: `Created At: 2026-11-19T18:00:02+09:00\nCompleted At: 2026-11-19T18:00:03+09:00\n${body}`,
    ...(error ? { error } : {}),
  };
}

function writeTranscript(base: string, convId: string, steps: TranscriptStep[]): string {
  const dir = path.join(base, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return file;
}

/** watcher 경유 — 파일 경로에서 conversationId 자동 추출 + 초기 동기 파싱 */
function parseViaWatcher(file: string, state: AppState): void {
  const stop = attachTranscriptWatcher(file, state, () => {});
  stop();
}

// ---------------------------------------------------------------------------
// DB 단정 헬퍼

function queryAll(dbPath: string, sql: string, params: (string | number | null)[] = []): Record<string, unknown>[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDb(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function eventRows(dbPath: string, where = '', params: (string | number | null)[] = []): Record<string, unknown>[] {
  return queryAll(dbPath, `SELECT * FROM decision_events ${where} ORDER BY event_id`, params);
}

function eventCount(dbPath: string, where = '', params: (string | number | null)[] = []): number {
  const rows = queryAll(dbPath, `SELECT COUNT(*) AS n FROM decision_events ${where}`, params);
  return (rows[0]?.['n'] as number) ?? 0;
}

// ---------------------------------------------------------------------------

test('1. agyStreamMapper: ACTIVE+DONE(error) → totalForks +1(이중카운트 0), 로그 split, DB 1건', () => {
  const e = makeEnv();
  try {
    const state = newState('live');
    applyAgyEvent(state, { event: 'init', conversation_id: 'c-ag-1', init: { model: 'gemini-4-argon-high' } });
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-ag-1',
        step_index: 5,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'git status' } },
      },
    });
    assert.equal(state.totalForks, 1, 'ACTIVE에서 1회 가산');
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-ag-1',
        step_index: 5,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'git status' },
          error: 'exit 128',
        },
      },
    });
    assert.equal(state.totalForks, 1, 'DONE 재가산 없음 — 이중 카운트 버그 회귀');
    const logs = state.logs.map((l) => l.message).join('\n');
    assert.ok(logs.includes('split'), `로그에 split 표기 필요:\n${logs}`);
    assert.equal(eventCount(e.dbPath), 1, 'DB 표본 1건');
    const row = eventRows(e.dbPath)[0]!;
    assert.equal(row['source'], 'agy_stream');
    assert.equal(row['ok'], 0);
    assert.equal(row['route'], 'tool_select');
    assert.equal(row['tool_class'], 'shell_exec');
    assert.equal(row['dedupe_key'], 'agy:c-ag-1:5');
    assert.equal(row['conversation_id'], 'c-ag-1');
  } finally {
    e.restore();
  }
});

test('2. agyStreamMapper [N5]: step_index 누락 → DB 기록 0건(totalForks 폴백 금지)', () => {
  const e = makeEnv();
  try {
    const state = newState('live');
    applyAgyEvent(state, { event: 'init', conversation_id: 'c-n5', init: {} });
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-n5',
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: { name: 'read_file', parameters: { Path: 'src/a.ts' } },
      },
    });
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-n5',
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: { name: 'read_file', parameters: { Path: 'src/a.ts' } },
      },
    });
    assert.equal(eventCount(e.dbPath), 0, 'step_index 없이는 멱등 키 불가 — 기록 생략');
  } finally {
    e.restore();
  }
});

test('3. transcriptMapper: 동일 transcript.jsonl 2회 재파싱 → raw_samples 중복 0건', () => {
  const e = makeEnv();
  try {
    const convId = 'conv-tx-1';
    const file = writeTranscript(e.base, convId, [
      userStep(0),
      plannerStep(1, [{ name: 'run_command', args: { CommandLine: 'git status' } }]),
      genericStep(2, 'DONE', 'Command exited with code 0.\n\nCommand output:\nok'),
    ]);
    const s1 = newState('watch');
    parseViaWatcher(file, s1);
    assert.equal(eventCount(e.dbPath), 1, '첫 파싱 1건');
    const s2 = newState('watch');
    parseViaWatcher(file, s2);
    assert.equal(eventCount(e.dbPath), 1, '재파싱 후에도 1건 — 멱등 키 중복 차단');
    const dupes = queryAll(
      e.dbPath,
      `SELECT dedupe_key, COUNT(*) AS n FROM decision_events GROUP BY dedupe_key HAVING n > 1`
    );
    assert.equal(dupes.length, 0, 'dedupe_key 중복 행 0');
  } finally {
    e.restore();
  }
});

test('4. transcriptMapper: has_hook_coverage=1 마킹 후 재스캔 → DB 쓰기 0건', () => {
  const e = makeEnv();
  try {
    const convId = 'conv-hook';
    const file = writeTranscript(e.base, convId, [
      userStep(0),
      plannerStep(1, [{ name: 'run_command', args: { CommandLine: 'git status' } }]),
      genericStep(2, 'DONE', 'Command exited with code 0.\n\nCommand output:\nok'),
    ]);
    parseViaWatcher(file, newState('watch'));
    assert.equal(eventCount(e.dbPath), 1);
    const { projectId } = resolveProjectIdentity(process.cwd());
    markHookCoverage(e.dbPath, convId, projectId);
    parseViaWatcher(file, newState('watch'));
    assert.equal(eventCount(e.dbPath), 1, '훅 커버리지 마킹 후 재스캔 → 추가 쓰기 0건');
  } finally {
    e.restore();
  }
});

test('5. transcriptMapper [B6]: M=3 혼합 tool_calls ↔ GENERIC 3개 순서 1:1 귀속 + 불일치 skip', () => {
  const e = makeEnv();
  try {
    const convId = 'conv-b6';
    const file = writeTranscript(e.base, convId, [
      userStep(0),
      plannerStep(10, [
        { name: 'read_file', args: { Path: 'src/a.ts' } },
        { name: 'run_command', args: { CommandLine: 'pnpm test' } },
        { name: 'grep_search', args: { Query: 'foo' } },
      ]),
      genericStep(11, 'DONE', 'Showing lines 1-2 of 2\n1: const a = 1;\n2: export { a };'),
      genericStep(12, 'DONE', 'Command exited with code 0.\n\nCommand output:\nok'),
      genericStep(13, 'DONE', 'src/a.ts:3:foo'),
    ]);
    parseViaWatcher(file, newState('watch'));
    const rows = eventRows(e.dbPath, `WHERE conversation_id = ?`, [convId]);
    assert.equal(rows.length, 3, 'GENERIC 3개 → 표본 3건');
    assert.deepEqual(
      rows.map((r) => r['tool_name']),
      ['read_file', 'run_command', 'grep_search'],
      '발행 순서대로 tool_calls[k] ↔ k번째 GENERIC'
    );
    assert.deepEqual(
      rows.map((r) => `${r['route']}|${r['tool_class']}`),
      ['file_select|file_read', 'tool_select|shell_exec', 'tool_select|code_search']
    );
    assert.deepEqual(
      rows.map((r) => r['dedupe_key']),
      ['tx:conv-b6:10:0', 'tx:conv-b6:10:1', 'tx:conv-b6:10:2']
    );
    assert.ok(
      rows.every((r) => r['ok'] === 1 && r['source'] === 'transcript'),
      '전부 성공·transcript 소스'
    );

    // 개수 불일치 — M=3인데 GENERIC 2개만 도착하면 배치 전체 보수적 생략
    const conv2 = 'conv-b6-short';
    const file2 = writeTranscript(e.base, conv2, [
      userStep(0),
      plannerStep(10, [
        { name: 'read_file', args: { Path: 'src/a.ts' } },
        { name: 'run_command', args: { CommandLine: 'pnpm test' } },
        { name: 'grep_search', args: { Query: 'foo' } },
      ]),
      genericStep(11, 'DONE', 'Showing lines 1-1 of 1\n1: x'),
      genericStep(12, 'DONE', 'Command exited with code 0.'),
      userStep(20, '다음 작업'),
    ]);
    parseViaWatcher(file2, newState('watch'));
    assert.equal(
      eventCount(e.dbPath, `WHERE conversation_id = ?`, [conv2]),
      0,
      'GENERIC 개수 불일치 → 배치 DB 기록 생략'
    );
  } finally {
    e.restore();
  }
});

test('6. transcriptMapper [N6]: Created At 헤더 뒤 본문 판정 — ERROR·exit code 2 탐지 + 소스 "Error" 오탐 0', () => {
  const e = makeEnv();
  try {
    const convId = 'conv-n6';
    const file = writeTranscript(e.base, convId, [
      userStep(0),
      plannerStep(5, [
        { name: 'edit_file', args: { Path: 'src/b.ts' } },
        { name: 'run_command', args: { CommandLine: 'pnpm build' } },
        { name: 'read_file', args: { Path: 'src/c.ts' } },
      ]),
      // ① status=ERROR — 툴 실행 실패
      genericStep(
        6,
        'ERROR',
        'Encountered error in step execution: target content not found in the file',
        'target content not found in the file'
      ),
      // ② status=DONE인데 본문에 비정상 종료 코드 — 소프트 에러
      genericStep(7, 'DONE', 'Command exited with code 2.\n\nCommand output:\ncompile failed'),
      // ③ 정상 read_file — 소스 본문에 "Error: fake" 포함돼도 오탐 금지
      genericStep(
        8,
        'DONE',
        'Showing lines 1-4 of 4\n1: export const msg = "Error: fake";\n2: export const code = 0;\n3: // Command exited with code 0.\n4: '
      ),
    ]);
    parseViaWatcher(file, newState('watch'));
    const rows = eventRows(e.dbPath, `WHERE conversation_id = ?`, [convId]);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r['ok']),
      [0, 0, 1],
      `ok 판정 [ERROR, exit 2, 정상 read_file] — 기대 [0,0,1], 실제 ${JSON.stringify(rows.map((r) => r['ok']))}`
    );
    assert.equal(rows[1]!['error_snippet'], 'exit code 2');
  } finally {
    e.restore();
  }
});

test('7. agentRunner REST 폴백: {error} → consecutiveToolErrors+DB 기록, 2연속 시 activeTrigger=1', async () => {
  const e = makeEnv();
  const prevKey = process.env.GEMINI_API_KEY;
  const origFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    let callNum = 0;
    globalThis.fetch = (async () => {
      callNum += 1;
      const body =
        callNum === 1
          ? {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      { functionCall: { name: 'read_file', args: { path: '__missing_1__.txt' } } },
                      { functionCall: { name: 'read_file', args: { path: '__missing_2__.txt' } } },
                    ],
                  },
                },
              ],
            }
          : {
              candidates: [{ content: { role: 'model', parts: [{ text: '완료' }] } }],
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const state = newState('live');
    const runner = new AgentRunner({ preference: 'api', autoApprove: true });
    assert.equal(runner.backend, 'gemini-api');
    // 게이트 점등(activeTrigger=1)은 2연속 오류 시점에 발생하고, 턴 완료 시
    // 최종 점검(2)으로 덮어쓴다 — 점등 순간을 onUpdate 스냅숏으로 관측한다.
    const triggerSeen = new Set<number>();
    await runner.runPrompt('파일 두 개 읽어줘', state, () => {
      triggerSeen.add(state.activeTrigger);
    });

    assert.equal(state.consecutiveToolErrors, 2, '2연속 {error} 누적');
    assert.ok(triggerSeen.has(1), '같은 오류 2회 → Pre-Lead Gate 점등(activeTrigger=1) 관측');
    assert.equal(state.advisorState, '자문 중');
    assert.ok(state.carbonCalls >= 1);
    const rows = eventRows(e.dbPath, `WHERE source = 'rest_api'`);
    assert.equal(rows.length, 2, 'REST 폴백 결과 2건 기록');
    assert.ok(rows.every((r) => r['ok'] === 0 && r['source'] === 'rest_api'));
    assert.ok(rows.every((r) => r['route'] === 'file_select' && r['tool_class'] === 'file_read'));
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    e.restore();
  }
});

test('8. 자기 호출 제외 (B6): run_command argv에 src/decision/dg.ts → DB 표본 0건', () => {
  const e = makeEnv();
  try {
    const state = newState('live');
    applyAgyEvent(state, { event: 'init', conversation_id: 'c-self', init: {} });
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-self',
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: {
            CommandLine:
              'node ./src/decision/dg.ts record --route tool_select --tool-class shell_exec --ok 1',
          },
          output: 'ok',
        },
      },
    });
    assert.equal(eventCount(e.dbPath), 0, 'dg.ts 자기 호출은 engine이 표본에서 제외');
  } finally {
    e.restore();
  }
});

test('9. --demo 격리: mode=demo에서 매퍼 호출 → DB 파일 미생성/행수 0', () => {
  const e = makeEnv();
  try {
    const state = newState('demo');
    applyAgyEvent(state, { event: 'init', conversation_id: 'c-demo', init: {} });
    applyAgyEvent(state, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-demo',
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
      },
    });
    applyTranscriptStep(
      state,
      plannerStep(1, [{ name: 'run_command', args: { CommandLine: 'ls' } }])
    );
    applyTranscriptStep(state, genericStep(2, 'DONE', 'Command exited with code 0.'));
    assert.equal(fs.existsSync(e.dbPath), false, 'demo 모드는 DB 파일을 만들지 않는다');
    assert.equal(eventCount(e.dbPath), 0);
  } finally {
    e.restore();
  }
});

test('10. transcriptMapper 통계 시한: 10분 초과 과거 재생 → 행만 기록(EWMA 미반영), 최근 → 반영', () => {
  const e = makeEnv();
  try {
    // ① 1시간 전 과거 대화(시작 시 꼬리 재생 시나리오) — 감사 행은 남기고 EWMA 미반영
    const staleTs = new Date(Date.now() - 60 * 60_000).toISOString();
    const staleFile = writeTranscript(e.base, 'conv-stale-replay', [
      { ...userStep(0), created_at: staleTs },
      { ...plannerStep(1, [{ name: 'run_command', args: { CommandLine: 'git status' } }]), created_at: staleTs },
      { ...genericStep(2, 'DONE', 'Command exited with code 0.\n\nCommand output:\nok'), created_at: staleTs },
    ]);
    parseViaWatcher(staleFile, newState('watch'));
    assert.equal(eventCount(e.dbPath), 1, '과거 재생도 감사 이벤트 행은 기록');
    const staleStats = queryAll(e.dbPath, `SELECT COUNT(*) AS n FROM stats_summary`);
    assert.equal((staleStats[0]?.['n'] as number) ?? 0, 0, '10분 초과 과거 이벤트는 EWMA 대상 아님');

    // ② 30초 전 최근 이벤트 — EWMA 반영
    const freshTs = new Date(Date.now() - 30_000).toISOString();
    const freshFile = writeTranscript(e.base, 'conv-fresh-live', [
      { ...userStep(0), created_at: freshTs },
      { ...plannerStep(1, [{ name: 'run_command', args: { CommandLine: 'git log --oneline -1' } }]), created_at: freshTs },
      { ...genericStep(2, 'DONE', 'Command exited with code 0.\n\nCommand output:\nok'), created_at: freshTs },
    ]);
    parseViaWatcher(freshFile, newState('watch'));
    assert.equal(eventCount(e.dbPath), 2, '최근 이벤트도 1행 기록');
    const freshStats = queryAll(
      e.dbPath,
      `SELECT SUM(raw_samples) AS total FROM stats_summary WHERE route = 'tool_select' AND tool_class = 'shell_exec'`
    );
    assert.equal((freshStats[0]?.['total'] as number) ?? 0, 2, '최근 이벤트는 프로젝트+전역풀 EWMA에 반영');
  } finally {
    e.restore();
  }
});
