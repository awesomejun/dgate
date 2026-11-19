/**
 * `src/decision/report.ts` — B5 완전 읽기전용 규칙 후보 리포트 생성기 (PB-2B).
 *
 * 목적: `decision_events`/`forks` 통계에서 "사람이 검토할 규칙 후보" 4종(도구 반복·
 * 핑퐁·FailureCause·고아/스톨)을 집계해 구조화 JSON + 마크다운으로만 출력한다.
 * 프롬프트·역할 파일(`.herdr/roles/*`)·기억·DB 내용 자동 수정 기능은 존재하지
 * 않으며 향후에도 만들지 않는다(자동 변조 영구 금지 — 설계 §5.1).
 *
 * 외부 연결:
 * - `dg report` CLI 배선은 통합 단계에서 `dg.ts`에 등록한다(PB-2B는 모듈 본체만 제공).
 * - `openReportDb`는 `openDb(readOnly)` 전용 래퍼 — `settleOrphans` 등 어떤 쓰기도
 *   호출하지 않는다(읽기전용 연결 + `PRAGMA query_only=ON` 이중 보장).
 * - `tests/phaseb-checkpoint-report.test.ts`가 v1/v2 DB 무변조·allowlist 가드를 검증.
 *
 * 주의:
 * - v1 DB 안전 호환(검증서 주의 8): `hasTable('fork_intervals')`·
 *   `hasColumn('decision_events','cause')`·`hasColumn('forks','attempt')`로 지표 가용성을
 *   판정하고, v1 전용 컬럼이 필요한 지표는 크래시 없이 `unavailable`로 표기한다.
 *   (`cause`는 v1에서 `error_snippet`의 `cause=<enum>;` 접두 파싱으로 대체 집계)
 * - `--out` 경로는 allowlist로 통제한다(검증서 A-1): `<repoDir>/.herdr/report/` 내부
 *   또는 저장소 외부 절대경로만 허용하고, 그 외 저장소 내부 경로는 전부 거부한다.
 * - 모든 `error_snippet` 출력은 `redactSecrets`를 재적용한다(2차 방어).
 * - 외부 의존성 0, `erasableSyntaxOnly` 준수(enum·파라미터 프로퍼티 없음).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hasColumn, hasTable, openDb } from './db.ts';
import { FAILURE_CAUSES } from './engine.ts';
import { redactSecrets } from './redact.ts';

/** 기본 집계 윈도우(일) — 설계 §5.2 */
export const DEFAULT_REPORT_DAYS = 14;
/** 규칙 후보 상위 노출 한 */
export const TOP_N = 12;

