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
    db.exec(`PRAGMA busy_timeout = ${busy};`);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    try {
      migrate(db, resolved);
    } catch (err) {
      try {
        db.close();
      } catch {
        /* 무시 */
      }
      throw err;
    }
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

// ---------- 스키마 버전·오브젝트 감지 헬퍼 (PB-1: DDL v2) ----------

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { one: number } | undefined;
  return row !== undefined;
}

/** `table`는 내부 상수만 전달된다 — `table_info`는 파라미터 바인딩 미지원이므로 식별자 화이트리스트 검증 */
export function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

/**
 * §3.3 DDL 전체(멱등). `forks` CHECK 제약과 `last_touch_ms NOT NULL`은 원문 그대로.
 * v1 픽스처 생성·검증 테스트와 마이그레이션의 "기타 테이블" 재사용을 위해 export한다.
 */
export function migrateV1Tables(db: DatabaseSync): void {
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

// ---------- DDL v2 (PB-1): forks 리빌드 · decision_events 확장 · fork_intervals ----------

/** v2 `forks` DDL — `name`은 forks_v2(리빌드)/forks(신규) 두 위치에서 재사용 (§1.2-a) */
function forksV2Ddl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
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
  generation         INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  attempt            INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_owner        TEXT,
  lease_expires_ms   INTEGER,
  status             TEXT NOT NULL CHECK (status IN
                       ('open','ok','fail','abandoned','rerouted','backprop_fail','interrupted','waiting_human')),
  closed_by          TEXT CHECK (closed_by IN ('dispatcher','lead','worker','ttl','verifier')),
  neon_verdict       TEXT CHECK (neon_verdict IN ('pass','fail')),
  ttl_ms             INTEGER NOT NULL DEFAULT 600000,
  created_at_ms      INTEGER NOT NULL,
  last_touch_ms      INTEGER NOT NULL,
  closed_at_ms       INTEGER,
  metadata_json      TEXT,
  CHECK (status IN ('open','waiting_human') OR (closed_by IS NOT NULL AND closed_at_ms IS NOT NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_ms IS NULL))
);`;
}

function createForksV2Indexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_forks_open_ttl ON forks(status, last_touch_ms);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_forks_conv ON forks(conversation_id, created_at_ms);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_forks_lease ON forks(status, lease_expires_ms);');
}

function createForkIntervals(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS fork_intervals (
  interval_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  fork_id        TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  phase          TEXT NOT NULL CHECK (phase IN ('exec','wait','human')),
  started_at_ms  INTEGER NOT NULL,
  ended_at_ms    INTEGER,
  CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fork_intervals_one_open
  ON fork_intervals(fork_id, attempt) WHERE ended_at_ms IS NULL;
CREATE INDEX IF NOT EXISTS idx_fork_intervals_fork
  ON fork_intervals(fork_id, started_at_ms);
CREATE INDEX IF NOT EXISTS idx_fork_intervals_phase
  ON fork_intervals(phase, started_at_ms);`);
}

/** v2 `decision_events` 컬럼 목록 — 신규 생성·ALTER 추가 두 경로에서 동일 정의 재사용 */
const DECISION_EVENTS_V2_COLUMNS: readonly { name: string; ddl: string }[] = [
  {
    name: 'cause',
    ddl: `cause TEXT CHECK (cause IS NULL OR cause IN
      ('ok_pass','transient_network','tool_error','max_turns','no_result','artifact_missing',
       'gate_fail','stall','timeout','config_error','interrupted'))`,
  },
  { name: 'input_tokens', ddl: 'input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0)' },
  { name: 'output_tokens', ddl: 'output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0)' },
  { name: 'cache_read_tokens', ddl: 'cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0)' },
  { name: 'cache_write_tokens', ddl: 'cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0)' },
  { name: 'cost_usd', ddl: 'cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0)' },
  {
    name: 'cost_status',
    ddl: `cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_status IN ('reported','estimated','unknown'))`,
  },
];

