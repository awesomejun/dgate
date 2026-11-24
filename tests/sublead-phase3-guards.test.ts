/**
 * Sublead Phase 3 — 권한·가드 물리 검증 테스트(docs/sublead-design.md 항목 5·8).
 *
 * 실행: `node --test tests/sublead-phase3-guards.test.ts`
 * 범위:
 * - `normalizeModelFamily`: 다양한 CLI/프로바이더 표기 → 모델 계열 정규화
 * - `subleadBackpropViolation`: 비-sublead 무회귀, 소유 불일치/미설정 거부, 동종 producer 거부, 이종 통과
 * - `.agents/hooks/dg-hook.ts --guard`: `HERDR_ROLE=sublead` 기본 머지 금지(HERDR_MERGE_GATE 무관), 피처 브랜치 푸시 허용
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';
import { normalizeModelFamily, subleadBackpropViolation } from '../src/decision/verdict.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOOK_PATH = path.join(REPO_ROOT, '.agents', 'hooks', 'dg-hook.ts');

test('normalizeModelFamily — CLI/프로바이더 표기 정규화 테이블', () => {
  const cases = [
    ['opencodex/glm-zcode/glm-5.3', 'glm'],
    ['pi:glm-5.3', 'glm'],
    ['devin/swe-2-max', 'swe'],
    ['Claude Opus 5.5 (Medium)', 'claude'],
    ['gemini-4-neon', 'gemini'],
    ['openai-codex/gpt-6.2-sol', 'gpt'],
    ['command-code/deepseek-deepseek-v4.1-flash', 'deepseek'],
    ['', null],
    [null, null],
  ] as const;
  for (const [input, expected] of cases) {
    assert.equal(normalizeModelFamily(input), expected, `model=${String(input)}`);
  }
});

test('subleadBackpropViolation — (a)~(e) 비-sublead 무회귀·소유 일치·이종 verifier 강제', () => {
  // (a) 최상위 리드/미지정 역할은 검사 스킵(회귀 0)
  assert.equal(
    subleadBackpropViolation({
      callerRole: 'lead',
      callerConversation: null,
      forkConversation: 'conv-other',
      producerModel: null,
      hasVerdict: true,
    }),
    null
  );
  assert.equal(
    subleadBackpropViolation({
      callerRole: null,
      hasVerdict: true,
    }),
    null
  );

  // (b) sublead: HERDR_CONVERSATION 미설정 또는 불일치 → 거부
  assert.ok(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: null,
      forkConversation: 'conv-a',
      producerModel: 'glm-5.3',
      hasVerdict: true,
    })
  );
  assert.ok(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: 'conv-a',
      forkConversation: 'conv-b',
      producerModel: 'glm-5.3',
      hasVerdict: true,
    })
  );
  assert.ok(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: 'conv-a',
      forkConversation: 'conv-b',
      hasVerdict: false,
    })
  );

  // (c) sublead + verdict: producer_model 누락 → 거부
  assert.ok(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: 'conv-a',
      forkConversation: 'conv-a',
      callerModel: 'gemini-4-neon',
      coderModel: 'devin/swe-2-max',
      producerModel: null,
      hasVerdict: true,
    })
  );

  // (d) sublead + verdict: sublead 또는 coder와 동종 모델 → 거부
  assert.ok(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: 'conv-a',
      forkConversation: 'conv-a',
      callerModel: 'pi:glm-5.3',
      coderModel: 'devin/swe-2-max',
      producerModel: 'glm-zcode/glm-5.3',
      hasVerdict: true,
    })
  );
  assert.ok(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: 'conv-a',
      forkConversation: 'conv-a',
      callerModel: 'gemini-4-neon',
      coderModel: 'devin/swe-2-max',
      producerModel: 'swe-2-max',
      hasVerdict: true,
    })
  );

  // (e) sublead + 소유 일치 + 이종 verifier → 통과
  assert.equal(
    subleadBackpropViolation({
      callerRole: 'sublead',
      callerConversation: 'conv-a',
      forkConversation: 'conv-a',
      callerModel: 'gemini-4-neon',
      coderModel: 'devin/swe-2-max',
      producerModel: 'glm-zcode/glm-5.3',
      hasVerdict: true,
    }),
    null
  );
});

test('dg-hook.ts --guard — HERDR_ROLE=sublead 기본 머지 금지(HERDR_MERGE_GATE 무관), 피처 푸시 허용', () => {
  function runGuard(command: string, envOver: Record<string, string | undefined>) {
    const payload = JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: command } },
      cwd: REPO_ROOT,
    });
    const env = { ...process.env };
    delete env.HERDR_MERGE_GATE;
    delete env.HERDR_READONLY;
    delete env.HERDR_DELEGATE_MODE;
    delete env.HERDR_ROLE;
    for (const [k, v] of Object.entries(envOver)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const res = spawnSync(process.execPath, [HOOK_PATH, '--guard'], {
      input: payload,
      encoding: 'utf8',
      env,
    });
    assert.equal(res.status, 0);
    return JSON.parse(res.stdout) as { decision: string; reason?: string };
  }

  // sublead는 HERDR_MERGE_GATE 없이도 gh pr merge · git push main · git merge 차단
  assert.equal(runGuard('gh pr merge 42 --squash', { HERDR_ROLE: 'sublead' }).decision, 'deny');
  assert.equal(runGuard('git push origin main', { HERDR_ROLE: 'sublead' }).decision, 'deny');
  assert.equal(runGuard('git merge feat/auth', { HERDR_ROLE: 'sublead' }).decision, 'deny');
  // 피처 브랜치 푸시(READY_PR 핸드오프용)는 허용
  assert.equal(runGuard('git push -u origin feat/auth', { HERDR_ROLE: 'sublead' }).decision, 'allow');
  // 최상위 리드(HERDR_MERGE_GATE 미설정)는 기존 동작 유지(허용)
  assert.equal(runGuard('git merge feat/auth', { HERDR_ROLE: 'lead' }).decision, 'allow');
});
