import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 마크다운 체크박스 기반 실제 태스크 진행률(읽기 전용).
 * 외부 의존성 없이 Node 빌트인만 사용한다.
 */
export interface TaskProgress {
  sourceName: string;
  done: number;
  total: number;
  pct: number;
}

/** 한 줄이 체크박스 항목인지(코드 펜스 무시 상태 전달) */
const CHECKBOX_RE = /^\s*[-*+]\s+\[([xX ])\]/;

/**
 * 마크다운 체크박스 줄을 센다. 삼중 백틱/삼중 물결 펜스 내부는 무시.
 */
export function parseMarkdownCheckboxes(content: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = CHECKBOX_RE.exec(line);
    if (m) {
      total += 1;
      if (m[1] === 'x' || m[1] === 'X') done += 1;
    }
  }
  return { done, total };
}

/** 파일을 최대 64KiB까지 읽어 체크박스 진행률로 변환. 실패/빈 목록 시 null. */
function readFileProgress(file: string): TaskProgress | null {
  let content: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = fs.readSync(fd, buf, 0, buf.length, 0);
      content = buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const { done, total } = parseMarkdownCheckboxes(content);
  if (total <= 0) return null;
  return {
    sourceName: '',
    done,
    total,
    pct: Math.min(100, Math.floor((done * 100) / total)),
  };
}

/** 루트 우선순위 파일 순서 */
const ROOT_FILES = ['TODO.md', 'todo.md', 'TASKS.md', 'PLAN.md', 'plan.md', '.herdr/plan.md'] as const;
/** 하위 디렉터리 후보(비재귀, .md 최대 32개, 최신 mtime 우선) */
const SUBDIRS = ['.todo-flow', 'todo'] as const;

/**
 * 레포 디렉터리에서 태스크 진행률을 읽는다(엄격 읽기 전용).
 * 우선순위: 루트 파일 → 하위 디렉터리 최신 .md. total > 0인 첫 파일만 반환, 없으면 null.
 */
export function readRepoTaskProgress(repoDir: string): TaskProgress | null {
  // Priority 1: 루트 파일
  for (const rel of ROOT_FILES) {
    const full = path.join(repoDir, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const tp = readFileProgress(full);
    if (tp) {
      tp.sourceName = rel;
      return tp;
    }
  }
  // Priority 2: 하위 디렉터리 .md — 최신 mtime 우선, 최대 32개, 비재귀
  for (const dir of SUBDIRS) {
    const fullDir = path.join(repoDir, dir);
    let names: string[];
    try {
      names = fs.readdirSync(fullDir);
    } catch {
      continue;
    }
    const candidates: Array<{ name: string; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      try {
        const st = fs.statSync(path.join(fullDir, name));
        if (st.isFile()) candidates.push({ name, mtime: st.mtimeMs });
      } catch {
        // 경합으로 사라진 파일은 건너뛴다
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const { name } of candidates.slice(0, 32)) {
      const tp = readFileProgress(path.join(fullDir, name));
      if (tp) {
        tp.sourceName = `${dir}/${name}`;
        return tp;
      }
    }
  }
  return null;
}
