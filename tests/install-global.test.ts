// Tests for scripts/install-global.ts: dry-run safety, wrapper install/exec,
// uninstall isolation, and non-dgate overwrite refusal. Node built-ins only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-global.ts');
const WRAPPER_NAMES = ['dgate-tui', 'dgate-gui', 'dg', 'dgate'];

function tmpBinDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dgate-install-test-'));
}

function runInstaller(args) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('--dry-run creates 0 files', () => {
  const bin = tmpBinDir();
  const { status } = runInstaller(['--bin-dir', bin, '--dry-run']);
  assert.equal(status, 0);
  assert.deepEqual(fs.readdirSync(bin), []);
  fs.rmSync(bin, { recursive: true, force: true });
});

test('install creates 4 executable wrappers; dg --help and dgate-tui --help exit 0', () => {
  const bin = tmpBinDir();
  // --platform posix: Windows 호스트에서 네이티브 실행해도 .cmd가 아니라 POSIX 래퍼를 검증한다.
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'posix']);
  assert.equal(status, 0, stderr);
  for (const name of WRAPPER_NAMES) {
    const file = path.join(bin, name);
    assert.ok(fs.existsSync(file), `missing ${name}`);
    // 실행 비트 검사는 POSIX 호스트에서만 유효 — win32 stat은 항상 0o666를 보고한다.
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(file).mode & 0o111, `${name} not executable`);
    }
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.split('\n')[1] === '# dgate-global-wrapper', `${name} missing marker`);
    // v2 계약 — release → debug → 빌드 안내 + exit 1 (node/src 폴백 없음)
    assert.ok(content.includes(`target/release/${name}`), `${name} release check`);
    assert.ok(content.includes(`target/debug/${name}`), `${name} debug check`);
    assert.ok(content.includes('exit 1'), `${name} exit 1 on missing binary`);
    assert.ok(!content.includes('src/'), `${name} must not reference src/ fallback`);
  }
  if (process.platform === 'win32') {
    // win32 호스트 — POSIX sh 래퍼는 실행 불가: 같은 인스톨러로 .cmd 래퍼를 만들어 그것을 실행 검증한다.
    const binCmd = tmpBinDir();
    assert.equal(runInstaller(['--bin-dir', binCmd, '--platform', 'win32']).status, 0);
    for (const cmd of ['dg', 'dgate-tui']) {
      const r = spawnSync('cmd.exe', ['/c', path.join(binCmd, `${cmd}.cmd`), '--help'], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${cmd}.cmd --help failed: ${r.stderr}`);
    }
    fs.rmSync(binCmd, { recursive: true, force: true });
  } else {
    for (const cmd of ['dg', 'dgate-tui']) {
      const r = spawnSync(path.join(bin, cmd), ['--help'], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${cmd} --help failed: ${r.stderr}`);
    }
  }
  fs.rmSync(bin, { recursive: true, force: true });
});