function decisionEventsV2Ddl(): string {
  const extra = DECISION_EVENTS_V2_COLUMNS.map((c) => `  ${c.ddl}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS decision_events (
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
  created_at_ms      INTEGER NOT NULL,
${extra}
);
CREATE INDEX IF NOT EXISTS idx_events_proj_time ON decision_events(project_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_events_conv_source ON decision_events(conversation_id, source);`;
}

function alterDecisionEvents(db: DatabaseSync): void {
  for (const col of DECISION_EVENTS_V2_COLUMNS) {
    if (!hasColumn(db, 'decision_events', col.name)) {
      db.exec(`ALTER TABLE decision_events ADD COLUMN ${col.ddl};`);
    }
  }
}

/**
 * v1 `forks` → v2 리빌드(§1.4): 18컬럼 + generation/attempt/lease_* 승격 백필.
 * metadata_json → 컬럼 백필은 `json_valid` + `typeof` 가드를 지킨다 —
 * 손상 JSON에서 `json_extract`는 NULL이 아니라 예외를 던지므로 조건식의
 * 첫 피연산자를 항상 `json_valid(metadata_json)`로 둔다(SQLite AND 단락 평가).
 * 리스는 owner/expires "쌍 단위" — 절반만 유효하면 둘 다 NULL로 정규화(CHECK 보호).
 */
function rebuildForks(db: DatabaseSync): void {
  db.exec(forksV2Ddl('forks_v2'));
  db.exec(`
INSERT INTO forks_v2 (
  fork_id, project_id, project_label, conversation_id, route, tool_class, decision,
  forced_split, p_at_gate, basis_at_gate, generation, attempt, lease_owner, lease_expires_ms,
  status, closed_by, neon_verdict, ttl_ms, created_at_ms, last_touch_ms, closed_at_ms, metadata_json
)
SELECT
  fork_id, project_id, project_label, conversation_id, route, tool_class, decision,
  forced_split, p_at_gate, basis_at_gate,
  CASE WHEN json_valid(metadata_json)
        AND typeof(json_extract(metadata_json, '$.gen')) = 'integer'
        AND json_extract(metadata_json, '$.gen') >= 1
       THEN json_extract(metadata_json, '$.gen') ELSE 1 END,
  CASE WHEN json_valid(metadata_json)
        AND typeof(json_extract(metadata_json, '$.attempt')) = 'integer'
        AND json_extract(metadata_json, '$.attempt') >= 1
       THEN json_extract(metadata_json, '$.attempt') ELSE 1 END,
  CASE WHEN json_valid(metadata_json)
        AND typeof(json_extract(metadata_json, '$.lease_owner')) = 'text'
        AND json_extract(metadata_json, '$.lease_owner') <> ''
        AND typeof(json_extract(metadata_json, '$.lease_until_ms')) = 'integer'
       THEN json_extract(metadata_json, '$.lease_owner') ELSE NULL END,
  CASE WHEN json_valid(metadata_json)
        AND typeof(json_extract(metadata_json, '$.lease_owner')) = 'text'
        AND json_extract(metadata_json, '$.lease_owner') <> ''
        AND typeof(json_extract(metadata_json, '$.lease_until_ms')) = 'integer'
       THEN json_extract(metadata_json, '$.lease_until_ms') ELSE NULL END,
  CASE WHEN status = 'open' AND json_valid(metadata_json)
        AND json_extract(metadata_json, '$.waiting_human') = 1
       THEN 'waiting_human' ELSE status END,
  closed_by, neon_verdict, ttl_ms, created_at_ms, last_touch_ms, closed_at_ms, metadata_json
FROM forks;`);
  db.exec('DROP TABLE forks;');
  db.exec('ALTER TABLE forks_v2 RENAME TO forks;');
  createForksV2Indexes(db);
}

/** `cause=` 접두 규약이 박힌 레거시 error_snippet에서 유효 enum만 백필 — CHECK 위반 시 전체 실패이므로 TS 루프로 필터링 */
const BACKFILL_CAUSES = new Set([
  'ok_pass', 'transient_network', 'tool_error', 'max_turns', 'no_result', 'artifact_missing',
  'gate_fail', 'stall', 'timeout', 'config_error', 'interrupted',
]);

function backfillEventCause(db: DatabaseSync): void {
  if (!hasColumn(db, 'decision_events', 'cause')) return;
  const rows = db
    .prepare(
      `SELECT event_id, error_snippet FROM decision_events
        WHERE cause IS NULL AND error_snippet LIKE 'cause=%'`
    )
    .all() as { event_id: number; error_snippet: string }[];
  const upd = db.prepare('UPDATE decision_events SET cause = ? WHERE event_id = ?');
  for (const r of rows) {
    const head = r.error_snippet.slice('cause='.length);
    const semi = head.indexOf(';');
    const v = head.slice(0, semi < 0 ? head.length : semi);
    if (BACKFILL_CAUSES.has(v)) upd.run(v, r.event_id);
  }
}

/**
 * 파일 DB 백업(§1.3): `VACUUM INTO`는 트랜잭션 밖에서만 가능하므로 BEGIN 전에 수행.
 * `${dbPath}.v1.bak.<ts>` 명명 — 이미 `.v1.bak.*`가 존재하면 재생성하지 않는다(중복 폭증 방지).
 */
function backupOnceV1(db: DatabaseSync, dbPath: string): string | null {
  if (dbPath === ':memory:') return null;
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.v1.bak.`));
  } catch {
    return null;
  }
  if (existing.length > 0) return null;
  const dest = `${dbPath}.v1.bak.${Date.now()}`;
  const safeDest = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safeDest}'`);
  return dest;
}

