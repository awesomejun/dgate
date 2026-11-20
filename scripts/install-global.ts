#!/usr/bin/env node
// dgate global installer: creates wrapper scripts in a bin dir so
// dgate-tui / dgate-gui / dg / dgate can run from any repository.
// POSIX host -> sh wrappers; Windows host -> .cmd wrappers
// (`--platform win32|posix` forces a flavor for deterministic testing anywhere).
// Node.js built-ins only — 0 external dependencies, no hardcoded user paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_MARK = '# dgate-global-wrapper';
const WRAPPER_MARK_CMD = 'rem dgate-global-wrapper';
const WRAPPER_NAMES = ['dgate-tui', 'dgate-gui', 'dg', 'dgate'];

function shQuote(s) {
  // POSIX single-quote escaping: 'foo' -> '\''foo'\'' wrapped in quotes
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function wrapperContent(name, platform) {
  return platform === 'win32' ? cmdWrapperContent(name) : shWrapperContent(name);
}

function shWrapperContent(name) {
  const root = shQuote(REPO_ROOT);
  const header = `#!/bin/sh\n${WRAPPER_MARK}\n`;
  switch (name) {
    case 'dgate-tui':
      return `${header}exec node ${root}/src/cli.ts --watch "$@"\n`;
    case 'dgate-gui':
      return `${header}if [ -x ${root}/target/release/dgate-gui ]; then exec ${root}/target/release/dgate-gui "$@"; elif [ -x ${root}/target/debug/dgate-gui ]; then exec ${root}/target/debug/dgate-gui "$@"; else exec cargo run --release --manifest-path ${root}/Cargo.toml -p dgate-gui -- "$@"; fi\n`;
    case 'dg':
      return `${header}if [ -x ${root}/target/release/dg ]; then exec ${root}/target/release/dg "$@"; else exec node ${root}/src/decision/dg.ts "$@"; fi\n`;
    case 'dgate':
      return `${header}if [ -x ${root}/target/release/dgate ]; then exec ${root}/target/release/dgate "$@"; else exec node ${root}/src/cli.ts "$@"; fi\n`;
    default:
      throw new Error(`unknown wrapper: ${name}`);
  }
}

// Windows .cmd wrappers — CRLF 배치 문법. 네이티브 바이너리(.exe) 우선,
// 실패 시 node / cargo run --release 폴백.
function cmdWrapperContent(name) {
  const root = REPO_ROOT.replace(/\//g, '\\');
  const header = `@echo off\r\n${WRAPPER_MARK_CMD}\r\n`;
  switch (name) {
    case 'dgate-tui':
      return `${header}node "${root}\\src\\cli.ts" --watch %*\r\n`;
    case 'dgate-gui':
      return `${header}if exist "${root}\\target\\release\\dgate-gui.exe" (\r\n  "${root}\\target\\release\\dgate-gui.exe" %*\r\n) else if exist "${root}\\target\\debug\\dgate-gui.exe" (\r\n  "${root}\\target\\debug\\dgate-gui.exe" %*\r\n) else (\r\n  cargo run --release --manifest-path "${root}\\Cargo.toml" -p dgate-gui -- %*\r\n)\r\n`;
    case 'dg':
      return `${header}if exist "${root}\\target\\release\\dg.exe" (\r\n  "${root}\\target\\release\\dg.exe" %*\r\n) else (\r\n  node "${root}\\src\\decision\\dg.ts" %*\r\n)\r\n`;
    case 'dgate':
      return `${header}if exist "${root}\\target\\release\\dgate.exe" (\r\n  "${root}\\target\\release\\dgate.exe" %*\r\n) else (\r\n  node "${root}\\src\\cli.ts" %*\r\n)\r\n`;
    default:
      throw new Error(`unknown wrapper: ${name}`);
  }
}

function wrapperNames(platform) {
  return platform === 'win32' ? WRAPPER_NAMES.map((n) => `${n}.cmd`) : WRAPPER_NAMES;
}

const HELP = `Usage: node scripts/install-global.ts [options]

Install global wrapper scripts (dgate-tui, dgate-gui, dg, dgate) into a bin dir.

Options:
  --bin-dir <dir>        Target bin directory (default: $DGATE_BIN_DIR or ~/.local/bin)
  --platform <platform>  Force wrapper flavor: win32 (.cmd) or posix (sh)
                          (default: host platform — deterministic testing on any host)
  --uninstall            Remove only dgate-managed wrappers from the bin dir
  --dry-run              Show what would be done without writing anything
  --help                 Show this help
`;

// 관리 여부 판정 — 2번째 줄 마커(sh '# …' / cmd 'rem …' 양쪽 모두)로만 식별한다.
// 마커가 없는 사용자 파일은 절대 건드리지 않는다.
function isDgateWrapper(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const mark = lines.length > 1 ? lines[1].trim() : '';
    return mark === WRAPPER_MARK || mark === WRAPPER_MARK_CMD;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = { binDir: null, uninstall: false, dryRun: false, help: false, platform: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bin-dir') opts.binDir = argv[++i];
    else if (a.startsWith('--bin-dir=')) opts.binDir = a.slice('--bin-dir='.length);
    else if (a === '--platform') opts.platform = argv[++i];
    else if (a.startsWith('--platform=')) opts.platform = a.slice('--platform='.length);
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else { console.error(`Unknown option: ${a}\n`); console.error(HELP); process.exit(2); }
  }
  return opts;
}

function resolvePlatform(flag) {
  if (flag === 'win32' || flag === 'posix') return flag;
  if (flag !== null && flag !== undefined) {
    console.error(`Invalid --platform: ${flag} (expected win32|posix)\n`);
    process.exit(2);
  }
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function printPathHint(binDir, platform) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  if (pathDirs.includes(binDir)) return;
  if (platform === 'win32') {
    console.log(`Note: ${binDir} is not in your PATH. In PowerShell:\n  $env:Path += ";${binDir}"\n  # permanent (User PATH):\n  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${binDir}', 'User')`);
  } else {
    console.log(`Note: ${binDir} is not in your PATH. Add it with:\n  export PATH="${binDir}:$PATH"`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const platform = resolvePlatform(opts.platform);
  const binDir = opts.binDir || process.env.DGATE_BIN_DIR || path.join(os.homedir(), '.local', 'bin');

  if (opts.uninstall) {
    for (const name of wrapperNames(platform)) {
      const file = path.join(binDir, name);
      if (!fs.existsSync(file)) continue;
      if (!isDgateWrapper(file)) {
        console.error(`Refusing to remove non-dgate file: ${file}`);
        process.exitCode = 1;
        continue;
      }
      if (opts.dryRun) { console.log(`[dry-run] would remove ${file}`); continue; }
      fs.rmSync(file);
      console.log(`Removed ${file}`);
    }
    console.log('Uninstall complete.');
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });
  for (const fileName of wrapperNames(platform)) {
    const name = fileName.replace(/\.cmd$/, ''); // 래퍼 로직은 플랫폼 공통 베이스명으로 분기
    const file = path.join(binDir, fileName);
    if (fs.existsSync(file) && !isDgateWrapper(file)) {
      console.error(`Refusing to overwrite non-dgate file: ${file}`);
      process.exitCode = 1;
      continue;
    }
    if (opts.dryRun) { console.log(`[dry-run] would write ${file}`); continue; }
    fs.writeFileSync(file, wrapperContent(name, platform), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    console.log(`Installed ${file}`);
  }

  if (opts.dryRun) { console.log('Dry run complete (no files written).'); return; }

  printPathHint(binDir, platform);
  console.log('Install complete. Try: dgate-tui --help');
}

main();
