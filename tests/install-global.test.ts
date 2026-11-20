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
  const { status, stderr } = runInstaller(['--bin-dir', bin]);
  assert.equal(status, 0, stderr);
  for (const name of WRAPPER_NAMES) {
    const file = path.join(bin, name);
    assert.ok(fs.existsSync(file), `missing ${name}`);
    assert.ok(fs.statSync(file).mode & 0o111, `${name} not executable`);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.split('\n')[1] === '# dgate-global-wrapper', `${name} missing marker`);
  }
  for (const cmd of ['dg', 'dgate-tui']) {
    const r = spawnSync(path.join(bin, cmd), ['--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} --help failed: ${r.stderr}`);
  }
  fs.rmSync(bin, { recursive: true, force: true });
});

test('--uninstall removes ONLY dgate wrappers, leaves unrelated files untouched', () => {
  const bin = tmpBinDir();
  assert.equal(runInstaller(['--bin-dir', bin]).status, 0);
  const userFile = path.join(bin, 'my-own-tool');
  fs.writeFileSync(userFile, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const { status, stderr } = runInstaller(['--bin-dir', bin, '--uninstall']);
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
  const { status, stderr } = runInstaller(['--bin-dir', bin]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('Refusing to overwrite'), stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho precious\n');
  fs.rmSync(bin, { recursive: true, force: true });
});
