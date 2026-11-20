#!/usr/bin/env node
// dgate global installer: creates POSIX sh wrapper scripts in a bin dir so
// dgate-tui / dgate-gui / dg / dgate can run from any repository.
// Node.js built-ins only — 0 external dependencies, no hardcoded user paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_MARK = '# dgate-global-wrapper';
const WRAPPER_NAMES = ['dgate-tui', 'dgate-gui', 'dg', 'dgate'];

function shQuote(s) {
  // POSIX single-quote escaping: 'foo' -> '\''foo'\'' wrapped in quotes
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function wrapperContent(name) {
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

const HELP = `Usage: node scripts/install-global.ts [options]

Install global wrapper scripts (dgate-tui, dgate-gui, dg, dgate) into a bin dir.

Options:
  --bin-dir <dir>  Target bin directory (default: $DGATE_BIN_DIR or ~/.local/bin)
  --uninstall      Remove only dgate-managed wrappers from the bin dir
  --dry-run        Show what would be done without writing anything
  --help           Show this help
`;

function isDgateWrapper(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines[1] === WRAPPER_MARK;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = { binDir: null, uninstall: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bin-dir') opts.binDir = argv[++i];
    else if (a.startsWith('--bin-dir=')) opts.binDir = a.slice('--bin-dir='.length);
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else { console.error(`Unknown option: ${a}\n`); console.error(HELP); process.exit(2); }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const binDir = opts.binDir || process.env.DGATE_BIN_DIR || path.join(os.homedir(), '.local', 'bin');

  if (opts.uninstall) {
    for (const name of WRAPPER_NAMES) {
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
  for (const name of WRAPPER_NAMES) {
    const file = path.join(binDir, name);
    if (fs.existsSync(file) && !isDgateWrapper(file)) {
      console.error(`Refusing to overwrite non-dgate file: ${file}`);
      process.exitCode = 1;
      continue;
    }
    if (opts.dryRun) { console.log(`[dry-run] would write ${file}`); continue; }
    fs.writeFileSync(file, wrapperContent(name), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    console.log(`Installed ${file}`);
  }

  if (opts.dryRun) { console.log('Dry run complete (no files written).'); return; }

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  if (!pathDirs.includes(binDir)) {
    console.log(`Note: ${binDir} is not in your PATH. Add it with:\n  export PATH="${binDir}:$PATH"`);
  }
  console.log('Install complete. Try: dgate-tui --help');
}

main();
