/**
 * PB-2B 테스트 매트릭스 (brief-pb2b §3.D): Git-Native 체크포인트 + 읽기전용 `dg report`.
 *
 * ① 체크포인트 생성·검증·변조 감지·복원 왕복 — staged/unstaged/untracked/심볼릭 링크·
 *    실행비트까지 원본과 100% 일치 (T14 + 변조 1바이트 → invalid)
 * ② 삭제 게이트 불변식 — 읽기전용 checkpointRoot·용량 초과 시 exitCode 4 + 워크트리 보존,
 *    정상 검증 통과 시에만 removed:true (T15)
 * ③ 경로 순회 차단 — manifest에 `../escape.txt` 변조 삽입 시 verify/restore 거부 (T16 변형)
 * ④ `generateRuleCandidateReport` 읽기전용 — v1·v2 DB 파일 해시·행수·`.herdr/roles/*`
 *    해시 전후 불변 + v1 폴백(snippet 파싱)/v2 컬럼 집계 정합성 (T17·T18)
 * ⑤ `validateReportOutPath` allowlist — 저장소 내부 민감 경로 전부 거부,
 *    `.herdr/report/`·저장소 외부 허용, 심볼릭 링크 우회 차단 (T19 / 검증서 A-1)
 *
 * 실행: `node --test tests/phaseb-checkpoint-report.test.ts` (외부 의존성 0개)
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  computeManifestDigest,
  createWorktreeCheckpoint,
  MAX_CHECKPOINT_BYTES,
  restoreWorktreeCheckpoint,
  safeRemoveWorktree,
  verifyWorktreeCheckpoint,
} from '../src/decision/checkpoint.ts';
import { migrateV1Tables, openDb } from '../src/decision/db.ts';
import {
  formatReportMarkdown,
  generateRuleCandidateReport,
  openReportDb,
  validateReportOutPath,
  writeReportFileSafe,
} from '../src/decision/report.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function mkBase(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-`));
}

function git(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function hashTree(dir: string): string {
  const h = createHash('sha256');
  for (const name of fs.readdirSync(dir).sort()) {
    h.update(name, 'utf8');
    h.update(fs.readFileSync(path.join(dir, name)));
  }
  return h.digest('hex');
}

function initRepo(base: string): string {
  const repo = path.join(base, 'repo');
  const noHooks = path.join(base, 'nohooks');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(noHooks, { recursive: true });
  gitOk(repo, ['init', '-q']);
  gitOk(repo, ['config', 'user.email', 'pb2b@example.com']);
  gitOk(repo, ['config', 'user.name', 'pb2b-test']);
  gitOk(repo, ['config', 'commit.gpgsign', 'false']);
  gitOk(repo, ['config', 'core.hooksPath', noHooks]);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'v0\n');
  fs.writeFileSync(path.join(repo, 'tracked.md'), '# hello\n');
  gitOk(repo, ['add', '-A']);
  gitOk(repo, ['commit', '-qm', 'init']);
  return repo;
}

/** staged(base.txt→v2-idx) + unstaged(→v2-wt) + untracked(초안/실행파일/심볼릭 링크) */
function addWorktreeWithDirtyState(repo: string, wtName: string): string {
  const wt = path.join(path.dirname(repo), wtName);
  gitOk(repo, ['worktree', 'add', '-b', wtName, wt]);
  fs.writeFileSync(path.join(wt, 'base.txt'), 'v2-idx\n');
  gitOk(wt, ['add', 'base.txt']);
  fs.writeFileSync(path.join(wt, 'base.txt'), 'v2-wt\n');
  fs.mkdirSync(path.join(wt, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'notes', 'draft.txt'), 'draft-초안\n');
  fs.writeFileSync(path.join(wt, 'run.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(wt, 'run.sh'), 0o755);
  fs.symlinkSync('notes/draft.txt', path.join(wt, 'link.txt'));
  return wt;
}

test('T14 체크포인트 생성·검증·변조 감지·복원 왕복 — 원본 100% 일치', () => {
  const base = mkBase('pb2b-ckpt');
  try {
    const repo = initRepo(base);
    const wt = addWorktreeWithDirtyState(repo, 'coder-1');
    const head = gitOk(wt, ['rev-parse', 'HEAD']).trim();
    const ckptRoot = path.join(base, 'ckpt');

    const res = createWorktreeCheckpoint({ repoDir: repo, worktreeDir: wt, runId: 'run-1', checkpointRoot: ckptRoot });
    assert.equal(res.saved, true, `save failed: ${res.errors.join('; ')}`);
    assert.ok(res.checkpointDir);
    assert.equal(res.checkpointDir, path.join(ckptRoot, 'run-1', 'coder-1'));
    assert.equal(res.manifest?.schema_version, 1);
    assert.equal(res.manifest?.branch, 'coder-1');
    assert.equal(res.manifest?.head_sha, head);
    const relpaths = (res.manifest?.files ?? []).map((f) => `${f.relpath}|${f.kind}${f.symlink ? '|symlink' : ''}`);
    for (const expected of [
      'index.patch|index_patch',
      'worktree.patch|worktree_patch',
      'untracked/link.txt|untracked|symlink',
      'untracked/notes/draft.txt|untracked',
      'untracked/run.sh|untracked',
    ]) {
      assert.ok(relpaths.includes(expected), `manifest missing entry: ${expected} (got ${relpaths.join(', ')})`);
    }

    const v1 = verifyWorktreeCheckpoint(res.checkpointDir!);
    assert.equal(v1.valid, true, `verify failed: ${v1.errors.join('; ')}`);
    assert.equal(v1.manifest?.manifest_digest, res.manifest?.manifest_digest);

    // 1바이트 변조 → invalid
    const patchPath = path.join(res.checkpointDir!, 'index.patch');
    const orig = fs.readFileSync(patchPath);
    fs.writeFileSync(patchPath, Buffer.concat([orig, Buffer.from('X')]));
    const vBad = verifyWorktreeCheckpoint(res.checkpointDir!);
    assert.equal(vBad.valid, false, 'tampered checkpoint must be invalid');
    assert.ok(vBad.errors.some((e) => e.includes('mismatch') || e.includes('size')), vBad.errors.join('; '));
    fs.writeFileSync(patchPath, orig);
    assert.equal(verifyWorktreeCheckpoint(res.checkpointDir!).valid, true, 'restored checkpoint must verify again');

    // 새 worktree에 복원 → staged/unstaged/untracked/symlink/실행비트 전부 일치
    const target = path.join(base, 'coder-1-restore');
    gitOk(repo, ['worktree', 'add', '-b', 'coder-1-restore', target, head]);
    const rr = restoreWorktreeCheckpoint({ checkpointDir: res.checkpointDir!, targetWorktreeDir: target });
    assert.equal(rr.restored, true, `restore failed: ${rr.errors.join('; ')}`);

    assert.equal(fs.readFileSync(path.join(target, 'base.txt'), 'utf8'), 'v2-wt\n', 'unstaged 내용 일치');
    assert.equal(gitOk(target, ['show', ':base.txt']), 'v2-idx\n', 'staged(index) 내용 일치');
    assert.equal(fs.readFileSync(path.join(target, 'notes', 'draft.txt'), 'utf8'), 'draft-초안\n');
    const runSt = fs.statSync(path.join(target, 'run.sh'));
    assert.equal(runSt.mode & 0o777, 0o755, '실행 비트 보존');
    assert.equal(fs.readlinkSync(path.join(target, 'link.txt')), 'notes/draft.txt', '심볼릭 링크 대상 일치');

    // 원본 워크트리와 전체 diff 상태 동등성(패치 적용 결과 = 원본 상태)
    const origIndex = gitOk(wt, ['diff', '--cached', '--binary']);
    const restIndex = gitOk(target, ['diff', '--cached', '--binary']);
    assert.equal(restIndex, origIndex, '복원 worktree의 staged diff가 원본과 동일');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('T15 삭제 게이트 불변식 — 저장 실패 시 exitCode 4 + 워크트리 보존, 검증 통과 시에만 삭제', () => {
  const base = mkBase('pb2b-gate');
  try {
    const repo = initRepo(base);
    const wt = addWorktreeWithDirtyState(repo, 'coder-2');
    const ckptRoot = path.join(base, 'ckpt');
    fs.mkdirSync(ckptRoot, { recursive: true });

    // (a) 읽기전용 checkpointRoot — 체크포인트 저장 자체가 실패
    fs.chmodSync(ckptRoot, 0o500);
    const rmA = safeRemoveWorktree({ repoDir: repo, worktreeDir: wt, runId: 'run-2', checkpointRoot: ckptRoot });
    assert.equal(rmA.removed, false, '읽기전용 root에서는 삭제 거부');
    assert.equal(rmA.exitCode, 4, `게이트 거부 exitCode는 4 (got ${rmA.exitCode})`);
    assert.ok(rmA.errors.length > 0);
    assert.ok(fs.existsSync(path.join(wt, 'base.txt')), '워크트리가 그대로 보존되어야 한다');
    assert.ok(fs.existsSync(path.join(wt, 'notes', 'draft.txt')), 'untracked 파일도 보존');
    fs.chmodSync(ckptRoot, 0o755);

    // (b) 용량 초과(12MiB+) untracked — 저장 실패 → 삭제 거부 + 파일 보존
    const big = path.join(wt, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(MAX_CHECKPOINT_BYTES + 4096, 7));
    const rmB = safeRemoveWorktree({ repoDir: repo, worktreeDir: wt, runId: 'run-2b', checkpointRoot: ckptRoot });
    assert.equal(rmB.removed, false);
    assert.equal(rmB.exitCode, 4);
    assert.ok(rmB.errors.some((e) => e.includes('big.bin')), `용량 초과 에러에 파일명 포함 (got: ${rmB.errors.join('; ')})`);
    assert.ok(fs.existsSync(big), '초과 파일도 삭제되지 않고 보존');
    fs.rmSync(big);

    // (c) 정상 체크포인트 저장+검증 통과 → 삭제 성공
    const rmC = safeRemoveWorktree({
      repoDir: repo,
      worktreeDir: wt,
      runId: 'run-2c',
      checkpointRoot: ckptRoot,
      forceGitRemove: true,
    });
    assert.equal(rmC.removed, true, `정상 경로 삭제 실패: ${rmC.errors.join('; ')}`);
    assert.equal(rmC.exitCode, 0);
    assert.ok(rmC.checkpointDir, '삭제 전 체크포인트 디렉터리를 보고해야 한다');
    assert.ok(fs.existsSync(rmC.checkpointDir), '삭제 후에도 체크포인트는 보존(복구 가능)');
    assert.ok(!fs.existsSync(wt), '워크트리 디렉터리가 삭제되어야 한다');
    const list = gitOk(repo, ['worktree', 'list', '--porcelain']);
    assert.ok(!list.includes(wt), 'git worktree list에서 제거되어야 한다');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('T16 경로 순회 차단 — manifest에 ../escape.txt 변조 시 verify/restore 거부', () => {
  const base = mkBase('pb2b-trav');
  try {
    const repo = initRepo(base);
    const wt = addWorktreeWithDirtyState(repo, 'coder-3');
    const ckptRoot = path.join(base, 'ckpt');
    const res = createWorktreeCheckpoint({ repoDir: repo, worktreeDir: wt, runId: 'run-3', checkpointRoot: ckptRoot });
    assert.equal(res.saved, true, res.errors.join('; '));
    const ckptDir = res.checkpointDir!;

    // digest까지 정합하게 재계산한 "완전한" 변조 manifest — 오직 경로 검증만이 걸러낸다
    const manifestPath = path.join(ckptDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: unknown[]; manifest_digest: string };
    const escAbs = path.join(ckptDir, '..', 'escape.txt');
    fs.writeFileSync(escAbs, 'escaped-payload\n');
    const st = fs.statSync(escAbs);
    m.files.push({
      relpath: '../escape.txt',
      kind: 'untracked',
      bytes: st.size,
      sha256: sha256File(escAbs),
      mode: 0o644,
      symlink: false,
    });
    m.manifest_digest = computeManifestDigest(m.files as never);
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

    const v = verifyWorktreeCheckpoint(ckptDir);
    assert.equal(v.valid, false, '순회 경로가 포함된 manifest는 invalid');
    assert.ok(v.errors.some((e) => e.includes('escape') || e.includes('unsafe')), v.errors.join('; '));

    const target = path.join(base, 'coder-3-target');
    gitOk(repo, ['worktree', 'add', '-b', 'coder-3-target', target]);
    const rr = restoreWorktreeCheckpoint({ checkpointDir: ckptDir, targetWorktreeDir: target });
    assert.equal(rr.restored, false, '변조 체크포인트 복원 거부');
    assert.ok(!fs.existsSync(path.join(base, 'escape.txt')), '체크포인트 루트 밖으로 파일이 생성되지 않음');
    assert.ok(!fs.existsSync(path.join(target, 'escape.txt')), '타깃 워크트리 내부에도 escape.txt 없음');
    assert.ok(fs.existsSync(path.join(wt, 'base.txt')), '원본 워크트리는 무사');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('T17·T18 dg report 읽기전용 — v1·v2 DB 파일 해시·행수·roles 해시 불변 + 집계 정합', () => {
  const base = mkBase('pb2b-report');
  const rolesDir = path.join(REPO_ROOT, '.herdr', 'roles');
  const rolesBefore = hashTree(rolesDir);
  const now = Date.now();
  try {
    // ---------- v1 DB (cause/attempt 컬럼 부재) ----------
    const v1Path = path.join(base, 'v1.db');
    const raw = new DatabaseSync(v1Path);
    migrateV1Tables(raw);
    const insFork = raw.prepare(
      `INSERT INTO forks (fork_id, project_id, project_label, route, tool_class, decision, forced_split,
        p_at_gate, basis_at_gate, status, ttl_ms, created_at_ms, last_touch_ms, metadata_json)
       VALUES (?, 'proj_t1', 't1', ?, ?, ?, 0, 0.5, 'prior', 'open', 600000, ?, ?, ?)`
    );
    insFork.run('fk_1', 'tool_select', 'shell_exec', 'split', now - 1000, now - 500, null);
    insFork.run('fk_2', 'tool_select', 'shell_exec', 'split', now - 1000, now - 500, '{"rework_count": 1}');
    insFork.run('fk_3', 'file_select', 'file_read', 'sharp', now - 1000, now - 500, null);
    const insEv = raw.prepare(
      `INSERT INTO decision_events (dedupe_key, project_id, source, route, tool_name, tool_class, ok, is_retry, error_snippet, created_at_ms)
       VALUES (?, 'proj_t1', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 6; i++) insEv.run(`e-t-${i}`, 'wrap', 'tool_select', 'run_command', 'shell_exec', 0, 0, 'cause=tool_error; exit 1 boom', now - i);
    for (let i = 0; i < 2; i++) insEv.run(`e-o-${i}`, 'wrap', 'tool_select', 'run_command', 'shell_exec', 1, 0, null, now - i);
    for (let i = 0; i < 3; i++) insEv.run(`e-r-${i}`, 'wrap', 'retry_or_abort', 'run_command', 'shell_exec', 0, 1, 'cause=tool_error; retry again', now - i);
    for (let i = 0; i < 2; i++) insEv.run(`e-ttl-${i}`, 'ttl_orphan', 'file_select', 'read_file', 'file_read', 0, 0, 'cause=stall; silent', now - i);
    insEv.run('e-h-0', 'hook', 'file_select', 'read_file', 'file_read', 1, 0, null, now);
    raw.close();

    const v1HashBefore = sha256File(v1Path);
    const db1 = openReportDb(v1Path);
    const rep1 = generateRuleCandidateReport(db1, { nowMs: now });
    const md1 = formatReportMarkdown(rep1);
    db1.close();

    assert.equal(rep1.totals.events, 14);
    assert.equal(rep1.totals.forks, 3);
    assert.ok(rep1.sections.tool_repetition.available);
    assert.ok(
      rep1.sections.tool_repetition.rows.some((r) => r.tool_name === 'run_command' && r.fail === 6 && r.events === 8 && r.candidate)
    );
    assert.ok(rep1.sections.pingpong.available);
    assert.equal(rep1.sections.pingpong.attempt_available, false, 'v1 DB는 attempt 컬럼 부재 → unavailable');
    assert.equal(rep1.sections.pingpong.retry_ratio, 3 / 14);
    assert.equal(rep1.sections.pingpong.candidate, true);
    assert.equal(rep1.sections.pingpong.rework_forks, 1, 'metadata rework_count 파싱');
    assert.ok(rep1.sections.failure_causes.available && rep1.sections.failure_causes.source === 'snippet');
    const causeRows1 = rep1.sections.failure_causes.available ? rep1.sections.failure_causes.rows : [];
    assert.equal(causeRows1[0]?.cause, 'tool_error');
    assert.equal(causeRows1[0]?.count, 9);
    assert.equal(rep1.sections.orphan_stall.ttl_orphan_ratio, 2 / 14);
    assert.equal(rep1.sections.orphan_stall.level, 'warn');
    assert.equal(rep1.sections.orphan_stall.stall_events, 2, 'v1 stall은 snippet 파싱으로 집계');
    assert.ok(rep1.candidates.includes('tool_repetition:run_command'));
    assert.ok(rep1.candidates.includes('failure_causes:tool_error'));
    assert.ok(rep1.candidates.includes('orphan_stall:warn'));
    assert.ok(md1.includes('자동 적용 금지') && md1.includes('run_command'), '마크다운 렌더에 핵심 섹션 존재');
    assert.equal(sha256File(v1Path), v1HashBefore, 'v1 DB 파일이 리포트 실행 전후 불변');

    // ---------- v2 DB (cause/attempt 컬럼 존재) ----------
    const v2Path = path.join(base, 'v2.db');
    const w = openDb(v2Path);
    const insFork2 = w.prepare(
      `INSERT INTO forks (fork_id, project_id, project_label, route, tool_class, decision, forced_split,
        p_at_gate, basis_at_gate, generation, attempt, status, ttl_ms, created_at_ms, last_touch_ms)
       VALUES (?, 'proj_t2', 't2', 'tool_select', 'shell_exec', 'split', 0, 0.5, 'prior', 1, ?, 'open', 600000, ?, ?)`
    );
    insFork2.run('fk_a', 2, now - 1000, now - 500);
    insFork2.run('fk_b', 1, now - 1000, now - 500);
    const insEv2 = w.prepare(
      `INSERT INTO decision_events (dedupe_key, project_id, source, route, tool_name, tool_class, ok, is_retry, error_snippet, cause, created_at_ms)
       VALUES (?, 'proj_t2', ?, 'tool_select', 'run_command', 'shell_exec', 0, 0, ?, ?, ?)`
    );
    for (let i = 0; i < 5; i++) insEv2.run(`v2-t-${i}`, 'wrap', 'cause=tool_error; boom', 'tool_error', now - i);
    insEv2.run('v2-l-0', 'wrap', null, null, now);
    insEv2.run('v2-l-1', 'wrap', null, null, now);
    insEv2.run('v2-s-0', 'ttl_orphan', 'cause=stall; silent', 'stall', now);
    w.close();

    const v2HashBefore = sha256File(v2Path);
    const db2 = openReportDb(v2Path);
    const rep2 = generateRuleCandidateReport(db2, { nowMs: now });
    db2.close();

    assert.equal(rep2.totals.events, 8);
    assert.ok(rep2.sections.failure_causes.available && rep2.sections.failure_causes.source === 'column');
    const causeRows2 = rep2.sections.failure_causes.available ? rep2.sections.failure_causes.rows : [];
    assert.ok(causeRows2.some((r) => r.cause === 'tool_error' && r.count === 5));
    assert.ok(causeRows2.some((r) => r.cause === 'legacy_unknown' && r.count === 2), 'NULL cause는 legacy_unknown 버킷');
    assert.equal(rep2.sections.pingpong.attempt_available, true);
    assert.equal(rep2.sections.pingpong.rework_forks, 1, 'attempt >= 2 fork 집계');
    assert.equal(rep2.sections.orphan_stall.stall_events, 1, 'v2 stall은 cause 컬럼으로 집계');
    assert.equal(sha256File(v2Path), v2HashBefore, 'v2 DB 파일이 리포트 실행 전후 불변');

    // ---------- .herdr/roles 무변조 ----------
    assert.equal(hashTree(rolesDir), rolesBefore, '.herdr/roles/* 해시 불변 (자동 변조 금지)');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('T19 --out allowlist 가드 — 저장소 내부 민감 경로 거부 / .herdr/report·외부 허용', () => {
  const repo = mkBase('pb2b-allow');
  try {
    for (const d of ['src', 'scripts', '.agents', '.herdr/report', '.herdr/roles']) {
      fs.mkdirSync(path.join(repo, d), { recursive: true });
    }
    // 심볼릭 링크 우회: repo/src-link → repo/src
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'src-link'));

    const denied = [
      path.join(repo, 'src', 'x.md'),
      path.join(repo, 'scripts', 'x.md'),
      path.join(repo, '.agents', 'x.md'),
      path.join(repo, '.herdr', 'roles', 'lead.md'),
      path.join(repo, '.herdr', 'report', '..', '..', 'src', 'x.md'),
      path.join(repo, 'src-link', 'x.md'),
      path.join(repo, 'package.json'),
    ];
    for (const p of denied) {
      const v = validateReportOutPath(p, repo);
      assert.equal(v.allowed, false, `거부 예상: ${p}`);
      assert.equal(v.reason, 'forbidden_out_path');
    }

    const outside = path.join(os.tmpdir(), `pb2b-outside-${process.pid}.md`);
    const allowed = [path.join(repo, '.herdr', 'report', 'r1.md'), outside];
    for (const p of allowed) {
      const v = validateReportOutPath(p, repo);
      assert.equal(v.allowed, true, `허용 예상: ${p}`);
      assert.ok(v.resolvedPath);
    }

    // 거부 경로는 파일은 물론 부모 디렉터리도 생성하지 않는다
    const wDeny = writeReportFileSafe({ outPath: path.join(repo, 'src', 'deep', 'x.md'), repoDir: repo, content: 'nope' });
    assert.equal(wDeny.written, false);
    assert.ok(!fs.existsSync(path.join(repo, 'src', 'deep')), '거부 시 부모 디렉터리 미생성');

    const wOk = writeReportFileSafe({ outPath: path.join(repo, '.herdr', 'report', 'r1.md'), repoDir: repo, content: '# report\n' });
    assert.equal(wOk.written, true, `허용 경로 쓰기 실패: ${wOk.reason}`);
    assert.equal(fs.readFileSync(path.join(repo, '.herdr', 'report', 'r1.md'), 'utf8'), '# report\n');

    const wOkOutside = writeReportFileSafe({ outPath: outside, repoDir: repo, content: '# tmp\n' });
    assert.equal(wOkOutside.written, true);
    assert.ok(fs.existsSync(outside));
    fs.rmSync(outside, { force: true });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
