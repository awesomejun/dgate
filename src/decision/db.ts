/**
 * Decision 게이트 SQLite WAL SSOT 연결·마이그레이션·프로젝트 식별 모듈 (plan-r2.1 §3).
 *
 * 목적: `node:sqlite`(`DatabaseSync`) 단일 구현으로 `dg` CLI·훅·매퍼·TUI가 동일한
 * 통계 엔진을 공유하기 위한 물리적 기반을 제공한다. Python 폴백이나 외부 npm 패키지가
 * 존재하지 않는다(Split-Brain 원천 차단 — §3.1).
 *
 * 외부 연결:
 * - `engine.ts`·`dg.ts`·`telemetry.ts`가 `openDb`/`openDbSafe`로 연결을 얻는다.
 * - `cli.ts --watch-db`가 `resolveDbPath`로 우선순위(`--watch-db` > `GEMINI_TRICK_DB_PATH`
 *   > XDG 기본 경로)를 해석한다(N8).
 *
 * 주의:
 * - `DatabaseSync`의 `timeout` 옵션은 정수만 허용한다(실수 전달 시 오류 — §0 실측).
 * - 읽기전용 구독자는 반드시 `readOnly: true` + `PRAGMA query_only=ON`을 쓴다.
 * - DDL은 §3.3 원문과 문자열 단위로 일치해야 한다(CHECK 제약 오타 금지).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 전역 사전확률 풀용 예약 프로젝트 ID (§3.4) */
export const GLOBAL_PROJECT_ID = '__GLOBAL__';

export function defaultDbPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'gemini-trick', 'decision.db');
}

/**
 * DB 경로 우선순위: explicit(`--watch-db` 등) > `GEMINI_TRICK_DB_PATH` > XDG 기본 경로.
 */
export function resolveDbPath(explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit;
  const env = process.env.GEMINI_TRICK_DB_PATH;
  if (env && env.trim()) return env;
  return defaultDbPath();
}

export interface OpenDbOptions {
  /** 읽기전용 구독(TUI 관제) — `PRAGMA query_only=ON` 함께 적용 */
  readOnly?: boolean;
  /** busy 타임아웃(ms). 일반 writer 5000, 훅 250, reader 1000 (정수만 — §0 실측) */
  busyTimeoutMs?: number;
}

export function openDb(dbPath?: string, opts: OpenDbOptions = {}): DatabaseSync {
  const resolved = resolveDbPath(dbPath);
  const busy = Number.isInteger(opts.busyTimeoutMs) ? (opts.busyTimeoutMs as number) : opts.readOnly ? 1000 : 5000;
  if (!opts.readOnly) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } else if (!fs.existsSync(resolved)) {
    throw new Error(`decision db not found: ${resolved}`);
  }
  const db = new DatabaseSync(resolved, { readOnly: opts.readOnly === true, timeout: busy });
  if (!opts.readOnly) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`PRAGMA busy_timeout = ${busy};`);
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
  } else {
    db.exec('PRAGMA query_only = ON;');
  }
  return db;
}

/**
 * 안전 폴백 연결: DB 미존재·권한 오류·손상·잠금 시 예외 대신 `null`을 반환한다(§3.5).
 * 호출자(stderr 경고 + 안전 JSON exit 0)가 게이트 SPOF를 차단한다.
 */
export function openDbSafe(dbPath?: string, opts: OpenDbOptions = {}): DatabaseSync | null {
  try {
    return openDb(dbPath, opts);
  } catch (err) {
    process.stderr.write(`[dg] db fallback: ${(err as Error).message}\n`);
    return null;
  }
}