/** `dg report`용 읽기전용 연결 — 쓰기 옵션 자체가 존재하지 않는다 */
export function openReportDb(dbPath?: string): DatabaseSync {
  return openDb(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
}

// ---------- 집계 타입 ----------

export interface ReportWindow {
  days: number;
  from_ms: number;
  to_ms: number;
}

export interface ToolRepetitionRow {
  route: string;
  tool_name: string;
  tool_class: string;
  events: number;
  fail: number;
  fail_ratio: number;
  retries: number;
  candidate: boolean;
}

export interface PingpongStats {
  available: boolean;
  retry_events: number;
  total_events: number;
  retry_ratio: number;
  candidate: boolean;
  forks_total: number;
  rework_forks: number | null;
  rework_ratio: number | null;
  /** v1 DB는 `forks.attempt` 컬럼 부재 — attempt>=2 집계 불가 */
  attempt_available: boolean;
}

export interface CauseRow {
  cause: string;
  count: number;
  ratio: number;
  example: string | null;
  candidate: boolean;
}

export interface OrphanStallStats {
  available: boolean;
  ttl_orphan_events: number;
  ttl_orphan_ratio: number;
  stall_events: number | null;
  stall_ratio: number | null;
  stall_available: boolean;
  level: 'none' | 'warn' | 'critical';
}

export interface RuleCandidateReport {
  command: 'report';
  schema_version: 1;
  generated_at_ms: number;
  window: ReportWindow;
  project_id: string | null;
  totals: { events: number; forks: number };
  sections: {
    tool_repetition: { available: true; rows: ToolRepetitionRow[] } | { available: false; reason: string };
    pingpong: PingpongStats;
    failure_causes:
      | { available: true; source: 'column' | 'snippet'; rows: CauseRow[] }
      | { available: false; reason: string };
    orphan_stall: OrphanStallStats;
  };
  thresholds: {
    tool_min_events: number;
    pingpong_ratio: number;
    cause_min_count: number;
    orphan_warn: number;
    orphan_critical: number;
  };
  /** 채택 임계를 만족한 후보 식별자(예: `tool_repetition:run_command`) */
  candidates: string[];
}

export interface ReportOptions {
  projectId?: string | null;
  days?: number;
  nowMs?: number;
}

// ---------- 내부 집계 헬퍼 ----------

const VALID_CAUSES: ReadonlySet<string> = new Set(FAILURE_CAUSES);

/** `cause=<enum>; …` 접두 규약 파싱 — 미상·불일치는 null (추정 금지) */
function parseCauseFromSnippet(snippet: string | null | undefined): string | null {
  if (typeof snippet !== 'string' || !snippet.startsWith('cause=')) return null;
  const head = snippet.slice('cause='.length);
  const semi = head.indexOf(';');
  const value = head.slice(0, semi < 0 ? head.length : semi);
  return VALID_CAUSES.has(value) ? value : null;
}

function ratioOf(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function scalar(db: DatabaseSync, sql: string, args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as { c: number } | undefined;
  return typeof row?.c === 'number' ? row.c : Number(row?.c ?? 0);
}

// ---------- 4대 규칙 후보 집계 ----------

export function generateRuleCandidateReport(db: DatabaseSync, opts: ReportOptions = {}): RuleCandidateReport {
  const nowMs = opts.nowMs ?? Date.now();
  const days =
    typeof opts.days === 'number' && Number.isFinite(opts.days) && opts.days > 0 ? Math.floor(opts.days) : DEFAULT_REPORT_DAYS;
  const fromMs = nowMs - days * 86_400_000;
  const projectId = opts.projectId ?? null;

  const eventsTable = hasTable(db, 'decision_events');
  const forksTable = hasTable(db, 'forks');
  const hasCauseCol = eventsTable && hasColumn(db, 'decision_events', 'cause');
  const hasAttemptCol = forksTable && hasColumn(db, 'forks', 'attempt');

  const evConds = ['created_at_ms >= ?', 'created_at_ms <= ?'];
  const evArgs: unknown[] = [fromMs, nowMs];
  if (projectId) {
    evConds.push('project_id = ?');
    evArgs.push(projectId);
  }
  const evWhere = evConds.join(' AND ');

  const totalEvents = eventsTable ? scalar(db, `SELECT COUNT(*) AS c FROM decision_events WHERE ${evWhere}`, evArgs) : 0;
  const totalForks = forksTable
    ? scalar(
        db,
        `SELECT COUNT(*) AS c FROM forks WHERE ${['created_at_ms >= ?', 'created_at_ms <= ?', ...(projectId ? ['project_id = ?'] : [])].join(' AND ')}`,
        projectId ? [fromMs, nowMs, projectId] : [fromMs, nowMs]
      )
    : 0;

  // ① 도구 반복 상위 12 — (route, tool_name, tool_class) 실패/반복
  let toolRepetition: RuleCandidateReport['sections']['tool_repetition'] = {
    available: false,
    reason: 'decision_events table missing',
  };
  if (eventsTable) {
    const rows = db
      .prepare(
        `SELECT route, tool_name, tool_class, COUNT(*) AS events,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fail,
                SUM(is_retry) AS retries
         FROM decision_events WHERE ${evWhere}
         GROUP BY route, tool_name, tool_class
         ORDER BY fail DESC, events DESC, tool_name ASC, tool_class ASC
         LIMIT ${TOP_N}`
      )
      .all(...evArgs) as Array<{ route: string; tool_name: string; tool_class: string; events: number; fail: number | null; retries: number | null }>;
    toolRepetition = {
      available: true,
      rows: rows.map((r) => ({
        route: r.route,
        tool_name: r.tool_name,
        tool_class: r.tool_class,
        events: Number(r.events),
        fail: Number(r.fail ?? 0),
        fail_ratio: ratioOf(Number(r.fail ?? 0), Number(r.events)),
        retries: Number(r.retries ?? 0),
        candidate: Number(r.events) >= 5 && Number(r.fail ?? 0) > 0,
      })),
    };
  }

  // ② 핑퐁 — retry_or_abort 이벤트 비율 + (attempt >= 2 또는 metadata rework_count >= 1) fork
  const retryEvents = eventsTable
    ? scalar(db, `SELECT COUNT(*) AS c FROM decision_events WHERE ${evWhere} AND route = 'retry_or_abort'`, evArgs)
    : 0;
  const forkWhere = ['created_at_ms >= ?', 'created_at_ms <= ?', ...(projectId ? ['project_id = ?'] : [])].join(' AND ');
  const forkArgs: unknown[] = projectId ? [fromMs, nowMs, projectId] : [fromMs, nowMs];
  // json_valid 가드 선행 — 손상 JSON에서 json_extract는 예외를 던진다(검증서 주의 1)
  const metaRework = "(json_valid(metadata_json) AND CAST(json_extract(metadata_json, '$.rework_count') AS INTEGER) >= 1)";
  let reworkForks: number | null = null;
  if (forksTable) {
    const cond = hasAttemptCol ? `(attempt >= 2 OR ${metaRework})` : metaRework;
    reworkForks = scalar(db, `SELECT COUNT(*) AS c FROM forks WHERE ${forkWhere} AND ${cond}`, forkArgs);
  }
  const retryRatio = ratioOf(retryEvents, totalEvents);
  const pingpong: PingpongStats = {
    available: eventsTable,
    retry_events: retryEvents,
    total_events: totalEvents,
    retry_ratio: retryRatio,
    candidate: totalEvents > 0 && retryRatio >= 0.15,
    forks_total: totalForks,
    rework_forks: reworkForks,
    rework_ratio: reworkForks !== null && totalForks > 0 ? reworkForks / totalForks : reworkForks === 0 ? 0 : null,
    attempt_available: hasAttemptCol === true,
  };

  // ③ FailureCause 상위 12 — v2는 cause 컬럼, v1은 error_snippet 파싱
  let failureCauses: RuleCandidateReport['sections']['failure_causes'] = {
    available: false,
    reason: 'decision_events table missing',
  };
  let fullTally: Map<string, { count: number; example: string | null }> | null = null;
  if (eventsTable) {
    if (hasCauseCol) {
      const rows = db
        .prepare(
          `SELECT COALESCE(cause, 'legacy_unknown') AS cause, COUNT(*) AS cnt, MAX(error_snippet) AS example
           FROM decision_events WHERE ${evWhere}
           GROUP BY cause
           ORDER BY cnt DESC, cause ASC
           LIMIT ${TOP_N}`
        )
        .all(...evArgs) as Array<{ cause: string; cnt: number; example: string | null }>;
      failureCauses = {
        available: true,
        source: 'column',
        rows: rows.map((r) => ({
          cause: r.cause,
          count: Number(r.cnt),
          ratio: ratioOf(Number(r.cnt), totalEvents),
          example: r.example,
          candidate: Number(r.cnt) >= 3,
        })),
      };
    } else {
      // v1 fallback: 스니펫 접두 파싱(전체 집계 — ④의 stall 비율 재사용)
      const tally = new Map<string, { count: number; example: string | null }>();
      const snippets = db
        .prepare(`SELECT error_snippet FROM decision_events WHERE ${evWhere}`)
        .all(...evArgs) as Array<{ error_snippet: string | null }>;
      for (const r of snippets) {
        const cause = parseCauseFromSnippet(r.error_snippet) ?? 'legacy_unknown';
        const cur = tally.get(cause);
        tally.set(cause, { count: (cur?.count ?? 0) + 1, example: cur?.example ?? r.error_snippet });
      }
      fullTally = tally;
      const rows = [...tally.entries()]
        .map(([cause, v]) => ({
          cause,
          count: v.count,
          ratio: ratioOf(v.count, totalEvents),
          example: v.example,
          candidate: v.count >= 3,
        }))
        .sort((a, b) => b.count - a.count || (a.cause < b.cause ? -1 : 1))
        .slice(0, TOP_N);
      failureCauses = { available: true, source: 'snippet', rows };
    }
  }

  // ④ ttl_orphan / stall 비율
  const ttlOrphanEvents = eventsTable
    ? scalar(db, `SELECT COUNT(*) AS c FROM decision_events WHERE ${evWhere} AND source = 'ttl_orphan'`, evArgs)
    : 0;
  let stallEvents: number | null = null;
  let stallAvailable = false;
  if (eventsTable) {
    if (hasCauseCol) {
      stallEvents = scalar(db, `SELECT COUNT(*) AS c FROM decision_events WHERE ${evWhere} AND cause = 'stall'`, evArgs);
      stallAvailable = true;
    } else if (fullTally) {
      stallEvents = fullTally.get('stall')?.count ?? 0;
      stallAvailable = true;
    }
  }
  const ttlRatio = ratioOf(ttlOrphanEvents, totalEvents);
  const stallRatio = stallEvents !== null ? ratioOf(stallEvents, totalEvents) : null;
  const worst = Math.max(ttlRatio, stallRatio ?? 0);
  const orphanStall: OrphanStallStats = {
    available: eventsTable,
    ttl_orphan_events: ttlOrphanEvents,
    ttl_orphan_ratio: ttlRatio,
    stall_events: stallEvents,
    stall_ratio: stallRatio,
    stall_available: stallAvailable,
    level: worst >= 0.25 ? 'critical' : worst >= 0.1 ? 'warn' : 'none',
  };

  const candidates: string[] = [];
  if (toolRepetition.available) {
    for (const r of toolRepetition.rows) {
      if (r.candidate) candidates.push(`tool_repetition:${r.tool_name}`);
    }
  }
  if (pingpong.candidate) candidates.push('pingpong');
  if (failureCauses.available) {
    for (const r of failureCauses.rows) {
      if (r.candidate) candidates.push(`failure_causes:${r.cause}`);
    }
  }
  if (orphanStall.level !== 'none') candidates.push(`orphan_stall:${orphanStall.level}`);

  return {
    command: 'report',
    schema_version: 1,
    generated_at_ms: nowMs,
    window: { days, from_ms: fromMs, to_ms: nowMs },
    project_id: projectId,
    totals: { events: totalEvents, forks: totalForks },
    sections: { tool_repetition: toolRepetition, pingpong, failure_causes: failureCauses, orphan_stall: orphanStall },
    thresholds: { tool_min_events: 5, pingpong_ratio: 0.15, cause_min_count: 3, orphan_warn: 0.1, orphan_critical: 0.25 },
    candidates,
  };
}

// ---------- 사람 검토용 마크다운 렌더 ----------

function fmtRatio(v: number | null): string {
  return v === null ? 'unavailable' : v.toFixed(3);
}

/** 규칙 후보 마크다운 — 사람이 검토 후 수동 반영하는 용도뿐이다(자동 적용 금지) */
export function formatReportMarkdown(report: RuleCandidateReport): string {
  const lines: string[] = [];
  const t = report.thresholds;
  lines.push('---');
  lines.push(`candidate: ${report.candidates.length > 0 ? 'true' : 'false'}`);
  lines.push('applied: false');
  lines.push(`generated_at: ${new Date(report.generated_at_ms).toISOString()}`);
  lines.push(`window_days: ${report.window.days}`);
  lines.push(`project_id: ${report.project_id ?? '(all)'}`);
  lines.push(`schema_version: ${report.schema_version}`);
  lines.push('---');
  lines.push('');
  lines.push('# 규칙 후보 (자동 적용 금지 — 사람이 검토 후 수동 반영)');
  lines.push('');

  lines.push('## ① 반복 실패 도구 상위 12');
  if (report.sections.tool_repetition.available) {
    lines.push('| # | route | tool_name | tool_class | events | fail | fail_ratio | retries | 후보 |');
    lines.push('|--:|-------|-----------|------------|-------:|-----:|-----------:|--------:|------|');
    report.sections.tool_repetition.rows.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | ${r.route} | ${r.tool_name} | ${r.tool_class} | ${r.events} | ${r.fail} | ${fmtRatio(r.fail_ratio)} | ${r.retries} | ${r.candidate ? '**예**' : '아니오'} |`
      );
    });
    lines.push('');
    lines.push(`- 채택 임계: events >= ${t.tool_min_events} && fail > 0 — 권고는 사람이 작성한다`);
  } else {
    lines.push(`- unavailable: ${report.sections.tool_repetition.reason}`);
  }
  lines.push('');

  const pp = report.sections.pingpong;
  lines.push('## ② 핑퐁 (재시도/재작업)');
  lines.push(`- retry_or_abort 이벤트: ${pp.retry_events} / 전체 ${pp.total_events} = **${fmtRatio(pp.retry_ratio)}**`);
  if (pp.rework_forks !== null) {
    lines.push(`- rework fork (attempt >= 2 또는 rework_count >= 1): ${pp.rework_forks} / ${pp.forks_total} = ${fmtRatio(pp.rework_ratio)}`);
  } else {
    lines.push('- rework fork: unavailable (forks 테이블 부재)');
  }
  if (!pp.attempt_available) {
    lines.push('- `forks.attempt` 컬럼 부재(v1 DB) — attempt >= 2 집계는 unavailable');
  }
  lines.push(`- 후보: ${pp.candidate ? '**예**' : '아니오'} (임계 ${t.pingpong_ratio})`);
  lines.push('');

  lines.push('## ③ FailureCause 상위 12');
  if (report.sections.failure_causes.available) {
    lines.push(`- 집계 소스: ${report.sections.failure_causes.source === 'column' ? 'cause 컬럼(v2)' : 'error_snippet 파싱(v1 폴백)'}`);
    lines.push('| cause | count | ratio | 최근 예시(리댁션) |');
    lines.push('|-------|------:|------:|------------------|');
    for (const r of report.sections.failure_causes.rows) {
      const example = r.example ? redactSecrets(r.example).slice(0, 120).replace(/\|/g, '\\|') : '(없음)';
      lines.push(`| ${r.cause} | ${r.count} | ${fmtRatio(r.ratio)} | \`${example}\` |`);
    }
  } else {
    lines.push(`- unavailable: ${report.sections.failure_causes.reason}`);
  }
  lines.push('');

  const os = report.sections.orphan_stall;
  lines.push('## ④ 고아/스톨');
  lines.push(`- ttl_orphan: ${os.ttl_orphan_events} / 전체 ${report.totals.events} = **${fmtRatio(os.ttl_orphan_ratio)}** (${os.level})`);
  if (os.stall_available) {
    lines.push(`- stall: ${os.stall_events} / 전체 ${report.totals.events} = ${fmtRatio(os.stall_ratio)}`);
  } else {
    lines.push('- stall: unavailable');
  }
  lines.push(`- 경고 임계 ${t.orphan_warn} / 심각 임계 ${t.orphan_critical}`);
  lines.push('');

  lines.push('## ⑤ 적용 방법 (수동)');
  lines.push('1. 위 표에서 채택할 항목만 고른다.');
  lines.push('2. `LESSONS.md`의 기존 규칙과 중복인지 먼저 확인한다(중복 규칙 신설 금지).');
  lines.push('3. 한 줄 규칙(트리거 + 필수/금지 행동)으로 축약해 **사람이 직접** 편집한다.');
  lines.push('4. `dg report`는 이 과정에 관여하지 않는다.');
  lines.push('');
  return lines.join('\n');
}

