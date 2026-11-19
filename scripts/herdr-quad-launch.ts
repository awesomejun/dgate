#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveBinary(name: string, fallback: string): string {
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return name;
}

const HERDR_APP = resolveBinary('herdr-app', path.join(os.homedir(), '.local/bin/herdr-app'));
const HC_BIN = resolveBinary('hc', path.join(os.homedir(), '.local/bin/hc'));

interface LaunchOptions {
  mode: 'demo' | 'live' | 'watch';
  prompt: string | null;
  folder: string;
  tabName: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): LaunchOptions {
  const opts: LaunchOptions = {
    mode: 'demo',
    prompt: null,
    folder: PROJECT_ROOT,
    tabName: 'Gemini Quad (Argon·Carbon·Neon·Hydrogen)',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--mode': {
        const m = argv[++i];
        if (m === 'demo' || m === 'live' || m === 'watch') {
          opts.mode = m;
        }
        break;
      }
      case '--live':
      case '--agy':
        opts.mode = 'live';
        break;
      case '--demo':
        opts.mode = 'demo';
        break;
      case '--watch':
        opts.mode = 'watch';
        break;
      case '--prompt':
      case '-p':
        opts.prompt = argv[++i] ?? null;
        if (opts.mode === 'demo') opts.mode = 'live';
        break;
      case '--folder':
      case '--cwd':
        opts.folder = path.resolve(argv[++i] ?? PROJECT_ROOT);
        break;
      case '--name':
      case '--tab':
        opts.tabName = argv[++i] ?? opts.tabName;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Herdr Gemini Quad Orchestrator Launcher
=======================================
Herdr App 창을 자동으로 4분할하여 Argon, Carbon, Neon, Hydrogen 패널을 실행·오케스트레이션합니다.

사용법:
  node ./scripts/herdr-quad-launch.ts [옵션]

옵션:
  --mode <demo|live|watch>   실행 모드 (기본: demo)
  --live                     실제 Antigravity(agy)/Gemini API 연동 모드
  --demo                     40초 멀티 에이전트 시나리오 데모 (기본값)
  --watch                    현재 실행 중인 agy 세션 트랜스크립트 실시간 관제
  --prompt, -p <text>        초기 프롬프트 (지정 시 --live 자동 전환)
  --folder <path>            작업 디렉터리 (기본: 현재 프로젝트)
  --name <title>             새 탭 이름
  --dry-run                  실행하지 않고 명령어만 출력
`);
        process.exit(0);
    }
  }
  return opts;
}

function runJson(bin: string, args: string[], dryRun: boolean): any {
  if (dryRun) {
    console.log(`[DRY-RUN] ${bin} ${args.join(' ')}`);
    return { pane: 'p_mock', terminal: 't_mock', focused_pane: 'p_mock' };
  }
  const out = execFileSync(bin, args, { encoding: 'utf8' });
  try {
    return JSON.parse(out);
  } catch {
    return out.trim();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureHerdrRunning(dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const check = spawnSync(HERDR_APP, ['status'], { encoding: 'utf8' });
  if (check.status === 0) return;

  console.log('🚀 Herdr App이 실행 중이지 않아 시작합니다...');
  spawnSync('open', ['-a', 'Herdr'], { encoding: 'utf8' });
  for (let i = 0; i < 15; i++) {
    await sleep(500);
    const retry = spawnSync(HERDR_APP, ['status'], { encoding: 'utf8' });
    if (retry.status === 0) return;
  }
  throw new Error('Herdr App 상태를 확인할 수 없습니다. Herdr가 설치되어 실행 중인지 확인하세요.');
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await ensureHerdrRunning(opts.dryRun);

  console.log(`\n📐 Herdr 4분할(Quad) 패널을 생성합니다 (${opts.mode} 모드)...`);

  // 1. 새 탭 생성 (Top-Left: Argon)
  const tabRes = runJson(
    HERDR_APP,
    ['do', 'tab.new', '--name', opts.tabName, '--folder', opts.folder],
    opts.dryRun
  );
  const tTL = tabRes.terminal as string;

  const statusRes = runJson(HERDR_APP, ['status'], opts.dryRun);
  const pTL = (statusRes.focused_pane as string) || 'p_tl';

  // 2. 우측 분할 (Top-Right: Carbon)
  const splitRightRes = runJson(
    HERDR_APP,
    ['do', 'pane.split', '--pane', pTL, '--direction', 'right'],
    opts.dryRun
  );
  const pTR = splitRightRes.pane as string;
  const tTR = splitRightRes.terminal as string;

  // 3. 좌측 하단 분할 (Bottom-Left: Neon)
  const splitLeftDownRes = runJson(
    HERDR_APP,
    ['do', 'pane.split', '--pane', pTL, '--direction', 'down'],
    opts.dryRun
  );
  const pBL = splitLeftDownRes.pane as string;
  const tBL = splitLeftDownRes.terminal as string;

  // 4. 우측 하단 분할 (Bottom-Right: Hydrogen)
  const splitRightDownRes = runJson(
    HERDR_APP,
    ['do', 'pane.split', '--pane', pTR, '--direction', 'down'],
    opts.dryRun
  );
  const pBR = splitRightDownRes.pane as string;
  const tBR = splitRightDownRes.terminal as string;

  // 5. 터미널 라벨 부여
  const labels: Array<[string, string[]]> = [
    [tTL, ['name=Argon', 'role=lead', 'model=gemini-4-argon-high']],
    [tTR, ['name=Carbon', 'role=advisor', 'model=gemini-4-carbon-high']],
    [tBL, ['name=Neon', 'role=verifier', 'model=gemini-4-neon-high']],
    [tBR, ['name=Hydrogen', 'role=swarm', 'model=gemini-4-hydrogen-high']],
  ];
  for (const [term, kv] of labels) {
    if (!opts.dryRun) {
      spawnSync(HC_BIN, ['label', term, ...kv], { encoding: 'utf8' });
    }
  }

  // 6. 각 패널별 실행 명령 조립
  const modeFlag = `--${opts.mode}`;
  const promptArg = opts.prompt ? ` --prompt ${shellEscape(opts.prompt)}` : '';
  const cdPrefix = `cd ${shellEscape(PROJECT_ROOT)} && `;

  const cmdArgon = `${cdPrefix}node ./src/cli.ts --quad --role argon --hub ${modeFlag}${promptArg}`;
  const cmdCarbon = `${cdPrefix}node ./src/cli.ts --quad --role carbon ${modeFlag}`;
  const cmdNeon = `${cdPrefix}node ./src/cli.ts --quad --role neon ${modeFlag}`;
  const cmdHydrogen = `${cdPrefix}node ./src/cli.ts --quad --role hydrogen ${modeFlag}`;

  // 7. Hub(Argon) 먼저 실행 후 클라이언트 패널 실행
  console.log(`  ◈ [Top-Left]     Argon    (${tTL} / ${pTL}) -> Lead Orchestrator`);
  runJson(HC_BIN, ['send', tTL, cmdArgon], opts.dryRun);

  await sleep(350);

  console.log(`  ⬡ [Top-Right]    Carbon   (${tTR} / ${pTR}) -> Strategic Advisor`);
  runJson(HC_BIN, ['send', tTR, cmdCarbon], opts.dryRun);

  console.log(`  ✦ [Bottom-Left]  Neon     (${tBL} / ${pBL}) -> Cross-Verifier`);
  runJson(HC_BIN, ['send', tBL, cmdNeon], opts.dryRun);

  console.log(`  ❖ [Bottom-Right] Hydrogen (${tBR} / ${pBR}) -> Swarm Fleet`);
  runJson(HC_BIN, ['send', tBR, cmdHydrogen], opts.dryRun);

  // 8. Argon 패널로 포커스 복귀
  runJson(HERDR_APP, ['do', 'pane.focus', '--pane', pTL], opts.dryRun);

  console.log(`\n✅ Herdr 4분할 Gemini 오케스트레이션 화면 구성 완료!`);
  console.log(`   - 탭: ${opts.tabName}`);
  console.log(`   - 패널 배치:`);
  console.log(`     ┌──────────────────────┬──────────────────────┐`);
  console.log(`     │ ◈ Argon (Lead)       │ ⬡ Carbon (Advisor)   │`);
  console.log(`     ├──────────────────────┼──────────────────────┤`);
  console.log(`     │ ✦ Neon (Verifier)    │ ❖ Hydrogen (Swarm)   │`);
  console.log(`     └──────────────────────┴──────────────────────┘\n`);
}

main().catch((err) => {
  console.error('❌ 오류:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
