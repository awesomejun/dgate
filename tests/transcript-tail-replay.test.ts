/**
 * w-tui-fast-startup — attachTranscriptWatcher 초기 재생 성능·정확성 테스트.
 *
 * 목적: 대형 transcript.jsonl(>300KB, 수백 줄)에서 초기 리플레이가
 * 256 KiB 꼬리 캡 + SSOT 배치 동기화로 500ms 안에 끝나고, 마지막 이벤트가
 * 상태에 정확히 복원되는지 검증한다.
 *
 * 실행: `node --test tests/transcript-tail-replay.test.ts`
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createInitialState } from '../src/state/store.ts';
import { attachTranscriptWatcher } from '../src/backend/transcriptMapper.ts';

function step(idx: number): string {
  if (idx % 5 === 0) {
    // PLANNER_RESPONSE — 도구 호출 포함
    return JSON.stringify({
      step_index: idx,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 0, 1) + idx * 1000).toISOString(),
      model: 'gemini-4-argon-high',
      tool_calls: [{ name: 'run_command', args: { CommandLine: `echo ${idx}` } }],
    });
  }
  if (idx % 5 === 1) {
    // GENERIC — 도구 결과
    return JSON.stringify({
      step_index: idx,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 0, 1) + idx * 1000).toISOString(),
      content: `Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:01Z\necho ${idx} done`,
    });
  }
  if (idx % 5 === 4) {
    // PLANNER_RESPONSE — 텍스트 응답 완료
    return JSON.stringify({
      step_index: idx,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 0, 1) + idx * 1000).toISOString(),
      content: `응답 완료 ${idx}`,
    });
  }
  // PLANNER_RESPONSE — thinking
  return JSON.stringify({
    step_index: idx,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: new Date(Date.UTC(2026, 0, 1) + idx * 1000).toISOString(),
    thinking: `생각 ${idx}. 다음 문장.`,
  });
}

test('대형 transcript(>300KB) 초기 재생이 500ms 미만이며 최신 꼬리 이벤트를 정확히 복원한다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tail-replay-${process.pid}-`));
  const prevDb = process.env.GEMINI_TRICK_DB_PATH;
  process.env.GEMINI_TRICK_DB_PATH = path.join(base, 'decision.db');
  try {
    const dir = path.join(base, 'brain', 'conv-tail', '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript.jsonl');

    // 수백 줄 · >300KB JSONL 생성 — 각 줄이 충분히 커야 256 KiB 캡을 넘는다
    const padLen = 2048;
    const lines: string[] = [];
    for (let i = 1; i <= 399; i++) {
      const raw = JSON.parse(step(i)) as Record<string, unknown>;
      // content/thinking 패딩으로 파일 크기 확보 — JSON 구조는 그대로
      if (typeof raw.thinking === 'string') {
        raw.thinking = raw.thinking + ' 패딩'.repeat(padLen / 8);
      } else if (typeof raw.content === 'string') {
        raw.content = raw.content + ' 패딩'.repeat(padLen / 8);
      } else {
        (raw.tool_calls as { args: Record<string, unknown> }[])[0].args['CommandLine'] =
          `echo ${i} && ` + 'x'.repeat(padLen);
      }
      lines.push(JSON.stringify(raw));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const size = fs.statSync(file).size;
    assert.ok(size > 300 * 1024, `파일이 300KB 초과여야 함 (actual=${size})`);

    const state = createInitialState('live');
    const t0 = performance.now();
    const stop = attachTranscriptWatcher(file, state, () => {});
    const elapsed = performance.now() - t0;
    stop();

    assert.ok(elapsed < 500, `초기 재생이 500ms 미만이어야 함 (actual=${elapsed.toFixed(1)}ms)`);

    // 마지막 스텝(400, PLANNER_RESPONSE 텍스트 완료)이 꼬리 캡 안에 복원되었는지 검증
    assert.equal(state.phase, '완료');
    assert.equal(state.agentBusy, false);
    assert.ok(
      typeof state.backSummary === 'string' && state.backSummary.includes('응답 완료'),
      `최신 응답 요약 복원 실패 (backSummary=${state.backSummary})`
    );
    // 399번 스텝은 idx%5===4 → 도구 없는 완료 턴 — 최근 로그에 완료 기록 존재
    assert.ok(state.logs.length > 0, '재생 후 로그가 비어 있으면 안 됨');

    console.log(`replay_ms=${elapsed.toFixed(1)} size=${size} lines=399`);
  } finally {
    if (prevDb === undefined) delete process.env.GEMINI_TRICK_DB_PATH;
    else process.env.GEMINI_TRICK_DB_PATH = prevDb;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
