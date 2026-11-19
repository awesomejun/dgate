/**
 * `tests/setup-wizard.test.ts` — setup.ts 온보딩 위저드 결정적 단위·e2e 테스트 (brief-setup-wizard §5).
 *
 * 목적: ① 설치 CLI 조합별 `recommendRosterProfile` 추천 행렬(agy 절대 기본 미선택),
 * ② `buildTailoredRosterConfig` 7개 프로필 전부 `loadRosterConfig` 무경고 검증,
 * ③ 임시 `$HOME`에서 `detectEnvironment` 동반자 도구 감지, ④ `installSkillLinks`
 * 멱등 심볼릭 링크, ⑤ `installRepoHooks` canonical 훅 + `.git/info/exclude`,
 * ⑥ `--check --json` e2e exit 0·유효 JSON·쓰기 0·시크릿 누출 0.
 * v2 추가: ⑧ `discoverAvailableModels` 로컬 설정 파싱(시크릿 누출 0·agy 미포함)
 * ⑨ `extractModelFamily`+`checkCrossVerificationDiversity` 계열 다양성 경고
 * ⑩ `modelChoiceToRoleSpec` 맞춤 프로필 `loadRosterConfig` 무경고·pi 필드 누출 0.
 *
 * 실행: `node --test tests/setup-wizard.test.ts` (외부 의존성 0개)
 *
 * 주의: 모든 검출은 `pathDirs`/`systemDirs: []`/`homeDir`(임시 mkdtemp) 주입으로
 * 실제 `$HOME`·실제 PATH에 전혀 닿지 않는다. e2e는 `HOME`/`XDG_*` env를 임시로
 * 고정해 스폰 프로세스의 `os.homedir()`도 격리한다.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadRosterConfig } from '../src/decision/roster.ts';
import type { RoleSlot, RoleWorkerSpec, RosterConfig } from '../src/decision/roster.ts';
import {
  CLI_IDS,
  TAILORED_PROFILE_NAMES,
  buildTailoredRosterConfig,
  checkCrossVerificationDiversity,
  classifyModelTier,
  detectEnvironment,
  discoverAvailableModels,
  extractModelFamily,
  formatCheckReport,
  installRepoHooks,
  installSkillLinks,
  modelChoiceToRoleSpec,
  recommendRosterProfile,
} from '../scripts/setup.ts';
import type { CliDetection, CliId, DiscoveredModel } from '../scripts/setup.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SETUP_PATH = path.join(REPO_ROOT, 'scripts', 'setup.ts');
const ROLE_SLOTS = ['lead', 'explore', 'coder', 'verifier', 'advisor'] as const;

// ---------- helpers ----------

function mkClis(...installed: string[]): Record<CliId, CliDetection> {
  const out = {} as Record<CliId, CliDetection>;
  for (const id of CLI_IDS) {
    const on = installed.includes(id);
    out[id] = { installed: on, path: on ? `/fake/bin/${id}` : null };
  }
  return out;
}

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `setupw-${process.pid}-`));
}

function touchExec(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(p, 0o755);
}

function writeSkill(homeDir: string, agentDir: string, skill: string): string {
  const p = path.join(homeDir, agentDir, 'skills', skill, 'SKILL.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `# ${skill}\n`);
  return p;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// ---------- 1. recommendRosterProfile 행렬 ----------

test('1. recommendRosterProfile — 설치 CLI 조합별 결정적 추천 (agy 절대 자동 미선택)', () => {
  // hc 부재 → 무조건 standalone
  assert.equal(recommendRosterProfile(mkClis()).mode, 'standalone');
  assert.equal(recommendRosterProfile(mkClis('claude', 'codex', 'devin', 'pi', 'gemini')).mode, 'standalone');
  // hc + 워커 0개 (agy만으로는 워커가 아님) → standalone
  assert.equal(recommendRosterProfile(mkClis('hc')).mode, 'standalone');
  assert.equal(recommendRosterProfile(mkClis('hc', 'agy')).mode, 'standalone');

  // hc + 단일 워커
  assert.equal(recommendRosterProfile(mkClis('hc', 'claude')).profileName, 'claude-only');
  assert.equal(recommendRosterProfile(mkClis('hc', 'codex')).profileName, 'codex-only');
  assert.equal(recommendRosterProfile(mkClis('hc', 'devin')).profileName, 'devin-only');
  assert.equal(recommendRosterProfile(mkClis('hc', 'pi')).profileName, 'pi-only');
  assert.equal(recommendRosterProfile(mkClis('hc', 'gemini')).profileName, 'gemini-only');
  // hc + claude + codex → claude-codex
  assert.equal(recommendRosterProfile(mkClis('hc', 'claude', 'codex')).profileName, 'claude-codex');
  // hc + pi + devin → zero-agy (최우선)
  assert.equal(recommendRosterProfile(mkClis('hc', 'pi', 'devin')).profileName, 'zero-agy');
  assert.equal(
    recommendRosterProfile(mkClis('hc', 'pi', 'devin', 'claude', 'codex')).profileName,
    'zero-agy',
    'pi+devin 조합이 다른 조합보다 우선한다',
  );
  // hc + agy + claude → 여전히 claude-only (agy는 절대 자동 선택 금지)
  const recAgy = recommendRosterProfile(mkClis('hc', 'agy', 'claude'));
  assert.equal(recAgy.profileName, 'claude-only');
  assert.equal(recAgy.agy, 0);
  for (const slot of ROLE_SLOTS) assert.ok(!recAgy.roles[slot].includes('agy'), `${slot} must not use agy`);
  // 미설치 CLI는 추천되지 않는다 — gemini만 있으면 claude 등이 역할에 등장하지 않는다
  const recGem = recommendRosterProfile(mkClis('hc', 'gemini'));
  for (const slot of ROLE_SLOTS) assert.ok(recGem.roles[slot].includes('gemini'), `${slot} must be gemini`);
});

// ---------- 2. buildTailoredRosterConfig → loadRosterConfig 무경고 ----------

test('2. buildTailoredRosterConfig — 7개 프로필 전부 loadRosterConfig warnings=0·agy=0', () => {
  assert.equal(TAILORED_PROFILE_NAMES.length, 7);
  const tmp = makeHome();
  try {
    for (const name of TAILORED_PROFILE_NAMES) {
      const cfg = buildTailoredRosterConfig(name);
      assert.ok(cfg, `${name} config expected`);
      assert.equal(cfg!.defaultProfile, name);
      const file = path.join(tmp, `roster-${name}.json`);
      fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

      const loaded = loadRosterConfig({ rosterPath: file });
      assert.equal(loaded.warnings.length, 0, `${name}: ${loaded.warnings.join('; ')}`);
      assert.equal(loaded.config.defaultProfile, name);
      const prof = loaded.config.profiles[name]!;
      assert.ok(prof, `merged profile ${name} must exist`);
      assert.equal(prof.dailyTurnBudgets?.agy ?? 0, 0, `${name} must keep agy: 0`);
      for (const slot of ROLE_SLOTS) {
        const spec = prof.roles[slot];
        assert.ok(spec, `${name}.${slot} missing`);
        assert.notEqual(spec.cli, 'agy', `${name}.${slot} must never use agy`);
      }
    }
    // 내장 quota-saver 병합 시 pi 전용 필드가 비-pi 스펙으로 새지 않는다 (빈 문자열 차단)
    const claudeOnly = loadRosterConfig({ rosterPath: path.join(tmp, 'roster-claude-only.json') });
    const adv = claudeOnly.config.profiles['claude-only']!.roles.advisor!;
    assert.equal(adv.cli, 'claude');
    assert.equal(adv.model, '', 'claude advisor must not inherit pi model glm-zcode');
    assert.equal(adv.quotaBucket, 'claude', 'claude advisor must not inherit pi quota bucket');
    const codexExplore = claudeOnly.config.profiles['claude-only']!.roles.explore!;
    assert.equal(codexExplore.cli, 'claude');
    // zero-agy는 pi 모델이 정상 유지된다
    const zeroAgy = loadRosterConfig({ rosterPath: path.join(tmp, 'roster-zero-agy.json') });
    assert.equal(zeroAgy.config.profiles['zero-agy']!.roles.lead!.model, 'glm-zcode/glm-5.3');
    assert.equal(zeroAgy.config.profiles['zero-agy']!.roles.coder!.cli, 'devin');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 3. detectEnvironment 모의 홈 감지 ----------

test('3. detectEnvironment — 임시 $HOME에서 동반자·스킬·시크릿·경계 버전 감지', () => {
  const home = makeHome();
  try {
    const bindir = path.join(home, 'bin');
    touchExec(path.join(bindir, 'hc'));
    touchExec(path.join(bindir, 'claude'));
    // 관례적 폴백 bin (~/.cargo/bin) — pathDirs 외부여도 감지되어야 한다
    touchExec(path.join(home, '.cargo', 'bin', 'mistology'));
    writeSkill(home, '.agents', 'todo');
    writeSkill(home, '.claude', 'effort-router');
    writeSkill(home, '.gemini', 'mistology');
    fs.mkdirSync(path.join(home, '.config', 'herdr-quad'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'herdr-quad', 'secrets.env'), 'DUMMY=1\n');
    fs.writeFileSync(path.join(home, '.config', 'herdr-quad', 'roster.json'), '{"defaultProfile":"x","profiles":{"x":{"roles":{}}}}\n');
    const dbDir = path.join(home, 'state', 'decision-orchestrator');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'decision.db'), '');

    const env: NodeJS.ProcessEnv = {
      PATH: bindir,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(home, 'state'),
    };
    const report = detectEnvironment({
      env,
      homeDir: home,
      pathDirs: [bindir],
      systemDirs: [],
      nodeVersion: 'v24.0.0',
      nodeSqliteOk: true,
    });

    assert.equal(report.node.ok, true);
    assert.equal(report.nodeSqlite.ok, true);
    assert.equal(report.git.installed, false, 'systemDirs=[] 이므로 실제 /usr/bin/git 미검출');
    assert.equal(report.clis.hc.installed, true);
    assert.equal(report.clis.claude.installed, true);
    assert.equal(report.clis.codex.installed, false);
    assert.equal(report.clis.pi.installed, false);
    assert.equal(report.clis.gemini.installed, false);
    assert.equal(report.clis.agy.installed, false);
    assert.equal(report.clis.cargo.installed, false, 'cargo 바이너리는 만들지 않았다');

    // 동반자 6종 — brief §2.5 전부 명시 감지
    assert.equal(report.companions['mistology'].installed, true);
    assert.match(report.companions['mistology'].detail, /mistology/);
    assert.equal(report.companions['todo-flow'].installed, true);
    assert.equal(report.companions['effort-router'].installed, true);
    assert.equal(report.companions['neverstuck'].installed, false);
    assert.equal(report.companions['hc'].installed, true);
    assert.equal(report.companions['gemini-decision-api-key'].installed, true, 'secrets.env 존재 → configured');
    assert.equal(report.companions['mistology'].role, '저장소별 과거 코드 실수·2-hop 연관 모듈 브리핑 (Rust CLI + 스킬)');

    // secrets: env 미설정 + 파일 존재 → configured (값은 절대 읽지 않는다)
    assert.equal(report.secrets.envSet, false);
    assert.equal(report.secrets.secretsFileExists, true);
    assert.equal(report.secrets.configured, true);

    // roster·db·에이전트 디렉터리
    assert.equal(report.roster.exists, true);
    assert.equal(report.roster.validJson, true);
    assert.equal(report.db.exists, true);
    assert.equal(report.db.source, 'default');
    const agents = Object.fromEntries(report.agents.map((a) => [a.id, a]));
    assert.equal(agents['claude']!.exists, true);
    assert.equal(agents['claude']!.skillLinked, false);
    assert.equal(agents['agents']!.exists, true);
    assert.equal(agents['cursor']!.exists, false);
    assert.equal(agents['pi']!.exists, false, '.pi/agent 미생성');

    // hc + claude만 → claude-only (agy는 워커로 세지 않는다)
    assert.equal(report.recommendation.profileName, 'claude-only');
    assert.equal(report.ok, false, 'git 미설치 → 필수 누락');

    // 경계 버전: 22.6.0 ok / 22.5.9·21.x 불합격
    assert.equal(detectEnvironment({ env, homeDir: home, pathDirs: [bindir], systemDirs: [], nodeVersion: 'v22.6.0', nodeSqliteOk: true }).node.ok, true);
    assert.equal(detectEnvironment({ env, homeDir: home, pathDirs: [bindir], systemDirs: [], nodeVersion: 'v22.5.9', nodeSqliteOk: true }).node.ok, false);
    assert.equal(detectEnvironment({ env, homeDir: home, pathDirs: [bindir], systemDirs: [], nodeVersion: 'v21.9.0', nodeSqliteOk: true }).node.ok, false);

    // env 키 설정 경로도 secrets 감지
    const envKey = { ...env, GEMINI_DECISION_API_KEY: 'x' };
    assert.equal(detectEnvironment({ env: envKey, homeDir: home, pathDirs: [bindir], systemDirs: [], nodeVersion: 'v24.0.0', nodeSqliteOk: true }).secrets.envSet, true);

    // 빈 홈 → 모든 동반자 미설치 + standalone (hc 없음)
    const emptyHome = makeHome();
    try {
      const bare = detectEnvironment({ env: { PATH: '' }, homeDir: emptyHome, pathDirs: [], systemDirs: [], nodeVersion: 'v24.0.0', nodeSqliteOk: true });
      assert.equal(bare.companions['mistology'].installed, false);
      assert.equal(bare.companions['todo-flow'].installed, false);
      assert.equal(bare.companions['effort-router'].installed, false);
      assert.equal(bare.companions['gemini-decision-api-key'].installed, false);
      assert.equal(bare.recommendation.mode, 'standalone');
      assert.equal(bare.roster.exists, false);
      assert.equal(bare.db.exists, false);
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 4. installSkillLinks ----------

test('4. installSkillLinks — 존재 디렉터리만 심볼릭 링크 + 멱등 + 충돌 보존', () => {
  const home = makeHome();
  const repo = makeHome();
  try {
    const srcDir = path.join(repo, 'skills', 'decision-orchestrator');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '# decision-orchestrator\n');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    // .gemini/.codex/.pi/agent/.cursor는 미생성

    const r1 = installSkillLinks({ homeDir: home, repoDir: repo });
    assert.equal(r1.linked.length, 2);
    assert.ok(r1.linked.includes(path.join(home, '.claude')));
    assert.ok(r1.linked.includes(path.join(home, '.agents')));
    assert.equal(r1.skipped.length, 4);
    for (const s of r1.skipped) assert.equal(s.reason, 'agent-dir-absent');

    const link = path.join(home, '.claude', 'skills', 'decision-orchestrator');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'must be a symlink');
    assert.equal(fs.readlinkSync(link), srcDir);
    assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), 'SKILL.md readable through link');

    // 멱등 — 재실행 시 신규 링크 0, already-linked 스킵
    const r2 = installSkillLinks({ homeDir: home, repoDir: repo });
    assert.equal(r2.linked.length, 0);
    const reasons = Object.fromEntries(r2.skipped.map((s) => [s.dir, s.reason]));
    assert.equal(reasons[path.join(home, '.claude')], 'already-linked');
    assert.equal(reasons[path.join(home, '.agents')], 'already-linked');

    // 충돌 — 실제 디렉터리가 있으면 절대 덮어쓰지 않는다
    const conflict = path.join(home, '.codex', 'skills', 'decision-orchestrator');
    fs.mkdirSync(conflict, { recursive: true });
    fs.writeFileSync(path.join(conflict, 'keep.txt'), 'user data\n');
    const r3 = installSkillLinks({ homeDir: home, repoDir: repo });
    const codexSkip = r3.skipped.find((s) => s.dir === path.join(home, '.codex'));
    assert.equal(codexSkip?.reason, 'conflict-existing-path');
    assert.ok(fs.existsSync(path.join(conflict, 'keep.txt')), 'conflicting dir must be preserved');
    assert.ok(!fs.lstatSync(conflict).isSymbolicLink());

    // onlyAgentIds 제한 — 지정 에이전트만 처리
    const home2 = makeHome();
    try {
      fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(home2, '.agents'), { recursive: true });
      const r4 = installSkillLinks({ homeDir: home2, repoDir: repo, onlyAgentIds: ['agents'] });
      assert.deepEqual(r4.linked, [path.join(home2, '.agents')]);
      assert.ok(!fs.existsSync(path.join(home2, '.claude', 'skills', 'decision-orchestrator')));
    } finally {
      fs.rmSync(home2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------- 5. installRepoHooks ----------

test('5. installRepoHooks — canonical hooks.json + dg-hook 심볼릭 링크 + .git/info/exclude', () => {
  const orch = makeHome();
  const repo = makeHome();
  try {
    // 오케스트레이터 소스 (canonical)
    const srcAgents = path.join(orch, '.agents');
    fs.mkdirSync(path.join(srcAgents, 'hooks'), { recursive: true });
    const canonical = JSON.stringify(
      { 'dg-guard': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hooks/dg-hook.ts --guard', timeout: 3 }] }] } },
      null,
      2,
    );
    fs.writeFileSync(path.join(srcAgents, 'hooks.json'), `${canonical}\n`);
    const srcHook = path.join(srcAgents, 'hooks', 'dg-hook.ts');
    fs.writeFileSync(srcHook, '// dg-hook\n');
    // git 저장소 시뮬레이션
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });

    const r1 = installRepoHooks({ repoDir: repo, orchestratorRoot: orch });
    assert.equal(r1.skipped.length, 0);
    assert.equal(r1.written.length, 3);

    const dstJson = path.join(repo, '.agents', 'hooks.json');
    assert.equal(fs.readFileSync(dstJson, 'utf8'), `${canonical}\n`, 'canonical copy');
    const parsed = JSON.parse(fs.readFileSync(dstJson, 'utf8')) as Record<string, unknown>;
    assert.ok('dg-guard' in parsed);

    const dstHook = path.join(repo, '.agents', 'hooks', 'dg-hook.ts');
    assert.ok(fs.lstatSync(dstHook).isSymbolicLink(), 'dg-hook.ts must be a symlink');
    assert.equal(fs.readlinkSync(dstHook), srcHook);

    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes('.agents/hooks.json'));
    assert.ok(exclude.split('\n').includes('.agents/hooks/'));

    // 멱등 — 재실행 시 exclude 중복 추가 없음
    const r2 = installRepoHooks({ repoDir: repo, orchestratorRoot: orch });
    assert.equal(r2.written.length, 0);
    const exclude2 = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude2, exclude, 'exclude must not gain duplicate lines');
    assert.ok(r2.skipped.some((s) => s.reason === 'already-excluded'));

    // 기존 hooks.json이 다르면 덮어쓰지 않는다
    const repo2 = makeHome();
    try {
      fs.mkdirSync(path.join(repo2, '.git', 'info'), { recursive: true });
      fs.mkdirSync(path.join(repo2, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(repo2, '.agents', 'hooks.json'), '{"custom":true}\n');
      const r3 = installRepoHooks({ repoDir: repo2, orchestratorRoot: orch });
      assert.ok(r3.skipped.some((s) => s.reason === 'conflict-different-content'));
      assert.equal(fs.readFileSync(path.join(repo2, '.agents', 'hooks.json'), 'utf8'), '{"custom":true}\n');
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
    }

    // .git 없는 디렉터리 — 훅은 설치되되 exclude는 not-a-git-repo 스킵
    const repo3 = makeHome();
    try {
      const r4 = installRepoHooks({ repoDir: repo3, orchestratorRoot: orch });
      assert.ok(fs.existsSync(path.join(repo3, '.agents', 'hooks.json')));
      assert.ok(r4.skipped.some((s) => s.reason === 'not-a-git-repo'));
    } finally {
      fs.rmSync(repo3, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(orch, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------- 6. --check --json e2e ----------

test('6. CLI --check --json — exit 0·유효 JSON·쓰기 0·시크릿 값 누출 0', () => {
  const home = makeHome();
  try {
    const before = listFiles(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: path.join(home, 'empty-bin'),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'xcfg'),
      XDG_STATE_HOME: path.join(home, 'xstate'),
      GEMINI_TRICK_DB_PATH: path.join(home, 'never-created.db'),
      GEMINI_DECISION_API_KEY: 'SECRET-TEST-VALUE-9f8e7d',
    };
    delete env.DECISION_ORCHESTRATOR_DB_PATH;
    const res = spawnSync(process.execPath, [SETUP_PATH, '--check', '--json'], {
      env,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30000,
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      node: { ok: boolean };
      clis: Record<string, { installed: boolean }>;
      companions: Record<string, { installed: boolean; role: string }>;
      secrets: { envSet: boolean; configured: boolean };
      recommendation: { mode: string };
    };
    assert.equal(parsed.node.ok, true);
    assert.equal(typeof parsed.ok, 'boolean');
    assert.ok(parsed.clis && typeof parsed.clis === 'object');
    assert.equal(parsed.secrets.envSet, true);
    assert.equal(parsed.secrets.configured, true);
    for (const id of ['mistology', 'todo-flow', 'effort-router', 'neverstuck', 'hc', 'gemini-decision-api-key']) {
      assert.ok(id in parsed.companions, `companions.${id} missing`);
    }
    assert.ok(['standalone', 'multi-cli'].includes(parsed.recommendation.mode));
    // 시크릿 값이 출력 어디에도 나타나지 않는다
    assert.ok(!res.stdout.includes('SECRET-TEST-VALUE-9f8e7d'), 'secret value leaked to stdout');
    assert.ok(!res.stderr.includes('SECRET-TEST-VALUE-9f8e7d'), 'secret value leaked to stderr');
    // 쓰기 0 — 홈 트리가 실행 전후 동일
    assert.deepEqual(listFiles(home), before, '--check --json must not write any file');
    assert.ok(!fs.existsSync(path.join(home, 'never-created.db')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 7. 비TTY 폴백·텍스트 리포트 ----------

test('7. 비TTY 폴백 — 플래그 없이도 행 없이 진단 요약만 출력하고 exit 0', () => {
  const home = makeHome();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: path.join(home, 'empty-bin'),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'xcfg'),
      XDG_STATE_HOME: path.join(home, 'xstate'),
      GEMINI_TRICK_DB_PATH: path.join(home, 'never.db'),
    };
    delete env.DECISION_ORCHESTRATOR_DB_PATH;
    delete env.GEMINI_DECISION_API_KEY;
    const before = listFiles(home);
    const res = spawnSync(process.execPath, [SETUP_PATH], {
      env,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30000,
    });
    assert.equal(res.status, 0, `must not hang/crash in non-TTY: ${res.stderr}`);
    assert.ok(res.stdout.includes('비대화형 모드'), res.stdout);
    assert.ok(res.stdout.includes('환경 진단'), res.stdout);
    assert.deepEqual(listFiles(home), before, 'non-interactive fallback must not write');
    assert.ok(!fs.existsSync(path.join(home, 'never.db')));

    // formatCheckReport 단위 — 한국어 섹션·추천·역할표 포함
    const report = detectEnvironment({
      env: { PATH: '' },
      homeDir: home,
      pathDirs: [],
      systemDirs: [],
      nodeVersion: 'v24.0.0',
      nodeSqliteOk: true,
    });
    const text = formatCheckReport(report);
    assert.ok(text.includes('필수 런타임'));
    assert.ok(text.includes('코딩 CLI'));
    assert.ok(text.includes('선택 도구·스킬'));
    assert.ok(text.includes('추천 모드: standalone'));
    assert.ok(text.includes('mistology'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 8. discoverAvailableModels + classifyModelTier (setup v2) ----------

test('8. discoverAvailableModels — 로컬 설정 파싱·시크릿 누출 0·agy 자동 미포함·카탈로그 폴백', () => {
  const home = makeHome();
  try {
    // pi models.json — apiKey/baseUrl 등 다른 키는 절대 결과에 새면 안 된다
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        opencodex: {
          apiKey: 'sk-secret-must-not-leak',
          baseUrl: 'https://internal.example/v1',
          models: ['glm-zcode/glm-5.3', { id: 'command-code/deepseek-deepseek-v4.1-flash' }, { name: 'no-id' }, 42],
        },
      },
    }));
    // codex config.toml — `model =` 라인만 매칭 (model_reasoning_effort는 미매칭)
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\napi_key = "codex-secret-no-leak"\n'
    );
    // claude settings.json — 최상위 model 문자열 + 카탈로그 (apiKey 무시)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-8', apiKey: 'claude-secret-no-leak' })
    );

    const clis = mkClis('pi', 'codex', 'claude', 'devin', 'gemini', 'agy');
    const models = discoverAvailableModels(home, clis);

    // pi — 문자열·{id} 항목 모두 추출, {name}·숫자 항목은 무시, provider 기록
    const pi = models.filter((m) => m.cli === 'pi');
    assert.deepEqual(pi.map((m) => m.model), ['glm-zcode/glm-5.3', 'command-code/deepseek-deepseek-v4.1-flash']);
    assert.equal(pi[0]!.provider, 'opencodex');
    assert.equal(pi[0]!.source, 'local_config');
    // codex — toml `model =` 라인만
    const codex = models.filter((m) => m.cli === 'codex');
    assert.deepEqual(codex.map((m) => m.model), ['gpt-6.1-sol']);
    assert.equal(codex[0]!.source, 'local_config');
    // claude — 로컬 model 우선 + 카탈로그 3종 (dedup)
    const claude = models.filter((m) => m.cli === 'claude');
    assert.deepEqual(claude.map((m) => m.model), ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
    assert.equal(claude[0]!.source, 'local_config');
    assert.equal(claude[1]!.source, 'catalog');
    // devin·gemini 카탈로그
    assert.deepEqual(models.filter((m) => m.cli === 'devin').map((m) => m.model), ['default']);
    assert.equal(models.find((m) => m.cli === 'devin')!.tier, 'coding_agent');
    assert.deepEqual(models.filter((m) => m.cli === 'gemini').map((m) => m.model), ['gemini-2.5-flash', 'gemini-2.5-pro']);
    // agy는 설치돼 있어도 절대 자동 포함되지 않는다
    assert.ok(!models.some((m) => /agy/.test(`${m.cli} ${m.model} ${m.provider ?? ''}`)), 'agy must never be discovered');
    // 시크릿·내부 URL 값 누출 0 — 직렬화 전체 검색
    const blob = JSON.stringify(models);
    for (const s of ['sk-secret-must-not-leak', 'codex-secret-no-leak', 'claude-secret-no-leak', 'internal.example']) {
      assert.ok(!blob.includes(s), `secret leaked: ${s}`);
    }

    // codex 모델 라인 없음 → 카탈로그 폴백
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n');
    const m2 = discoverAvailableModels(home, clis);
    const codex2 = m2.filter((m) => m.cli === 'codex');
    assert.deepEqual(codex2.map((m) => m.model), ['gpt-5-codex']);
    assert.equal(codex2[0]!.source, 'catalog');

    // 미설치 CLI는 설정 파일이 있어도 읽지 않는다
    assert.equal(discoverAvailableModels(home, mkClis()).length, 0);

    // detectEnvironment에도 포함된다
    const bindir = path.join(home, 'bin');
    for (const id of ['pi', 'codex', 'claude', 'devin', 'gemini', 'hc']) touchExec(path.join(bindir, id));
    const rep = detectEnvironment({
      env: { PATH: bindir },
      homeDir: home,
      pathDirs: [bindir],
      systemDirs: [],
      nodeVersion: 'v24.0.0',
      nodeSqliteOk: true,
    });
    assert.ok(rep.discoveredModels.some((m) => m.cli === 'pi' && m.model === 'glm-zcode/glm-5.3'));
    assert.ok(rep.discoveredModels.some((m) => m.cli === 'devin' && m.tier === 'coding_agent'));
    assert.ok(!rep.discoveredModels.some((m) => /agy/.test(m.cli)), 'no agy in report.discoveredModels');

    // classifyModelTier 휴리스틱
    assert.equal(classifyModelTier('devin', 'anything').tier, 'coding_agent');
    assert.equal(classifyModelTier('devin', 'anything').tierLabel, '코딩 에이전트');
    assert.equal(classifyModelTier('pi', 'deepseek-v4.1-flash').tier, 'fast');
    assert.equal(classifyModelTier('claude', 'claude-haiku-4-5').tier, 'fast');
    assert.equal(classifyModelTier('pi', 'glm-5.3').tier, 'strong');
    assert.equal(classifyModelTier('claude', 'claude-opus-4-8').tier, 'strong');
    // 'gemini' 안의 'mini'는 fast로 오탐되지 않는다 (토큰 경계 매칭)
    assert.equal(classifyModelTier('gemini', 'gemini-2.5-pro').tier, 'strong');
    assert.equal(classifyModelTier('gemini', 'gemini-2.5-flash').tier, 'fast');
    assert.equal(classifyModelTier('pi', 'google/gemini-decision-1').tier, 'balanced');
    assert.equal(classifyModelTier('pi', 'plain-model').tier, 'balanced');
    assert.equal(classifyModelTier('pi', 'deepseek-v4.1-flash').tierLabel, '빠름·저비용');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 9. extractModelFamily + checkCrossVerificationDiversity ----------

test('9. extractModelFamily + checkCrossVerificationDiversity — 같은 계열 경고, 다른 계열 무경고', () => {
  // 모델명 → 계열 정규화 (model 우선, 없으면 cli/bin)
  assert.equal(extractModelFamily({ cli: 'pi', model: 'glm-zcode/glm-5.3' }), 'glm');
  assert.equal(extractModelFamily({ cli: 'pi', model: 'command-code/deepseek-deepseek-v4.1-flash' }), 'deepseek');
  assert.equal(extractModelFamily({ cli: 'claude', model: 'claude-sonnet-4-6' }), 'claude');
  assert.equal(extractModelFamily({ cli: 'custom', bin: 'codex', model: 'gpt-5-codex' }), 'gpt');
  assert.equal(extractModelFamily({ cli: 'custom', bin: 'gemini', model: 'gemini-2.5-pro' }), 'gemini');
  assert.equal(extractModelFamily({ cli: 'devin' }), 'devin');
  assert.equal(extractModelFamily({ cli: 'custom', bin: 'codex' }), 'gpt');
  assert.equal(extractModelFamily({ cli: 'claude' }), 'claude');
  assert.equal(extractModelFamily(undefined), null);

  // verifier == lead 계열 → 경고 1건 (비차단 문자열)
  const sameLead = checkCrossVerificationDiversity({
    lead: { cli: 'pi', model: 'glm-zcode/glm-5.3' },
    coder: { cli: 'devin' },
    verifier: { cli: 'pi', model: 'glm-zcode/glm-5.3' },
  });
  assert.equal(sameLead.length, 1);
  assert.match(sameLead[0]!, /리드와 검증이 같은 모델 계열\(glm\)/);
  // verifier == coder 계열 → 경고 1건
  const sameCoder = checkCrossVerificationDiversity({
    coder: { cli: 'custom', bin: 'gemini', model: 'gemini-2.5-pro' },
    verifier: { cli: 'custom', bin: 'gemini', model: 'gemini-2.5-flash' },
  });
  assert.equal(sameCoder.length, 1);
  assert.match(sameCoder[0]!, /코더와 검증이 같은 모델 계열\(gemini\)/);
  // 리드·코더 둘 다 같으면 경고 2건
  const both = checkCrossVerificationDiversity({
    lead: { cli: 'claude' },
    coder: { cli: 'claude' },
    verifier: { cli: 'claude' },
  });
  assert.equal(both.length, 2);
  // 다른 계열 → []
  const diff = checkCrossVerificationDiversity({
    lead: { cli: 'pi', model: 'glm-zcode/glm-5.3' },
    coder: { cli: 'devin' },
    verifier: { cli: 'pi', model: 'command-code/deepseek-deepseek-v4.1-flash' },
  });
  assert.deepEqual(diff, []);
  // verifier 부재 → []
  assert.deepEqual(checkCrossVerificationDiversity({ lead: { cli: 'claude' } }), []);
});

// ---------- 10. modelChoiceToRoleSpec → loadRosterConfig 무경고 ----------

test('10. modelChoiceToRoleSpec — 맞춤 5슬롯 프로필 loadRosterConfig warnings=0·pi 필드 누출 0', () => {
  const tmp = makeHome();
  try {
    const mk = (cli: DiscoveredModel['cli'], model: string, provider?: string): DiscoveredModel => ({
      cli,
      model,
      source: 'local_config',
      ...(provider ? { provider } : {}),
      ...classifyModelTier(cli, model),
    });
    const picks: Record<RoleSlot, DiscoveredModel> = {
      lead: mk('pi', 'glm-zcode/glm-5.3', 'opencodex'),
      explore: mk('claude', 'claude-haiku-4-5'),
      coder: mk('devin', 'default'),
      verifier: mk('gemini', 'gemini-2.5-pro'),
      advisor: mk('claude', 'claude-opus-4-8'),
    };
    const roles = {} as Record<RoleSlot, RoleWorkerSpec>;
    for (const slot of ROLE_SLOTS) roles[slot] = modelChoiceToRoleSpec(picks[slot]!, slot);
    const cfg: RosterConfig = {
      defaultProfile: 'custom-picked',
      profiles: { 'custom-picked': { description: 'test', dailyTurnBudgets: { agy: 0 }, roles } },
    };
    const file = path.join(tmp, 'roster-custom.json');
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

    const loaded = loadRosterConfig({ rosterPath: file });
    assert.equal(loaded.warnings.length, 0, loaded.warnings.join('; '));
    const prof = loaded.config.profiles['custom-picked']!;
    assert.equal(prof.dailyTurnBudgets?.agy, 0);

    // pi 슬롯 — provider·model·thinking 정상 유지
    const lead = prof.roles.lead!;
    assert.equal(lead.cli, 'pi');
    assert.equal(lead.provider, 'opencodex');
    assert.equal(lead.model, 'glm-zcode/glm-5.3');
    assert.equal(lead.thinking, 'medium');
    assert.equal(lead.readonly, undefined);
    // devin coder — pi 전용 필드(model·provider·thinking)가 새지 않는다
    const coder = prof.roles.coder!;
    assert.equal(coder.cli, 'devin');
    assert.equal(coder.model, '', 'devin must not inherit pi model');
    assert.equal(coder.provider, '', 'devin must not inherit pi provider');
    assert.equal(coder.thinking, '', 'devin must not inherit pi thinking');
    // gemini verifier → custom + bin, readonly, pi 필드 차단
    const verifier = prof.roles.verifier!;
    assert.equal(verifier.cli, 'custom');
    assert.equal(verifier.bin, 'gemini');
    assert.equal(verifier.model, 'gemini-2.5-pro');
    assert.equal(verifier.provider, '', 'custom must not inherit pi provider');
    assert.equal(verifier.thinking, '', 'custom must not inherit pi thinking');
    assert.equal(verifier.readonly, true);
    // claude advisor — permissionMode plan + readonly + onDemand + quotaBucket 차단
    const advisor = prof.roles.advisor!;
    assert.equal(advisor.cli, 'claude');
    assert.equal(advisor.permissionMode, 'plan');
    assert.equal(advisor.readonly, true);
    assert.equal(advisor.onDemand, true);
    assert.equal(advisor.quotaBucket, 'claude', 'claude advisor must not inherit pi quota bucket');
    // claude explore — readonly + permissionMode auto
    const explore = prof.roles.explore!;
    assert.equal(explore.cli, 'claude');
    assert.equal(explore.model, 'claude-haiku-4-5');
    assert.equal(explore.permissionMode, 'auto');
    assert.equal(explore.readonly, true);

    // 슬롯 규칙 단위 검증 — pi explore는 thinking low + readonly
    const explorePi = modelChoiceToRoleSpec(mk('pi', 'x', 'opencodex'), 'explore');
    assert.equal(explorePi.thinking, 'low');
    assert.equal(explorePi.readonly, true);
    // codex pick → custom + 명시 bin
    const codexPick = modelChoiceToRoleSpec(mk('codex', 'gpt-6.1-sol'), 'coder');
    assert.equal(codexPick.cli, 'custom');
    assert.equal(codexPick.bin, 'codex');
    assert.equal(codexPick.provider, '');
    assert.equal(codexPick.thinking, '');
    // devin lead — model 없음이 pi model 상속을 막는다
    const devinLead = modelChoiceToRoleSpec(mk('devin', 'default'), 'lead');
    assert.equal(devinLead.model, '');
    // advisor가 아니면 onDemand 미설정
    assert.equal(modelChoiceToRoleSpec(mk('claude', 'x'), 'verifier').onDemand, undefined);
    assert.equal(modelChoiceToRoleSpec(mk('claude', 'x'), 'verifier').permissionMode, 'plan');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
