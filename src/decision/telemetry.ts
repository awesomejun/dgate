/**
 * TUI·매퍼용 읽기전용 텔레메트리 어댑터 (plan-r2.1 §3.2·§5.2).
 *
 * 목적: `cli.ts --watch-db`(N8)·W2-B UI 구독이 SSOT를 `readOnly + query_only`로만 읽게
 * 하고, DB 미존재·오류 시 휴리스틱 사전확률(prior)로 즉시 폴백해 관제 화면이 죽지 않게 한다.
 *
 * 외부 연결:
 * - `cli.ts --watch-db`: 최초 1회 라우트 로드(W1) — 주기 구독 훅은 W2-B가 붙인다.
 * - `dg-hook.ts --collect`(W3): `markHookCoverage`·`hasHookCoverageById` 사용.
 *
 * 주의: 이 모듈은 표시용 읽기 경로와 쓰기 헬퍼만 제공한다. 통계 갱신 판정은
 * `engine.recordToolOutcome`을 경유해야 하며(단일 구현 원칙), reader 연결로 쓰지 않는다.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DecisionRoute } from '../types.ts';
import { openDb, openDbSafe, resolveDbPath, resolveProjectIdentity } from './db.ts';
import {
  getPosterior,
  hasHookCoverage,
  recordToolOutcome,
  ROUTE_IDS,
  type EventSource,
  type RouteId,
} from './engine.ts';

/** 라우트별 TUI 표기명 — store.ts 초기 라우트 라벨 체계와 동일 */
const ROUTE_LABELS: Record<RouteId, string> = {
  file_select: '어느 파일',
  tool_select: '어느 도구',
  retry_or_abort: '재시도 또는 중단',
  delegate_swarm: '스웜 위임',
};

/** 라우트별 대표 tool_class (표본 없을 때 휴리스틱 조회 기준 키) */
const REPRESENTATIVE_CLASS: Record<RouteId, string> = {
  file_select: 'file_read',
  tool_select: 'shell_exec',
  retry_or_abort: 'other',
  delegate_swarm: 'swarm_dispatch',
};

/**
 * DB 미존재·오류 시 휴리스틱 prior safe fallback(§3.5).
 * p0 테이블값을 `basis:'prior', samples:0`으로 반환한다.
 */
export function heuristicPriorRoutes(): DecisionRoute[] {
  const priors: Record<RouteId, number> = {
    file_select: 0.94,
    tool_select: 0.88,
    retry_or_abort: 0.85,
    delegate_swarm: 0.8,
  };
  return ROUTE_IDS.map((id) => ({
    name: ROUTE_LABELS[id],
    p: priors[id],
    id,
    basis: 'prior' as const,
    samples: 0,
    consecutiveErrors: 0,
    forcedSplit: false,
  }));
}

export interface TelemetrySnapshot {
  routes: DecisionRoute[];
  dbPath: string;
  live: boolean;
}

/**
 * 읽기전용 구독 진입점: `readOnly: true, timeout: 1000`(정수) + `PRAGMA query_only=ON`.
 * 실패 시 휴리스틱 폴백 스냅숏(live=false)을 반환한다.
 */
export function readTelemetrySnapshot(dbPathInput?: string | null, cwd = process.cwd()): TelemetrySnapshot {
  const dbPath = resolveDbPath(dbPathInput);
  const db = openDbSafe(dbPath, { readOnly: true, busyTimeoutMs: 1000 });
  if (!db) return { routes: heuristicPriorRoutes(), dbPath, live: false };
  try {
    const { projectId } = resolveProjectIdentity(cwd);
    const routes = ROUTE_IDS.map((id) => {
      // 라우트 내 최다 표본 tool_class를 대표로 선택(동률면 tool_class 이름순)
      const rows = db
        .prepare(
          `SELECT tool_class FROM stats_summary
           WHERE project_id = ? AND route = ? ORDER BY raw_samples DESC, tool_class ASC LIMIT 1`
        )
        .all(projectId, id) as { tool_class: string }[];
      const toolClass = rows[0]?.tool_class ?? REPRESENTATIVE_CLASS[id];
      const post = getPosterior(db, projectId, id, toolClass);
      return {
        name: ROUTE_LABELS[id],
        p: post.p,
        id,
        basis: post.basis,
        samples: post.samples,
        consecutiveErrors: post.consecutiveErrors,
        forcedSplit: post.consecutiveErrors >= 2,
      } satisfies DecisionRoute;
    });
    return { routes, dbPath, live: true };
  } finally {
    try {
      db.close();
    } catch {
      /* 무시 */
    }
  }
}

export interface SafeRecordInput {
  projectId: string;
  projectLabel: string;
  route: RouteId;
  toolClass: string;
  toolName: string;
  ok: boolean;
  weight?: number;
  isRetry?: boolean;
  conversationId?: string | null;
  step?: number | null;
  targetHash?: string | null;
  errorSnippet?: string | null;
  source?: EventSource;
  dedupeKey?: string | null;
  forkId?: string | null;
  commandLine?: string | null;
}

/** 쓰기 헬퍼: 매퍼·훅이 짧은 생명의 연결로 1표본 기록. DB 오류 시 기록 생략 후 보고(§3.5). */
export function recordToolOutcomeSafe(
  dbPath: string | null | undefined,
  input: SafeRecordInput
): { recorded: boolean; reason?: string; isRetry: boolean } {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath ?? undefined);
    const res = recordToolOutcome(db, input);
    return { recorded: res.recorded, reason: res.reason, isRetry: res.isRetry };
  } catch (err) {
    process.stderr.write(`[telemetry] record fallback: ${(err as Error).message}\n`);
    return { recorded: false, reason: 'db-error', isRetry: false };
  } finally {
    try {
      db?.close();
    } catch {
      /* 무시 */
    }
  }
}

/** `has_hook_coverage=1` 마킹 — transcriptMapper 중복 쓰기 금지 판정용(§3.3-4) */
export function markHookCoverage(dbPath: string | null | undefined, conversationId: string, projectId: string): void {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath ?? undefined);
    db.prepare(
      `INSERT INTO session_cursor
         (conversation_id, project_id, has_hook_coverage, session_consec_err, updated_at_ms)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET has_hook_coverage = 1, updated_at_ms = ?`
    ).run(conversationId, projectId, Date.now(), Date.now());
  } catch (err) {
    process.stderr.write(`[telemetry] hook coverage fallback: ${(err as Error).message}\n`);
  } finally {
    try {
      db?.close();
    } catch {
      /* 무시 */
    }
  }
}

export function hasHookCoverageById(dbPath: string | null | undefined, conversationId: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath ?? undefined, { readOnly: true, busyTimeoutMs: 1000 });
    return hasHookCoverage(db, conversationId);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* 무시 */
    }
  }
}
