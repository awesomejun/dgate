/**
 * `src/decision/checkpoint.ts` — B4 Git-Native 워크트리 체크포인트 + 삭제 게이트 (PB-2B).
 *
 * 목적: `git worktree` 기반 병렬 워커의 작업 손실 0을 보장한다. staged/unstaged
 * `git diff --binary` 패치와 untracked 원본 복사를 `.herdr/checkpoints/<run_id>/<wt_name>/`
 * 에 스냅숏하고, sha256 manifest로 무결성을 검증한다. `safeRemoveWorktree`는
 * "체크포인트 저장 성공 + 검증 valid"를 통과하기 전에는 `git worktree remove` 호출에
 * 물리적으로 도달할 수 없는 삭제 게이트다(우회 플래그 없음 — 절대 불변식).
 *
 * 외부 연결:
 * - `dg checkpoint`/`dg worktree remove` CLI 배선은 통합 단계에서 `dg.ts`에 등록한다
 *   (PB-2B는 모듈 본체만 제공 — brief §1 참고).
 * - `tests/phaseb-checkpoint-report.test.ts`가 save→verify→tamper→restore 왕복,
 *   삭제 게이트 exitCode 4, 경로 순회 차단을 검증한다.
 *
 * 주의:
 * - 외부 의존성 0: `node:child_process`(git CLI)·`node:crypto`·`node:fs`만 사용.
 * - 압축 아카이브 금지 — Git 네이티브 패치 + 원본 파일(설계 §4.1).
 * - untracked 파일당·총합 용량이 `MAX_CHECKPOINT_BYTES`(12MiB)를 초과하면 저장 실패를
 *   반환한다(조용한 건너뛰기 금지 — 무손실 복원 보장이 우선).
 * - untracked 경로 순회(`..`)·제외 대상(`.git`,`node_modules`,`.herdr`,`.verify`,`*.db*`)는
 *   save·verify·restore 양쪽에서 동일 규칙으로 엄격 차단한다.
 * - 심볼릭 링크는 링크 대상 경로 문자열을 텍스트로 저장한다(따라가서 복사하지 않는다 —
 *   무한 루프·워크트리 외부 경로 유출 차단). manifest의 `symlink: true`로 복원한다.
 * - manifest 파일 항목은 언제나 일반 파일로 저장하며, verify는 `lstat`으로 일반 파일
 *   여부까지 대조한다(검증 대상 파일을 심볼릭 링크로 바꿔치기하는 변조 차단).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** untracked 복사 용량 상한 — 파일당·총합 공용 (brief §3.A.1) */
export const MAX_CHECKPOINT_BYTES = 12 * 1024 * 1024;

/** 체크포인트 디렉터리명(run_id·wt_name) 허용 문자셋 — 경로 탈출 원천 차단 */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** untracked 제외 세그먼트 — save·verify·restore가 같은 목록을 쓴다 */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.herdr', '.verify']);

export type CheckpointFileKind = 'index_patch' | 'worktree_patch' | 'untracked';

export interface CheckpointFileEntry {
  /** 체크포인트 디렉터리 기준 상대 경로 (`index.patch` | `worktree.patch` | `untracked/<rel>`) */
  relpath: string;
  kind: CheckpointFileKind;
  bytes: number;
  sha256: string;
  /** 복원 시 chmod용 권한(8진수를 10진수로). 심볼릭 링크는 null */
  mode: number | null;
  /** true면 저장 내용이 심볼릭 링크 대상 경로 문자열이다 */
  symlink: boolean;
}

export interface CheckpointManifest {
  schema_version: 1;
  created_at_ms: number;
  run_id: string;
  worktree_name: string;
  worktree_path: string;
  branch: string;
  head_sha: string;
  files: CheckpointFileEntry[];
  /** files 정규화 JSON(경로 오름차순·키 고정)의 sha256 — manifest 자기 자신은 제외 */
  manifest_digest: string;
}

export interface CheckpointResult {
  saved: boolean;
  checkpointDir?: string;
  manifest?: CheckpointManifest;
  errors: string[];
}

export interface VerifyCheckpointResult {
  valid: boolean;
  errors: string[];
  manifest?: CheckpointManifest;
}

