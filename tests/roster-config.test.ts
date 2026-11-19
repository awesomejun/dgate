/**
 * W3.5 roster.json 통합 테스트 (brief-w35 §3.E).
 *
 * 목적: ① 커스텀 `roster.json` 주입 시 코드 수정 없이 lead/explore 교체·
 * `standing_agy_sessions` 동적 재계산, ② 설정 탐색 우선순위
 * (flag > env > project > global > builtin), ③ `--repo <외부 저장소>` 일반화
 * (dg·역할 계약서는 오케스트레이터 루트 해석, 기본 사용자 DB 미오염),
 * ④ 깨진 roster 안전 폴백을 검증한다.
 *
 * 실행: `node --test tests/roster-config.test.ts` (외부 의존성 0개, 임시 격리 env 사용)
 *
 * 주의: 모든 spawn은 `GEMINI_TRICK_DB_PATH`(미생성 경로)·`XDG_CONFIG_HOME`(임시)·
 * `HERDR_ROSTER_PATH`(삭제)를 고정해 실제 사용자 전역 설정·DB에 영향을 주지 않는다.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  buildWorkerCommand,
  builtinRosterConfig,
  countMaxOndemandByBucket,
  countStandingSessionsByBucket,
  effectiveQuotaBucket,
  globalRosterPath,
  loadRosterConfig,
  resolveWorkerBin,
} from '../src/decision/roster.ts';
import { planDispatch } from '../scripts/dispatch.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const LAUNCHER_PATH = path.join(REPO_ROOT, 'scripts', 'herdr-quad-launch.ts');
const DISPATCH_PATH = path.join(REPO_ROOT, 'scripts', 'dispatch.ts');
const ORCH_ROLES_LEAD = path.join(REPO_ROOT, '.herdr', 'roles', 'lead.md');
const ORCH_DG = path.join(REPO_ROOT, 'src', 'decision', 'dg.ts');

interface TestEnv {
  base: string;
  xdg: string;
  repo: string;
  neverDb: string;
  env: NodeJS.ProcessEnv;
}

function makeEnv(withGit = false): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `w35test-${process.pid}-`));
  const xdg = path.join(base, 'xdg');
  fs.mkdirSync(path.join(xdg, 'herdr-quad'), { recursive: true });
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  if (withGit) {
    spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  }
  const neverDb = path.join(base, 'never-created.db');
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GEMINI_TRICK_DB_PATH = neverDb;
  env.XDG_CONFIG_HOME = xdg;
  delete env.DGATE_DB_PATH;
  delete env.DECISION_ORCHESTRATOR_DB_PATH;
  delete env.HERDR_ROSTER_PATH;
  return { base, xdg, repo, neverDb, env };
}

function cleanupEnv(e: TestEnv): void {
  fs.rmSync(e.base, { recursive: true, force: true });
}

function writeJson(file: string, data: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function runLauncher(e: TestEnv, args: string[], envExtra: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [LAUNCHER_PATH, ...args], {
    env: { ...e.env, ...envExtra },
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

// ---------------------------------------------------------------------------

test('1. 커스텀 roster: lead→claude·explore 교체 즉시 반영 + agy 세션 동적 재계산', () => {
  const e = makeEnv();
  try {
    const rosterPath = writeJson(path.join(e.base, 'custom-roster.json'), {
      defaultProfile: 'custom-mix',
      profiles: {
        'custom-mix': {
          description: '테스트 — lead claude 교체·explore 모델 교체·verifier agy 승격',
          roles: {
            lead: { cli: 'claude', bin: '/fake-bin/claude', model: 'claude-sonnet-4-6', permissionMode: 'auto' },
            explore: { cli: 'pi', provider: 'opencodex', model: 'openai-codex/gpt-5.6-luna', thinking: 'high', readonly: true },
            verifier: { cli: 'agy', model: 'gemini-4-neon-high', readonly: true },
          },
        },
      },
    });

    // (a) dispatch 단위 — explore(sharp)·lead(split) 커맨드가 즉시 새 CLI·모델로 교체
    const explorePlan = planDispatch({
      taskKind: 'explore_read',
      repoDir: e.repo,
      runId: 'ab12cd',
      dryRun: true,
      rosterPath,
    });
    assert.equal(explorePlan.ok, true);
    assert.equal(explorePlan.decision, 'sharp');
    const exploreCmd = explorePlan.hcCommands[0]!.join(' ');
    assert.ok(exploreCmd.includes('openai-codex/gpt-5.6-luna'), exploreCmd);
    assert.ok(exploreCmd.includes('--tools read,grep,find,ls'), exploreCmd);
    assert.ok(exploreCmd.includes('--no-approve'), exploreCmd);
    assert.ok(!exploreCmd.includes('deepseek'), 'explore must use the roster model, not builtin');

    const leadPlan = planDispatch({
      taskKind: 'single_edit',
      repoDir: e.repo,
      runId: 'ab12cd',
      dryRun: true,
      rosterPath,
    });
    assert.equal(leadPlan.decision, 'split');
    assert.equal(leadPlan.sessionName, 'lead-ab12cd');
    const leadCmd = leadPlan.hcCommands[0]!.join(' ');
    assert.ok(leadCmd.includes('/fake-bin/claude'), leadCmd);
    assert.ok(leadCmd.includes('claude-sonnet-4-6'), leadCmd);
    assert.ok(!leadCmd.includes('glm-zcode/glm-5.3'), 'lead must use the roster CLI, not builtin pi');

    // (b) dispatch CLI — --roster 플래그 전달 시 출력 커맨드에도 즉시 반영
    const cli = spawnSync(
      process.execPath,
      [DISPATCH_PATH, '--task-kind', 'explore_read', '--repo', e.repo, '--roster', rosterPath, '--dry-run'],
      { env: e.env, encoding: 'utf8', cwd: os.tmpdir() }
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.stdout.includes('openai-codex/gpt-5.6-luna'), cli.stdout);
    assert.ok(cli.stdout.includes(`target_repo=${e.repo}`), cli.stdout);
    assert.ok(cli.stdout.includes('roster_source=flag'), cli.stdout);

    // (c) launcher --mode orchestrate --dry-run — 프로필 전환 + standing 재계산
    //     custom-mix: verifier agy 상시 1 + advisor(상속) pi 온디맨드 → standing 1 / max 1
    const res = runLauncher(e, [
      '--mode', 'orchestrate', '--dry-run', '--roster', rosterPath, '--repo', e.repo, '--run-id', 'ab12cd',
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /profile=custom-mix/);
    assert.match(res.stdout, /standing_agy_sessions=1/);
    assert.match(res.stdout, /max_ondemand_agy=1/);
    assert.ok(res.stdout.includes('/fake-bin/claude'), 'lead standing session uses roster claude');
    assert.ok(res.stdout.includes('claude-sonnet-4-6'), res.stdout);
    assert.ok(res.stdout.includes('openai-codex/gpt-5.6-luna'), 'rehearsal explore uses roster model');
    const leadLine = res.stdout.split('\n').find((l) => l.includes('--name lead-ab12cd'));
    assert.ok(leadLine, 'lead hc command line expected');
    assert.ok(!leadLine!.includes('glm-zcode/glm-5.3'), `lead must use the roster claude model, not builtin pi: ${leadLine}`);
    // verifier agy 승격 — neon 세션이 claude/pi가 아니라 agy 커맨드로 기동
    assert.ok(res.stdout.includes('--mode plan'), res.stdout);
  } finally {
    cleanupEnv(e);
  }
});

test('2. roster 탐색 우선순위: --roster > HERDR_ROSTER_PATH > <repo>/.herdr > 전역 > 내장', () => {
  const e = makeEnv();
  const prevRosterEnv = process.env.HERDR_ROSTER_PATH;
  const prevXdgEnv = process.env.XDG_CONFIG_HOME;
  // 단위 loadRosterConfig 호출은 테스트 프로세스 env를 그대로 보므로 XDG도 고정한다.
  process.env.XDG_CONFIG_HOME = e.xdg;
  delete process.env.HERDR_ROSTER_PATH;
  try {
    const projectRoster = writeJson(path.join(e.repo, '.herdr', 'roster.json'), {
      defaultProfile: 'p-proj',
      profiles: { 'p-proj': { roles: { lead: { cli: 'pi', model: 'model-project-x' } } } },
    });
    const globalRoster = writeJson(path.join(e.xdg, 'herdr-quad', 'roster.json'), {
      defaultProfile: 'p-glob',
      profiles: { 'p-glob': { roles: { lead: { cli: 'pi', model: 'model-global-x' } } } },
    });
    const flagA = writeJson(path.join(e.base, 'flag-a.json'), {
      defaultProfile: 'p-flag-a',
      profiles: { 'p-flag-a': { roles: { lead: { cli: 'pi', model: 'model-flag-a' } } } },
    });
    const flagB = writeJson(path.join(e.base, 'flag-b.json'), {
      defaultProfile: 'p-flag-b',
      profiles: { 'p-flag-b': { roles: { lead: { cli: 'pi', model: 'model-flag-b' } } } },
    });

    // (a) 프로젝트 로컬이 전역을 오버라이드 (launcher e2e)
    const resProject = runLauncher(e, ['--mode', 'orchestrate', '--dry-run', '--repo', e.repo, '--run-id', 'aa1111']);
    assert.equal(resProject.status, 0, resProject.stderr);
    assert.match(resProject.stdout, /profile=p-proj/);
    assert.ok(resProject.stdout.includes('model-project-x'), resProject.stdout);
    assert.ok(resProject.stdout.includes(`roster_source=project (${projectRoster})`), resProject.stdout);

    // (b) HERDR_ROSTER_PATH가 프로젝트보다 우선 (단위)
    process.env.HERDR_ROSTER_PATH = flagA;
    let loaded = loadRosterConfig({ repoDir: e.repo });
    assert.equal(loaded.source, 'env');
    assert.equal(loaded.config.defaultProfile, 'p-flag-a');
    assert.equal(loaded.config.profiles['p-flag-a']!.roles.lead!.model, 'model-flag-a');

    // (c) --roster 플래그가 env보다 우선 (launcher e2e)
    const resFlag = runLauncher(
      e,
      ['--mode', 'orchestrate', '--dry-run', '--roster', flagB, '--repo', e.repo, '--run-id', 'bb2222'],
      { HERDR_ROSTER_PATH: flagA }
    );
    assert.equal(resFlag.status, 0, resFlag.stderr);
    assert.match(resFlag.stdout, /profile=p-flag-b/);
    assert.ok(resFlag.stdout.includes('model-flag-b'), resFlag.stdout);
    delete process.env.HERDR_ROSTER_PATH;

    // (d) 프로젝트 파일이 없으면 전역 기본 사용 (단위 + 경로 해석)
    const repoBare = path.join(e.base, 'repo-bare');
    fs.mkdirSync(repoBare, { recursive: true });
    loaded = loadRosterConfig({ repoDir: repoBare });
    assert.equal(loaded.source, 'global');
    assert.equal(loaded.sourcePath, globalRoster);
    assert.equal(loaded.config.defaultProfile, 'p-glob');

    // (e) 어디에도 파일이 없으면 내장 기본 (임시 XDG 격리 하 resign 경로 탐색)
    const xdgEmpty = path.join(e.base, 'xdg-empty');
    fs.mkdirSync(xdgEmpty, { recursive: true });
    process.env.XDG_CONFIG_HOME = xdgEmpty;
    try {
      loaded = loadRosterConfig({ repoDir: repoBare });
      assert.equal(loaded.source, 'builtin');
      assert.equal(loaded.config.defaultProfile, 'quota-saver');
      assert.equal(globalRosterPath(), path.join(xdgEmpty, 'herdr-quad', 'roster.json'));
    } finally {
      process.env.XDG_CONFIG_HOME = e.xdg;
    }
  } finally {
    if (prevRosterEnv === undefined) delete process.env.HERDR_ROSTER_PATH;
    else process.env.HERDR_ROSTER_PATH = prevRosterEnv;
    if (prevXdgEnv === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgEnv;
    cleanupEnv(e);
  }
});

test('3. --repo 외부 저장소 일반화: 오케스트레이터 루트 해석 + 기본 사용자 DB 미오염', () => {
  const e = makeEnv(true);
  try {
    const foreign = path.join(e.base, 'foreign-repo');
    fs.mkdirSync(foreign, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: foreign, encoding: 'utf8' });

    // (a) launcher — 타 저장소 대상 dry-run: exit 0·target_repo·폴백 계약서·dg 절대경로
    const res = runLauncher(e, ['--mode', 'orchestrate', '--dry-run', '--repo', foreign, '--run-id', 'f1e2d3']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes(`target_repo=${foreign}`), res.stdout);
    assert.ok(res.stdout.includes(ORCH_ROLES_LEAD), 'role contract must fall back to orchestrator root');
    assert.ok(res.stdout.includes(`${ORCH_DG} wrap`), 'dg.ts must resolve against orchestrator root');
    assert.ok(res.stdout.includes('present (orchestrator fallback)'), res.stdout);
    assert.ok(!fs.existsSync(e.neverDb), 'dry-run must not create the orchestration DB');
    assert.ok(!fs.existsSync(`${e.neverDb}-wal`) && !fs.existsSync(`${e.neverDb}-shm`));

    // (b) dispatch CLI — 임의 cwd에서 --repo 타 저장소 지정 (동작·출력 검증)
    const cli = spawnSync(
      process.execPath,
      [DISPATCH_PATH, '--task-kind', 'single_edit', '--repo', foreign, '--dry-run'],
      { env: e.env, encoding: 'utf8', cwd: os.tmpdir() }
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.stdout.includes(`target_repo=${foreign}`), cli.stdout);
    assert.ok(cli.stdout.includes(`--cwd ${foreign}`), cli.stdout);
    assert.ok(cli.stdout.includes(ORCH_ROLES_LEAD), 'lead contract falls back to orchestrator root');
    assert.ok(!fs.existsSync(e.neverDb), 'dispatch --dry-run must not create the DB');

    // (c) planDispatch의 project_id는 --repo 기준 (외부 저장소 git 루트로 스코핑)
    const plan = planDispatch({ taskKind: 'single_edit', repoDir: foreign, runId: 'f1e2d3', dryRun: true });
    assert.equal(plan.targetRepo, foreign);
    assert.ok(plan.hcCommands[0]!.includes(foreign), 'hc run --cwd must target the foreign repo');
  } finally {
    cleanupEnv(e);
  }
});

test('4. 깨진 roster.json → stderr 경고 + 내장 quota-saver 안전 폴백 (크래시 0)', () => {
  const e = makeEnv();
  try {
    const broken = path.join(e.base, 'broken-roster.json');
    fs.writeFileSync(broken, '{ "defaultProfile": "quota-saver", "profiles": { oops');

    // (a) 단위 — builtin 폴백 + 경고
    const loaded = loadRosterConfig({ rosterPath: broken });
    assert.equal(loaded.source, 'builtin');
    assert.ok(loaded.warnings.length >= 1, 'broken JSON must produce a warning');
    assert.equal(loaded.config.defaultProfile, 'quota-saver');
    const qs = loaded.config.profiles['quota-saver']!;
    assert.equal(countStandingSessionsByBucket(qs, 'agy'), 0);
    assert.equal(countMaxOndemandByBucket(qs, 'agy'), 0);
    // B2: 내장 quota-saver verifier는 bash 미포함 (§6.1 Layer 3 — --tools read,grep,find,ls)
    const verifierArgv = buildWorkerCommand(qs.roles.verifier!, { prompt: '검증' });
    assert.ok(verifierArgv.includes('read,grep,find,ls'), verifierArgv.join(' '));
    assert.ok(!verifierArgv.join(' ').includes('bash'), `builtin verifier must not carry bash: ${verifierArgv.join(' ')}`);

    // (b) launcher e2e — 깨진 --roster로도 exit 0·quota-saver 폴백
    const res = runLauncher(e, ['--mode', 'orchestrate', '--dry-run', '--roster', broken, '--repo', e.repo]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /profile=quota-saver/);
    assert.match(res.stdout, /standing_agy_sessions=0/);
    assert.match(res.stdout, /roster_source=builtin/);
    assert.ok(res.stderr.includes('[roster]'), 'stderr warning expected');

    // (c) 미정의 프로필 요청 → 내장 폴백 + 경고 (크래시 아님)
    const res2 = runLauncher(e, [
      '--mode', 'orchestrate', '--dry-run', '--profile', 'no-such-profile', '--repo', e.repo,
    ]);
    assert.equal(res2.status, 0, res2.stderr);
    assert.match(res2.stdout, /profile=quota-saver/);
    assert.ok(res2.stdout.includes('not defined'), res2.stdout);
  } finally {
    cleanupEnv(e);
  }
});

test('5. buildWorkerCommand CLI별 어셈블리 계약 (pi·devin·agy·claude·버킷 추론)', () => {
  // (a) pi readonly — 기본 읽기전용 도구 + 항상 --no-approve. argv[0]는 기계 고유 경로가
  //     아니라 resolveWorkerBin(spec.bin > env > PATH > 폴백) 해석 결과다.
  const piBin = resolveWorkerBin('pi');
  const pi = buildWorkerCommand(
    { cli: 'pi', provider: 'opencodex', model: 'm1', thinking: 'high', readonly: true },
    { prompt: '조사하라' }
  );
  assert.deepEqual(pi, [
    piBin, '--provider', 'opencodex', '--model', 'm1', '--thinking', 'high',
    '--tools', 'read,grep,find,ls', '--no-extensions', '--no-mcp', '--no-approve', '조사하라',
  ]);
  // (a2) 실행 파일 해석 우선순위 — spec.bin > 환경변수(PI_BIN)
  const prevPiBin = process.env.PI_BIN;
  process.env.PI_BIN = '/fake-bin/pi';
  try {
    assert.equal(resolveWorkerBin('pi'), '/fake-bin/pi');
    assert.equal(buildWorkerCommand({ cli: 'pi', readonly: true }, { prompt: 'x' })[0], '/fake-bin/pi');
    assert.equal(resolveWorkerBin('pi', '/spec-bin/pi'), '/spec-bin/pi', 'spec.bin must beat PI_BIN');
    assert.equal(buildWorkerCommand({ cli: 'pi', bin: '/spec-bin/pi', readonly: true }, { prompt: 'x' })[0], '/spec-bin/pi');
  } finally {
    if (prevPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prevPiBin;
  }

  // (b) pi readonly + extraArgs bash — edit,write 자동 배제
  const piBash = buildWorkerCommand(
    { cli: 'pi', readonly: true, extraArgs: ['--tools', 'read,grep,find,ls,bash'] },
    { prompt: '검증하라' }
  );
  const joined = piBash.join(' ');
  assert.ok(joined.includes('--tools read,grep,find,ls,bash'), joined);
  assert.ok(joined.includes('--exclude-tools edit,write'), joined);
  assert.ok(joined.includes('--no-approve'), joined);

  // (c) agy — 프롬프트는 항상 -i, --print·--system-prompt 금지, readonly → plan
  const agyBin = resolveWorkerBin('agy');
  const agyRo = buildWorkerCommand({ cli: 'agy', model: 'gemini-x', readonly: true }, { prompt: '자문하라' });
  assert.deepEqual(agyRo, [agyBin, '--model', 'gemini-x', '--mode', 'plan', '--dangerously-skip-permissions', '-i', '자문하라']);
  const agyAuto = buildWorkerCommand({ cli: 'agy', model: 'gemini-x', permissionMode: 'auto' }, { prompt: 'p' });
  assert.ok(agyAuto.includes('--mode') && agyAuto[agyAuto.indexOf('--mode') + 1] === 'auto', agyAuto.join(' '));
  for (const argv of [agyRo, agyAuto]) {
    assert.ok(!argv.includes('--print') && !argv.includes('--system-prompt'), 'agy must never use --print/--system-prompt');
    assert.equal(argv[argv.indexOf('-i') + 1], argv[argv.length - 1], 'prompt must be the -i value');
  }

  // (d) devin — --permission-mode auto + '--' 뒤 프롬프트
  const devin = buildWorkerCommand({ cli: 'devin' }, { prompt: '임무' });
  assert.deepEqual(devin, [resolveWorkerBin('devin'), '--permission-mode', 'auto', '--', '임무']);

  // (e) claude — bin·model·프롬프트 조립 + {brief} 치환
  const claude = buildWorkerCommand(
    { cli: 'claude', bin: '/fake/claude', model: 'c-1' },
    { prompt: '브리프 {brief} 를 읽어라', roleBriefPath: '/tmp/brief.md' }
  );
  assert.deepEqual(claude, ['/fake/claude', '--model', 'c-1', '브리프 /tmp/brief.md 를 읽어라']);

  // (f) 버킷 추론 — pi→opencodex, agy→agy, custom→undefined, 명시 우선
  assert.equal(effectiveQuotaBucket({ cli: 'pi' }), 'opencodex');
  assert.equal(effectiveQuotaBucket({ cli: 'agy' }), 'agy');
  assert.equal(effectiveQuotaBucket({ cli: 'devin' }), 'devin');
  assert.equal(effectiveQuotaBucket({ cli: 'custom' }), undefined);
  assert.equal(effectiveQuotaBucket({ cli: 'pi', quotaBucket: 'agy' }), 'agy');

  // (g) 내장 스펙 — 예시 파일 스키마와 동일 구조로 로드 가능
  const example = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.herdr', 'roster.example.json'), 'utf8')) as {
    defaultProfile: string;
    profiles: Record<string, { roles: Record<string, object> }>;
  };
  const merged = loadRosterConfig({ rosterPath: path.join(REPO_ROOT, '.herdr', 'roster.example.json') });
  assert.equal(merged.source, 'flag');
  assert.equal(merged.config.defaultProfile, example.defaultProfile);
  for (const name of ['quota-saver', 'agy-quad', 'devin-lead', 'claude-hybrid']) {
    assert.ok(merged.config.profiles[name], `example profile ${name} must load`);
  }
  const agyQuad = merged.config.profiles['agy-quad']!;
  assert.equal(countStandingSessionsByBucket(agyQuad, 'agy'), 3);
  assert.equal(countMaxOndemandByBucket(agyQuad, 'agy'), 3);
  assert.equal(builtinRosterConfig().profiles['quota-saver']!.roles.lead!.model, 'glm-zcode/glm-5.3');

  // (h) B2 — 예시 파일 quota-saver verifier도 읽기전용 도구만 (bash 미포함)
  const exVerifier = buildWorkerCommand(merged.config.profiles['quota-saver']!.roles.verifier!, { prompt: '검증하라' }).join(' ');
  assert.ok(exVerifier.includes('--tools read,grep,find,ls'), exVerifier);
  assert.ok(!exVerifier.includes('bash'), `example verifier must not carry bash: ${exVerifier}`);
});