/**
 * §3.3 DDL 전체(멱등). `forks` CHECK 제약과 `last_touch_ms NOT NULL`은 원문 그대로.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS stats_summary (
  project_id         TEXT NOT NULL,
  project_label      TEXT NOT NULL,
  route              TEXT NOT NULL CHECK (route IN ('file_select','tool_select','retry_or_abort','delegate_swarm')),
  tool_class         TEXT NOT NULL,
  ewma_success       REAL NOT NULL DEFAULT 0.0,
  ewma_fail          REAL NOT NULL DEFAULT 0.0,
  raw_samples        INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_target_hash   TEXT,
  last_outcome       INTEGER,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (project_id, route, tool_class)
);

CREATE TABLE IF NOT EXISTS forks (
  fork_id            TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  project_label      TEXT NOT NULL,
  conversation_id    TEXT,
  route              TEXT NOT NULL CHECK (route IN ('file_select','tool_select','retry_or_abort','delegate_swarm')),
  tool_class         TEXT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('sharp','split')),
  forced_split       INTEGER NOT NULL DEFAULT 0,
  p_at_gate          REAL NOT NULL,
  basis_at_gate      TEXT NOT NULL CHECK (basis_at_gate IN ('prior','measured')),
  status             TEXT NOT NULL CHECK (status IN ('open','ok','fail','abandoned','rerouted','backprop_fail')),
  closed_by          TEXT CHECK (closed_by IN ('dispatcher','lead','worker','ttl','verifier')),
  neon_verdict       TEXT CHECK (neon_verdict IN ('pass','fail')),
  ttl_ms             INTEGER NOT NULL DEFAULT 600000,
  created_at_ms      INTEGER NOT NULL,
  last_touch_ms      INTEGER NOT NULL,
  closed_at_ms       INTEGER,
  metadata_json      TEXT,
  CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at_ms IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_forks_open_ttl ON forks(status, last_touch_ms);
CREATE INDEX IF NOT EXISTS idx_forks_conv ON forks(conversation_id, created_at_ms);

CREATE TABLE IF NOT EXISTS decision_events (
  event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key         TEXT UNIQUE,
  fork_id            TEXT,
  project_id         TEXT NOT NULL,
  conversation_id    TEXT,
  source             TEXT NOT NULL CHECK (source IN ('hook','agy_stream','transcript','rest_api','cli','wrap','ttl_orphan','neon_backprop')),
  route              TEXT NOT NULL CHECK (route IN ('file_select','tool_select','retry_or_abort','delegate_swarm')),
  tool_name          TEXT NOT NULL,
  tool_class         TEXT NOT NULL,
  ok                 INTEGER NOT NULL CHECK (ok IN (0, 1)),
  weight             REAL NOT NULL DEFAULT 1.0,
  is_retry           INTEGER NOT NULL DEFAULT 0,
  target_hash        TEXT,
  error_snippet      TEXT,
  created_at_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_proj_time ON decision_events(project_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_events_conv_source ON decision_events(conversation_id, source);

CREATE TABLE IF NOT EXISTS session_cursor (
  conversation_id    TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  has_hook_coverage  INTEGER NOT NULL DEFAULT 0,
  last_failed_tool   TEXT,
  last_failed_target TEXT,
  last_failed_step   INTEGER,
  session_consec_err INTEGER NOT NULL DEFAULT 0,
  updated_at_ms      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agy_budget (
  day                TEXT PRIMARY KEY,
  turns_used         INTEGER NOT NULL DEFAULT 0,
  sessions_started   INTEGER NOT NULL DEFAULT 0,
  updated_at_ms      INTEGER NOT NULL
);
`);
}

export interface ProjectIdentity {
  projectId: string;
  projectLabel: string;
}

function identityForPath(realRoot: string): ProjectIdentity {
  const digest = createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  return { projectId: `proj_${digest}`, projectLabel: path.basename(realRoot) || realRoot };
}

/**
 * 프로젝트 스코핑(§3.4): git 루트 realpath sha256 앞 16자리. 비-git이면 cwd realpath 기준.
 */
export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  let root: string;
  try {
    const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    root = res.status === 0 && res.stdout.trim() ? res.stdout.trim() : fs.realpathSync(cwd);
  } catch {
    root = fs.realpathSync(cwd);
  }
  return identityForPath(fs.realpathSync(root));
}

function localDay(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * agy 일일 턴 예산 계측(B2 — §6.4 강등 규칙용). upsert 단일 트랜잭션.
 */
export function bumpAgyBudget(
  db: DatabaseSync,
  delta: { turns?: number; sessions?: number },
  nowMs = Date.now()
): void {
  const day = localDay(new Date(nowMs));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO agy_budget (day, turns_used, sessions_started, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         turns_used = turns_used + excluded.turns_used,
         sessions_started = sessions_started + excluded.sessions_started,
         updated_at_ms = excluded.updated_at_ms`
    ).run(day, delta.turns ?? 0, delta.sessions ?? 0, nowMs);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getAgyBudget(
  db: DatabaseSync,
  nowMs = Date.now()
): { day: string; turnsUsed: number; sessionsStarted: number } | null {
  const row = db
    .prepare('SELECT day, turns_used, sessions_started FROM agy_budget WHERE day = ?')
    .get(localDay(new Date(nowMs))) as { day: string; turns_used: number; sessions_started: number } | undefined;
  return row ? { day: row.day, turnsUsed: row.turns_used, sessionsStarted: row.sessions_started } : null;
}