test('--uninstall removes ONLY dgate wrappers, leaves unrelated files untouched', () => {
  const bin = tmpBinDir();
  assert.equal(runInstaller(['--bin-dir', bin, '--platform', 'posix']).status, 0);
  const userFile = path.join(bin, 'my-own-tool');
  fs.writeFileSync(userFile, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'posix', '--uninstall']);
  assert.equal(status, 0, stderr);
  for (const name of WRAPPER_NAMES) {
    assert.ok(!fs.existsSync(path.join(bin, name)), `${name} still present`);
  }
  assert.ok(fs.existsSync(userFile), 'unrelated user file was removed!');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('refuses to overwrite a non-dgate file with the same name', () => {
  const bin = tmpBinDir();
  const file = path.join(bin, 'dg');
  fs.writeFileSync(file, '#!/bin/sh\necho precious\n', { mode: 0o755 });
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'posix']);
  assert.equal(status, 1);
  assert.ok(stderr.includes('Refusing to overwrite'), stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho precious\n');
  fs.rmSync(bin, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Windows(.cmd) 래퍼 — --platform win32 로 모든 호스트에서 결정적 검증
// ---------------------------------------------------------------------------

test('win32: install creates 4 .cmd wrappers (@echo off + rem marker, no posix files)', () => {
  const bin = tmpBinDir();
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'win32']);
  assert.equal(status, 0, stderr);
  for (const name of WRAPPER_NAMES) {
    const file = path.join(bin, `${name}.cmd`);
    assert.ok(fs.existsSync(file), `missing ${name}.cmd`);
    const lines = fs.readFileSync(file, 'utf8').split('\r\n');
    assert.equal(lines[0], '@echo off', `${name}.cmd first line`);
    assert.equal(lines[1], 'rem dgate-global-wrapper', `${name}.cmd marker on line 2`);
    assert.ok(!fs.existsSync(path.join(bin, name)), `posix wrapper ${name} must not be created on win32`);
  }
  // v2 계약 — 모든 래퍼는 release .exe → debug .exe → 빌드 안내 + exit /b 1.
  // Node v1(src/*)·cargo run 폴백은 존재하지 않는다.
  for (const name of WRAPPER_NAMES) {
    const w = fs.readFileSync(path.join(bin, `${name}.cmd`), 'utf8');
    assert.ok(w.includes(`target\\release\\${name}.exe`), `${name} release .exe check`);
    assert.ok(w.includes(`target\\debug\\${name}.exe`), `${name} debug .exe check`);
    assert.ok(w.includes('cargo build --release --workspace'), `${name} build hint`);
    assert.ok(w.includes('exit /b 1'), `${name} exit /b 1 on missing binary`);
    assert.ok(!w.includes('.ts'), `${name} must not reference node .ts fallback`);
    assert.ok(!w.includes('cargo run'), `${name} must not fall back to cargo run`);
  }
  fs.rmSync(bin, { recursive: true, force: true });
});

test('win32: --uninstall removes ONLY managed .cmd files; unmanaged files untouched', () => {
  const bin = tmpBinDir();
  assert.equal(runInstaller(['--bin-dir', bin, '--platform', 'win32']).status, 0);
  const userCmd = path.join(bin, 'my-own-tool.cmd');
  fs.writeFileSync(userCmd, '@echo off\r\nrem my tool\r\n');
  const userSh = path.join(bin, 'dg'); // 같은 basename의 비관리 posix 파일도 보호되어야 한다
  fs.writeFileSync(userSh, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'win32', '--uninstall']);
  assert.equal(status, 0, stderr);
  for (const name of WRAPPER_NAMES) {
    assert.ok(!fs.existsSync(path.join(bin, `${name}.cmd`)), `${name}.cmd still present`);
  }
  assert.ok(fs.existsSync(userCmd), 'unmanaged user .cmd was removed!');
  assert.ok(fs.existsSync(userSh), 'unmanaged posix-name file was removed!');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('win32: refuses to overwrite a non-dgate .cmd file with the same name', () => {
  const bin = tmpBinDir();
  const file = path.join(bin, 'dg.cmd');
  fs.writeFileSync(file, '@echo off\r\nrem precious\r\n');
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'win32']);
  assert.equal(status, 1);
  assert.ok(stderr.includes('Refusing to overwrite'), stderr);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('@echo off\r\nrem precious'), 'original content intact');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('win32: --dry-run creates 0 files', () => {
  const bin = tmpBinDir();
  const { status } = runInstaller(['--bin-dir', bin, '--platform', 'win32', '--dry-run']);
  assert.equal(status, 0);
  assert.deepEqual(fs.readdirSync(bin), []);
  fs.rmSync(bin, { recursive: true, force: true });
});

test('invalid --platform value exits 2 with usage', () => {
  const bin = tmpBinDir();
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'plan9']);
  assert.equal(status, 2);
  assert.ok(stderr.includes('Invalid --platform'), stderr);
  fs.rmSync(bin, { recursive: true, force: true });
});

test('posix: re-running installer over managed wrappers is idempotent', () => {
  const bin = tmpBinDir();
  assert.equal(runInstaller(['--bin-dir', bin, '--platform', 'posix']).status, 0);
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--platform', 'posix']);
  assert.equal(status, 0, stderr);
  for (const name of WRAPPER_NAMES) {
    assert.ok(fs.existsSync(path.join(bin, name)));
  }
  fs.rmSync(bin, { recursive: true, force: true });
});