/** 신규 DB용 v2 DDL — forks·decision_events는 처음부터 v2로 생성한다 */
function createV2Tables(db: DatabaseSync): void {
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
`);
  db.exec(forksV2Ddl('forks'));
  createForksV2Indexes(db);
  db.exec(decisionEventsV2Ddl());
  db.exec(`
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
  createForkIntervals(db);
}

/**
 * 스키마 마이그레이션 진입점(§3.3 + PB-1 §1.3):
 * - `forks` 부재(신규 DB) → v2 스키마를 바로 생성하고 `user_version = 2`.
 * - v1 DB(`forks` 존재 AND `generation` 컬럼 부재) → VACUUM INTO 백업 후
 *   단일 `BEGIN IMMEDIATE ... COMMIT` 내부에서 재판정·리빌드·백필·`user_version = 2`.
 *   예외 시 ROLLBACK으로 v1을 그대로 보존한다.
 * - 핫패스(`user_version >= 2` AND `generation` 존재)는 비용 0으로 반환.
 * - `dbPath`는 백업 파일명에만 쓰인다(생략 시 백업 생략).
 */
export function migrate(db: DatabaseSync, dbPath?: string): void {
  // 신규 DB(forks 부재)는 처음부터 v2 — v1 테이블을 먼저 만들면 판정을 오도한다
  if (!hasTable(db, 'forks')) {
    // 단일 IMMEDIATE Tx + 재판정: 다중 프로세스 동시 최초 생성 경합에서
    // 나중 진입자는 user_version을 보고 no-op (v1 승격 경로와 동일 계약)
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getSchemaVersion(db) >= 2) {
        db.exec('COMMIT');
        return;
      }
      createV2Tables(db);
      alterDecisionEvents(db); // 부분 존재 DB: 기존 v1 decision_events에는 컬럼만 추가
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 무시 */
      }
      throw err;
    }
    return;
  }
  // 핫패스(읽기 전용 프로브 2회): v2 완료 DB는 즉시 반환. 매 open마다 CREATE IF NOT EXISTS를
  // 실행하면 WAL 쓰기 잠금을 점유해 동시 writer 경합 시 SQLITE_BUSY로 폴백을 유발한다(§3.3).
  if (getSchemaVersion(db) >= 2 && hasColumn(db, 'forks', 'generation')) return;
  // v1 또는 부분 스키마 DB: 나머지 v1 테이블을 멱등 생성으로 채운 뒤 승격 경로 진입
  migrateV1Tables(db);

  // v1 → v2: 백업은 BEGIN IMMEDIATE 이전에 수행해야 한다(VACUUM INTO는 tx 불가)
  if (dbPath) backupOnceV1(db, dbPath);
  db.exec('BEGIN IMMEDIATE');
  try {
    // 재판정(경합 안전 핵심): 다른 프로세스가 먼저 승격했으면 no-op
    if (getSchemaVersion(db) >= 2 && hasColumn(db, 'forks', 'generation')) {
      db.exec('COMMIT');
      return;
    }
    if (!hasColumn(db, 'forks', 'generation')) rebuildForks(db);
    if (!hasTable(db, 'decision_events')) {
      db.exec(decisionEventsV2Ddl());
    } else {
      alterDecisionEvents(db);
    }
    createForkIntervals(db);
    backfillEventCause(db);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw err;
  }
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