export interface RestoreCheckpointResult {
  restored: boolean;
  errors: string[];
}

export interface SafeRemoveResult {
  removed: boolean;
  /** 게이트 거부는 4, 정상 삭제는 0, git 실패는 git 종료코드 */
  exitCode: number;
  checkpointDir?: string;
  errors: string[];
}

// ---------- 경로 안전성 헬퍼 (save·verify·restore 공용) ----------

/** 상대 경로 구조 검증 — 빈 세그먼트·`.`·`..`·백슬래시·NUL·절대경로 거부 */
function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  const segs = rel.split('/');
  return segs.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/** 제외 대상: 금지 세그먼트(`.git` 등) 또는 `*.db*` basename */
function isExcludedUntrackedRel(rel: string): boolean {
  const segs = rel.split('/');
  if (segs.some((s) => EXCLUDED_SEGMENTS.has(s))) return true;
  const base = segs[segs.length - 1] ?? '';
  return /\.db/.test(base);
}

function sha256Buf(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** manifest digest SSOT — files를 경호 오름차순 정렬 + 키 고정 직렬화 후 sha256 */
export function computeManifestDigest(files: readonly CheckpointFileEntry[]): string {
  const canonical = files
    .map((f) => ({
      relpath: f.relpath,
      kind: f.kind,
      bytes: f.bytes,
      sha256: f.sha256,
      mode: f.mode ?? null,
      symlink: f.symlink === true,
    }))
    .sort((a, b) =>
      a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
    );
  return sha256Buf(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function gitRun(
  cwd: string,
  args: string[],
  maxBuffer: number
): { ok: boolean; out: string; err: string } {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer });
  const errText = `${res.stderr ?? ''}${res.error ? String(res.error) : ''}`.trim();
  return { ok: res.status === 0, out: res.stdout ?? '', err: errText };
}

// ---------- B4 저장: createWorktreeCheckpoint ----------

export interface CreateCheckpointInput {
  repoDir: string;
  worktreeDir: string;
  runId: string;
  worktreeName?: string;
  /** 기본 `<repoDir>/.herdr/checkpoints` */
  checkpointRoot?: string;
}

/**
 * 워크트리 체크포인트 저장. 실패 시 부분 산출물을 남기지 않는다(tmp 정리 + errors 반환).
 * 성공은 "manifest까지 기록 + 자기검증(verify) 통과 + tmp→최종 rename 완료"를 의미한다.
 */
export function createWorktreeCheckpoint(input: CreateCheckpointInput): CheckpointResult {
  const errors: string[] = [];
  const runId = input.runId;
  if (!SAFE_NAME_RE.test(runId) || runId === '.' || runId === '..') {
    return { saved: false, errors: [`invalid run_id (charset [A-Za-z0-9._-] required): ${runId}`] };
  }
  const worktreeDir = path.resolve(input.worktreeDir);
  let worktreeStat: fs.Stats;
  try {
    worktreeStat = fs.statSync(worktreeDir);
  } catch {
    return { saved: false, errors: [`worktree not found: ${worktreeDir}`] };
  }
  if (!worktreeStat.isDirectory()) {
    return { saved: false, errors: [`worktree is not a directory: ${worktreeDir}`] };
  }
  const wtName = input.worktreeName ?? path.basename(worktreeDir);
  if (!SAFE_NAME_RE.test(wtName) || wtName === '.' || wtName === '..') {
    return { saved: false, errors: [`invalid worktree_name (charset [A-Za-z0-9._-] required): ${wtName}`] };
  }
  const repoDir = path.resolve(input.repoDir);
  const root =
    input.checkpointRoot !== undefined ? path.resolve(input.checkpointRoot) : path.join(repoDir, '.herdr', 'checkpoints');
  const finalDir = path.join(root, runId, wtName);
  const tmpDir = path.join(root, runId, `.tmp-${randomBytes(6).toString('hex')}`);

  try {
    const head = gitRun(worktreeDir, ['rev-parse', 'HEAD'], 1024 * 1024);
    if (!head.ok) return { saved: false, errors: [`git rev-parse HEAD failed: ${head.err}`] };
    const headSha = head.out.trim();
    const branchRes = gitRun(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD'], 1024 * 1024);
    if (!branchRes.ok) return { saved: false, errors: [`git rev-parse --abbrev-ref failed: ${branchRes.err}`] };
    const branch = branchRes.out.trim();

    const indexRes = gitRun(worktreeDir, ['diff', '--cached', '--binary'], MAX_CHECKPOINT_BYTES + 1024 * 1024);
    if (!indexRes.ok) return { saved: false, errors: [`git diff --cached failed: ${indexRes.err}`] };
    const worktreeRes = gitRun(worktreeDir, ['diff', '--binary'], MAX_CHECKPOINT_BYTES + 1024 * 1024);
    if (!worktreeRes.ok) return { saved: false, errors: [`git diff failed: ${worktreeRes.err}`] };
    const indexPatch = Buffer.from(indexRes.out, 'utf8');
    const worktreePatch = Buffer.from(worktreeRes.out, 'utf8');

    // untracked 원본 수집 계획 — 전부 검증한 뒤에만 디스크에 쓴다(부분 산출물 방지)
    const ls = spawnSync('git', ['-C', worktreeDir, 'ls-files', '--others', '--exclude-standard', '-z'], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (ls.status !== 0) {
      return { saved: false, errors: [`git ls-files --others failed: ${String(ls.stderr ?? '')}`] };
    }
    const untrackedRels = ls.stdout.toString('utf8').split('\0').filter((s) => s.length > 0);

    const entries: CheckpointFileEntry[] = [];
    const copyPlan: Array<{ rel: string; srcAbs: string; symlink: boolean; content: Buffer; mode: number | null }> = [];
    let totalBytes = indexPatch.length + worktreePatch.length;
    for (const rel of untrackedRels) {
      if (!isSafeRelPath(rel)) {
        errors.push(`unsafe untracked path rejected: ${rel}`);
        continue;
      }
      if (isExcludedUntrackedRel(rel)) {
        errors.push(`excluded untracked path rejected (checkpoint would be lossy): ${rel}`);
        continue;
      }
      const srcAbs = path.join(worktreeDir, rel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(srcAbs);
      } catch (err) {
        errors.push(`untracked lstat failed (${rel}): ${(err as Error).message}`);
        continue;
      }
      let content: Buffer;
      let symlink = false;
      let mode: number | null = null;
      if (st.isSymbolicLink()) {
        symlink = true;
        content = Buffer.from(fs.readlinkSync(srcAbs), 'utf8');
      } else if (st.isFile()) {
        if (st.size > MAX_CHECKPOINT_BYTES) {
          errors.push(`untracked file exceeds MAX_CHECKPOINT_BYTES (${st.size} > ${MAX_CHECKPOINT_BYTES}): ${rel}`);
          continue;
        }
        content = fs.readFileSync(srcAbs);
        mode = st.mode & 0o777;
      } else {
        // ls-files은 파일만 열거하므로 여기엔 도달하지 않는다 — 이상 상태는 건너뛰지 않고 오류로
        errors.push(`untracked entry is not a regular file/symlink: ${rel}`);
        continue;
      }
      if (content.length > MAX_CHECKPOINT_BYTES) {
        errors.push(`untracked file exceeds MAX_CHECKPOINT_BYTES (${content.length} > ${MAX_CHECKPOINT_BYTES}): ${rel}`);
        continue;
      }
      totalBytes += content.length;
      if (totalBytes > MAX_CHECKPOINT_BYTES) {
        errors.push(`checkpoint total size exceeds MAX_CHECKPOINT_BYTES (${totalBytes} > ${MAX_CHECKPOINT_BYTES})`);
        break;
      }
      copyPlan.push({ rel, srcAbs, symlink, content, mode });
    }
    if (indexPatch.length > MAX_CHECKPOINT_BYTES) {
      errors.push(`index.patch exceeds MAX_CHECKPOINT_BYTES (${indexPatch.length})`);
    }
    if (worktreePatch.length > MAX_CHECKPOINT_BYTES) {
      errors.push(`worktree.patch exceeds MAX_CHECKPOINT_BYTES (${worktreePatch.length})`);
    }
    if (errors.length > 0) {
      return { saved: false, errors };
    }

    // tmp 디렉터리에 전부 기록 → manifest → 자기검증 → 원자적 rename
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(tmpDir, 'index.patch'), indexPatch);
      fs.writeFileSync(path.join(tmpDir, 'worktree.patch'), worktreePatch);
      entries.push({ relpath: 'index.patch', kind: 'index_patch', bytes: indexPatch.length, sha256: sha256Buf(indexPatch), mode: null, symlink: false });
      entries.push({ relpath: 'worktree.patch', kind: 'worktree_patch', bytes: worktreePatch.length, sha256: sha256Buf(worktreePatch), mode: null, symlink: false });
      for (const item of copyPlan) {
        const dest = path.join(tmpDir, 'untracked', item.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, item.content);
        entries.push({
          relpath: `untracked/${item.rel}`,
          kind: 'untracked',
          bytes: item.content.length,
          sha256: sha256Buf(item.content),
          mode: item.mode,
          symlink: item.symlink,
        });
      }
      const manifest: CheckpointManifest = {
        schema_version: 1,
        created_at_ms: Date.now(),
        run_id: runId,
        worktree_name: wtName,
        worktree_path: worktreeDir,
        branch,
        head_sha: headSha,
        files: entries,
        manifest_digest: '',
      };
      manifest.manifest_digest = computeManifestDigest(entries);
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      const self = verifyWorktreeCheckpoint(tmpDir);
      if (!self.valid) {
        return { saved: false, errors: ['self-verification failed after write', ...self.errors] };
      }
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
      return { saved: true, checkpointDir: finalDir, manifest, errors: [] };
    } finally {
      // rename 성공 시 tmpDir는 이미 없다 — 실패 경로의 부분 산출물만 정리
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 무시 */
      }
    }
  } catch (err) {
    return { saved: false, errors: [`checkpoint failed: ${(err as Error).message}`] };
  }
}