// ---------- `--out` 경로 Allowlist 가드 (검증서 A-1) ----------

export interface OutPathValidation {
  allowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

/** 존재하면 realpath, 아니면 resolve — macOS /var↔/private/var 등 심볼릭 접두 정규화 */
function normalizeDir(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 대상 파일 경로 정규화 — 파일이 존재하면 realpath, 아니면 부모 realpath + basename */
function normalizeFilePath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    /* 파일 미존재 — 아래 부모 경로로 정규화 */
  }
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function isInside(base: string, target: string): boolean {
  const b = base.endsWith(path.sep) ? base : base + path.sep;
  return target === base || target.startsWith(b);
}

/**
 * `dg report --out` 경로 allowlist 판정.
 * - 허용: `<repoDir>/.herdr/report/` 내부, 또는 `<repoDir>` 외부 절대경로(예: /tmp).
 * - 거부: 그 외 저장소 내부 전 경로(`src/`, `scripts/`, `.agents/`, `.herdr/roles/`,
 *   `tests/`, `package.json`, `.pi/`, `..` 순회 결과 등).
 * 부모 디렉터리 realpath로 심볼릭 링크를 통한 우회(`src-link/x.md`)도 막는다.
 */
export function validateReportOutPath(outPath: string, repoDir: string): OutPathValidation {
  if (typeof outPath !== 'string' || outPath.trim().length === 0) {
    return { allowed: false, reason: 'empty_out_path' };
  }
  const resolved = normalizeFilePath(outPath);
  const repoCandidates = [...new Set([path.resolve(repoDir), normalizeDir(repoDir)])];
  const reportRoots = repoCandidates.map((r) => normalizeFilePath(path.join(r, '.herdr', 'report')));
  if (reportRoots.some((rr) => isInside(rr, resolved))) {
    return { allowed: true, resolvedPath: resolved };
  }
  if (repoCandidates.some((r) => isInside(r, resolved))) {
    return { allowed: false, resolvedPath: resolved, reason: 'forbidden_out_path' };
  }
  return { allowed: true, resolvedPath: resolved };
}

export interface WriteReportFileInput {
  outPath: string;
  repoDir: string;
  content: string;
}

export interface WriteReportFileResult {
  written: boolean;
  resolvedPath?: string;
  reason?: string;
}

/**
 * allowlist 통과 경로에만 리포트 파일을 쓴다. 거부 시 파일은 물론 부모 디렉터리도
 * 생성하지 않는다(부작용 0).
 */
export function writeReportFileSafe(input: WriteReportFileInput): WriteReportFileResult {
  const v = validateReportOutPath(input.outPath, input.repoDir);
  if (!v.allowed || !v.resolvedPath) {
    return { written: false, resolvedPath: v.resolvedPath, reason: v.reason ?? 'forbidden_out_path' };
  }
  try {
    fs.mkdirSync(path.dirname(v.resolvedPath), { recursive: true });
    fs.writeFileSync(v.resolvedPath, input.content);
    return { written: true, resolvedPath: v.resolvedPath };
  } catch (err) {
    return { written: false, resolvedPath: v.resolvedPath, reason: `write_failed: ${(err as Error).message}` };
  }
}
