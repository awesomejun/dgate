/**
 * 목적: TUI에 표시되는 역할·모델 라벨이 레거시 하드코딩(Argon·Hydrogen·Carbon·
 * Neon·gemini-4-*)이 아니라 활성 roster.json 바인딩에서 파생되는지 검증한다.
 * - formatRoleBadge: provider/중첩/cli 접두 정리로 간결 태그 생성
 * - createInitialState: 내장 roster(quota-saver) 기본 라벨, gemini-4-* 제로
 * - renderFrame/quad 프레임: DGATE TUI + 실제 라벨 + gemini-4-* 제로
 * - cli --snapshot: builtin 폴백(quota-saver)과 HERDR_ROSTER_PATH 커스텀 로스터 모두 반영
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyDemoTime, createDemoController } from '../src/state/demoEngine.ts';
import { createInitialState, formatRoleBadge } from '../src/state/store.ts';
import { renderFrame } from '../src/ui/renderApp.ts';
import { renderQuadRoleFrame } from '../src/ui/renderQuadRole.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');

function cliEnv(base: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.XDG_CONFIG_HOME = base; // 실제 전역 roster와 격리 → builtin 폴백 유도
  env.GEMINI_TRICK_DB_PATH = path.join(base, 'never.db');
  delete env.DGATE_DB_PATH;
  delete env.DECISION_ORCHESTRATOR_DB_PATH;
  delete env.HERDR_ROSTER_PATH;
  return env;
}

test('1. formatRoleBadge — 간결한 cli:model 태그 생성', () => {
  assert.equal(
    formatRoleBadge({ cli: 'pi', provider: 'opencodex', model: 'glm-zcode/glm-5.3' }),
    'pi:glm-5.3'
  );
  assert.equal(
    formatRoleBadge({
      cli: 'pi',
      provider: 'opencodex',
      model: 'command-code/deepseek-deepseek-v4.1-flash',
    }),
    'pi:deepseek-v4.1-flash'
  );
  assert.equal(formatRoleBadge({ cli: 'devin' }), 'devin');
  assert.equal(
    formatRoleBadge({ cli: 'claude', model: 'claude-sonnet-4-6' }),
    'claude:sonnet-4-6'
  );
  assert.equal(
    formatRoleBadge({ cli: 'agy', model: 'gemini-4-argon-high' }),
    'agy:gemini-4-argon-high'
  );
  assert.equal(formatRoleBadge({ cli: 'custom' }), 'custom');
  assert.equal(formatRoleBadge(undefined), '—');
});

test('2. createInitialState — 내장 roster 라벨 + gemini-4-* 기본값 제로', () => {
  const state = createInitialState('demo');
  const lb = state.rosterLabels;
  assert.equal(lb.profileName, 'quota-saver');
  assert.equal(lb.rosterSource, 'builtin');
  assert.equal(lb.lead, 'pi:glm-5.3');
  assert.equal(lb.explore, 'pi:deepseek-v4.1-flash');
  assert.equal(lb.coder, 'devin');
  assert.equal(lb.verifier, 'pi:deepseek-v4.1-flash');
  assert.equal(lb.advisor, 'pi:glm-5.3');

  for (const field of [
    state.modelName,
    state.modelFlag,
    state.neonModelName,
    state.neonModelFlag,
  ]) {
    assert.ok(!field.includes('gemini-4-'), `legacy model tag leaked: ${field}`);
  }
  for (const card of state.cards) {
    assert.equal(card.model, 'pi:deepseek-v4.1-flash');
  }
});

test('3. renderFrame(148×43) — DGATE TUI + 실제 roster 라벨 + gemini-4-* 제로', () => {
  const state = createInitialState('demo');
  applyDemoTime(state, 10, createDemoController());
  const text = renderFrame(state, 148, 43).toPlainString();

  assert.ok(text.includes('DGATE TUI'), 'header title');
  assert.ok(text.includes('profile=quota-saver'), 'active profile tag');
  assert.ok(text.includes('Lead · pi:glm-5.3'), 'lead panel title + badge');
  assert.ok(text.includes('Workers · pi:deepseek-v4.1-flash / devin'), 'workers legend');
  assert.ok(text.includes('Decision Gate'), 'decision gate role name');
  assert.ok(text.includes('Advisor'), 'advisor role name');
  assert.ok(text.includes('Verifier'), 'verifier role name');
  assert.ok(text.includes('pi:deepseek-v4.1-flash'), 'explore/verifier badge');

  for (const legacy of [
    'gemini-4-',
    'GEMINI CLI SUBAGENT',
    'Argon',
    'Hydrogen',
    'Carbon',
    'Neon',
    'Decision 1',
  ]) {
    assert.ok(!text.includes(legacy), `legacy label leaked into frame: ${legacy}`);
  }
});

test('4. renderQuadRoleFrame — 역할별 roster 라벨 + gemini-4-* 제로', () => {
  const state = createInitialState('demo');
  applyDemoTime(state, 10, createDemoController());

  const argon = renderQuadRoleFrame(state, 'argon', 96, 24).toPlainString();
  assert.ok(argon.includes('LEAD'), 'lead quad header');
  assert.ok(argon.includes('pi:glm-5.3'), 'lead badge in quad');

  const carbon = renderQuadRoleFrame(state, 'carbon', 96, 24).toPlainString();
  assert.ok(carbon.includes('ADVISOR'), 'advisor quad header');
  assert.ok(carbon.includes('pi:glm-5.3'), 'advisor badge in quad');

  const neon = renderQuadRoleFrame(state, 'neon', 96, 24).toPlainString();
  assert.ok(neon.includes('VERIFIER'), 'verifier quad header');
  assert.ok(neon.includes('pi:deepseek-v4.1-flash'), 'verifier badge in quad');

  const hydrogen = renderQuadRoleFrame(state, 'hydrogen', 96, 24).toPlainString();
  assert.ok(hydrogen.includes('WORKERS'), 'workers quad header');
  assert.ok(hydrogen.includes('devin'), 'coder badge in quad');

  for (const frame of [argon, carbon, neon, hydrogen]) {
    assert.ok(!frame.includes('gemini-4-'), 'no gemini-4-* in quad views');
  }
});

test('5. cli --snapshot — builtin 폴백(quota-saver) 시 gemini-4-* 제로', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `rlbl-builtin-${process.pid}-`));
  try {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, '--demo', '--snapshot', '--time', '10', '--cols', '148', '--rows', '43'],
      { env: cliEnv(base), encoding: 'utf8', stdin: 'ignore' }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      res.stdout.includes('DGATE TUI'),
      'new header in cli snapshot'
    );
    assert.ok(res.stdout.includes('profile=quota-saver'), 'builtin profile tag');
    assert.ok(res.stdout.includes('pi:glm-5.3'), 'lead badge rendered');
    assert.ok(!res.stdout.includes('gemini-4-'), 'zero gemini-4-* under builtin roster');
    assert.ok(!res.stdout.includes('GEMINI CLI SUBAGENT'), 'legacy header gone');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('6. cli --snapshot — HERDR_ROSTER_PATH 커스텀 로스터 라벨 실반영', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `rlbl-custom-${process.pid}-`));
  try {
    const rosterPath = path.join(base, 'roster.json');
    fs.writeFileSync(
      rosterPath,
      JSON.stringify({
        defaultProfile: 't-probe',
        profiles: {
          't-probe': {
            roles: {
              lead: { cli: 'claude', model: 'claude-sonnet-4-6' },
              verifier: { cli: 'pi', provider: 'opencodex', model: 'glm-zcode/glm-5.3' },
              advisor: { cli: 'devin' },
            },
          },
        },
      })
    );
    const env = cliEnv(base);
    env.HERDR_ROSTER_PATH = rosterPath;
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, '--demo', '--snapshot', '--time', '10', '--cols', '148', '--rows', '43'],
      { env, encoding: 'utf8', stdin: 'ignore' }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('profile=t-probe'), 'custom profile name in header');
    assert.ok(
      res.stdout.includes('Lead · claude:sonnet-4-6'),
      'live roster lead binding rendered'
    );
    assert.ok(!res.stdout.includes('gemini-4-'), 'zero gemini-4-* under custom roster');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('7. watch 모드 — 읽기전용 배지 + 순 한국어 관측 푸터 (전문용어·가짜 프롬프트 미노출)', () => {
  const state = createInitialState('watch');
  const text = renderFrame(state, 148, 43).toPlainString();

  assert.ok(text.includes('[읽기전용 관측 · WATCH]'), 'watch read-only mode badge');
  assert.ok(text.includes('관측 전용'), 'honest read-only footer status hint');
  assert.ok(text.includes('작업 지시: AI 채팅창에서 요청'), 'plain-Korean dispatch hint in footer');
  assert.ok(!text.includes('/명령어 입력'), 'fake interactive prompt hidden in watch mode');
  assert.ok(!text.includes('dg / dispatch.ts'), 'no raw dg/dispatch.ts jargon in footer');
});

test('8. help 모달 — 쉬운 한국어 안내 + 고급 터미널 명령 하단 분리', () => {
  const state = createInitialState('watch');
  state.modal = 'help';
  const text = renderFrame(state, 148, 43).toPlainString();

  assert.ok(text.includes('이 화면은 뭔가요?'), 'plain-Korean role clarity header');
  assert.ok(text.includes('AI 채팅창에서'), 'work request points to the AI chat window');
  assert.ok(text.includes('고급 · 터미널 직접 제어'), 'CLI details kept under the advanced section');
});