// ---------- B4 검증: verifyWorktreeCheckpoint ----------

function isValidSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * 체크포인트 무결성 검증: manifest 파싱 → manifest_digest 재계산 대조 →
 * files 각 항목의 존재·일반 파일 여부·bytes·sha256 전건 대조.
 * manifest에 안전하지 않은 relpath(`..` 순회 등)가 하나라도 있으면 invalid다.
 */
export function verifyWorktreeCheckpoint(checkpointDir: string): VerifyCheckpointResult {
  const errors: string[] = [];
  const dir = path.resolve(checkpointDir);
  let manifest: CheckpointManifest | undefined;
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CheckpointManifest>;
    if (parsed.schema_version !== 1) errors.push(`unsupported schema_version: ${String(parsed.schema_version)}`);
    if (typeof parsed.run_id !== 'string' || parsed.run_id.length === 0) errors.push('manifest run_id missing');
    if (typeof parsed.worktree_name !== 'string' || parsed.worktree_name.length === 0) {
      errors.push('manifest worktree_name missing');
    }
    if (typeof parsed.head_sha !== 'string' || parsed.head_sha.length === 0) errors.push('manifest head_sha missing');
    if (!Array.isArray(parsed.files)) {
      errors.push('manifest files is not an array');
    } else {
      const digestInput: CheckpointFileEntry[] = [];
      for (const f of parsed.files as Array<Partial<CheckpointFileEntry>>) {
        const rel = f.relpath;
        const kind = f.kind;
        if (typeof rel !== 'string' || typeof kind !== 'string') {
          errors.push('manifest file entry missing relpath/kind');
          continue;
        }
        if (kind !== 'index_patch' && kind !== 'worktree_patch' && kind !== 'untracked') {
          errors.push(`manifest file entry has invalid kind: ${kind}`);
          continue;
        }
        if (rel === 'index.patch' && kind !== 'index_patch') {
          errors.push(`kind mismatch for ${rel}: ${kind}`);
          continue;
        }
        if (rel === 'worktree.patch' && kind !== 'worktree_patch') {
          errors.push(`kind mismatch for ${rel}: ${kind}`);
          continue;
        }
        if (rel.startsWith('untracked/')) {
          const inner = rel.slice('untracked/'.length);
          if (kind !== 'untracked' || !isSafeRelPath(inner) || isExcludedUntrackedRel(inner)) {
            errors.push(`unsafe or mismatched untracked manifest path: ${rel}`);
            continue;
          }
        } else if (rel !== 'index.patch' && rel !== 'worktree.patch') {
          errors.push(`unsafe manifest relpath rejected: ${rel}`);
          continue;
        }
        if (typeof f.bytes !== 'number' || !Number.isFinite(f.bytes) || f.bytes < 0) {
          errors.push(`manifest bytes invalid for ${rel}`);
          continue;
        }
        if (!isValidSha256Hex(f.sha256)) {
          errors.push(`manifest sha256 invalid for ${rel}`);
          continue;
        }
        digestInput.push({
          relpath: rel,
          kind,
          bytes: f.bytes,
          sha256: f.sha256,
          mode: f.mode ?? null,
          symlink: f.symlink === true,
        });
      }
      if (digestInput.length === (parsed.files as unknown[]).length) {
        const recomputed = computeManifestDigest(digestInput);
        if (typeof parsed.manifest_digest !== 'string' || recomputed !== parsed.manifest_digest) {
          errors.push('manifest_digest mismatch');
        }
      }
      manifest = digestInput.length > 0 || (parsed.files as unknown[]).length === 0
        ? ({
            schema_version: 1,
            created_at_ms: typeof parsed.created_at_ms === 'number' ? parsed.created_at_ms : 0,
            run_id: parsed.run_id ?? '',
            worktree_name: parsed.worktree_name ?? '',
            worktree_path: typeof parsed.worktree_path === 'string' ? parsed.worktree_path : '',
            branch: typeof parsed.branch === 'string' ? parsed.branch : '',
            head_sha: typeof parsed.head_sha === 'string' ? parsed.head_sha : '',
            files: digestInput,
            manifest_digest: typeof parsed.manifest_digest === 'string' ? parsed.manifest_digest : '',
          } as CheckpointManifest)
        : undefined;
    }
  } catch (err) {
    return { valid: false, errors: [`manifest.json unreadable: ${(err as Error).message}`] };
  }

  // 파일 실체 대조 — 저장 시점에는 언제나 일반 파일이므로 lstat으로 심볼릭 링크 바꿔치기 차단
  if (manifest && Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      const abs = path.resolve(dir, entry.relpath);
      if (path.relative(dir, abs) !== entry.relpath) {
        errors.push(`path escapes checkpoint dir: ${entry.relpath}`);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        errors.push(`file missing: ${entry.relpath}`);
        continue;
      }
      if (!st.isFile()) {
        errors.push(`not a regular file (symlink substitution?): ${entry.relpath}`);
        continue;
      }
      if (st.size !== entry.bytes) {
        errors.push(`size mismatch for ${entry.relpath}: ${st.size} != ${entry.bytes}`);
        continue;
      }
      const actual = sha256Buf(fs.readFileSync(abs));
      if (actual !== entry.sha256) {
        errors.push(`sha256 mismatch for ${entry.relpath}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, manifest };
}

// ---------- B4 복원: restoreWorktreeCheckpoint ----------

export interface RestoreCheckpointInput {
  checkpointDir: string;
  targetWorktreeDir: string;
}

/**
 * 검증 통과 체크포인트를 대상 워크트리에 무손실 재적용한다.
 * - verify 실패 시 복원을 시작하지 않는다(원문 그대로 거부).
 * - 패치 적용 순서: index.patch(`git apply --index`) → worktree.patch(워크트리만).
 * - untracked는 manifest 검증을 통과한 경로만 복사하며, 심볼릭 링크는 대상 문자열로 재생성.
 * - 실패 시 타깃을 지우지 않는다(부분 복구 상태를 사람이 검사할 수 있게 남긴다).
 */
export function restoreWorktreeCheckpoint(input: RestoreCheckpointInput): RestoreCheckpointResult {
  const dir = path.resolve(input.checkpointDir);
  const target = path.resolve(input.targetWorktreeDir);
  const verified = verifyWorktreeCheckpoint(dir);
  if (!verified.valid || !verified.manifest) {
    return { restored: false, errors: ['checkpoint verification failed', ...verified.errors] };
  }
  const errors: string[] = [];
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { restored: false, errors: [`target worktree not found: ${target}`] };
    }
    const indexPath = path.join(dir, 'index.patch');
    const worktreePath = path.join(dir, 'worktree.patch');
    if (fs.statSync(indexPath).size > 0) {
      const r = gitRun(target, ['apply', '--index', '--binary', indexPath], MAX_CHECKPOINT_BYTES + 1024 * 1024);
      if (!r.ok) return { restored: false, errors: [`git apply --index failed: ${r.err}`] };
    }
    if (fs.statSync(worktreePath).size > 0) {
      const r = gitRun(target, ['apply', '--binary', worktreePath], MAX_CHECKPOINT_BYTES + 1024 * 1024);
      if (!r.ok) return { restored: false, errors: [`git apply failed: ${r.err}`] };
    }
    for (const entry of verified.manifest.files) {
      if (entry.kind !== 'untracked') continue;
      const rel = entry.relpath.slice('untracked/'.length);
      if (!isSafeRelPath(rel) || isExcludedUntrackedRel(rel)) {
        errors.push(`unsafe untracked manifest path refused during restore: ${entry.relpath}`);
        continue;
      }
      const srcAbs = path.join(dir, entry.relpath);
      const dest = path.resolve(target, rel);
      if (path.relative(target, dest) !== rel) {
        errors.push(`path escapes target worktree: ${rel}`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (entry.symlink) {
        const linkTarget = fs.readFileSync(srcAbs, 'utf8');
        fs.rmSync(dest, { force: true });
        fs.symlinkSync(linkTarget, dest);
      } else {
        fs.copyFileSync(srcAbs, dest);
        if (entry.mode !== null) fs.chmodSync(dest, entry.mode);
      }
    }
  } catch (err) {
    return { restored: false, errors: [`restore failed (target kept for inspection): ${(err as Error).message}`] };
  }
  return { restored: errors.length === 0, errors };
}

// ---------- B4 삭제 게이트: safeRemoveWorktree (절대 불변식) ----------

export interface SafeRemoveInput {
  repoDir: string;
  worktreeDir: string;
  runId: string;
  worktreeName?: string;
  checkpointRoot?: string;
  /** true면 `git worktree remove --force`(dirty worktree 허용). 체크포인트 검증에는 영향 없다 */
  forceGitRemove?: boolean;
}

/**
 * 체크포인트 게이트 경유 워크트리 삭제 — 이 함수가 저장소 내 `git worktree remove`를
 * 호출하는 유일한 지점이다. 저장(createWorktreeCheckpoint)과 검증(verifyWorktreeCheckpoint)
 * 양쪽 모두 통과하기 전에는 삭제 호출에 도달할 수 없다(우회 플래그 없음).
 * 게이트 거부는 `{ removed: false, exitCode: 4 }`로 즉시 반환하며 워크트리를 건드리지 않는다.
 */
export function safeRemoveWorktree(input: SafeRemoveInput): SafeRemoveResult {
  const ck = createWorktreeCheckpoint({
    repoDir: input.repoDir,
    worktreeDir: input.worktreeDir,
    runId: input.runId,
    worktreeName: input.worktreeName,
    checkpointRoot: input.checkpointRoot,
  });
  if (!ck.saved || !ck.checkpointDir) {
    return { removed: false, exitCode: 4, errors: ['checkpoint save failed — removal refused', ...ck.errors] };
  }
  const verified = verifyWorktreeCheckpoint(ck.checkpointDir);
  if (!verified.valid) {
    return {
      removed: false,
      exitCode: 4,
      checkpointDir: ck.checkpointDir,
      errors: ['checkpoint verification failed — removal refused', ...verified.errors],
    };
  }
  const args = ['worktree', 'remove'];
  if (input.forceGitRemove === true) args.push('--force');
  args.push(path.resolve(input.worktreeDir));
  const res = spawnSync('git', ['-C', path.resolve(input.repoDir), ...args], { encoding: 'utf8' });
  if (res.status === 0) {
    return { removed: true, exitCode: 0, checkpointDir: ck.checkpointDir, errors: [] };
  }
  return {
    removed: false,
    exitCode: res.status ?? 1,
    checkpointDir: ck.checkpointDir,
    errors: [`git worktree remove failed: ${(res.stderr ?? '').trim()}`],
  };
}
