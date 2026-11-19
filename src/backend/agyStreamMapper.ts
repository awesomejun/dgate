import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  appendLog,
  formatCompactPath,
  formatNowHHMMSS,
  formatTokensCount,
} from '../state/store.ts';
import { openDbSafe, resolveDbPath, resolveProjectIdentity } from '../decision/db.ts';
import {
  classifyTool,
  evaluateForced,
  getPosterior,
  priorP0,
  type RouteId,
} from '../decision/engine.ts';
import {
  hasHookCoverageById,
  readTelemetrySnapshot,
  recordToolOutcomeSafe,
} from '../decision/telemetry.ts';
import { redactSecrets } from '../decision/redact.ts';
import type { AppState, DecisionBasis } from '../types.ts';

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyInitEvent {
  event: 'init';
  conversation_id?: string;
  init?: {
    model?: string;
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    duration_seconds?: number;
    usage?: AgyUsage;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, unknown>;
      output?: string;
      error?: string;
    };
  };
}

export interface AgyResultEvent {
  event: 'result';
  result: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AgyUsage;
  };
}

export type AgyRawEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export function isAgyRawEvent(obj: unknown): obj is AgyRawEvent {
  if (!obj || typeof obj !== 'object') return false;
  const ev = (obj as { event?: unknown }).event;
  return ev === 'init' || ev === 'step_update' || ev === 'result';
}

function classifyToolCard(toolName: string): 0 | 1 | 2 {
  const lower = toolName.toLowerCase();
  if (lower.includes('grep') || lower.includes('search_web')) return 1;
  if (
    lower.includes('run_command') ||
    lower.includes('write') ||
    lower.includes('replace') ||
    lower.includes('edit') ||
    lower.includes('sed')
  ) {
    return 2;
  }
  return 0; // read_file, view_file, list_dir, find_by_name, invoke_subagent 등
}

function summarizeToolParam(toolName: string, params?: Record<string, unknown>): string {
  if (!params) return '';
  const pathArg = params['Path'] ?? params['path'] ?? params['DirectoryPath'] ?? params['SearchPath'];
  if (typeof pathArg === 'string' && pathArg.length > 0) {
    return path.basename(pathArg);
  }
  const cmdArg = params['CommandLine'] ?? params['command'] ?? params['Query'] ?? params['query'];
  if (typeof cmdArg === 'string' && cmdArg.length > 0) {
    return cmdArg.length > 36 ? cmdArg.slice(0, 35) + '…' : cmdArg;
  }
  const roleArg = params['Role'] ?? params['TypeName'];
  if (typeof roleArg === 'string') return `${toolName}:${roleArg}`;
  return '';
}

function updateSwarmWorkerSlot(
  state: AppState,
  slotIdx: number,
  role: 'search' | 'grep' | 'audit',
  target: string,
  done: boolean
): void {
  const w = state.workers[slotIdx % state.workers.length];
  if (!w) return;
  w.role = role;
  if (target) w.target = target;
  w.status = done ? 'done' : 'running';
  w.progress = done ? 100 : 55;
}

function syncSwarmCount(state: AppState): void {
  state.swarmActive = state.workers.filter((w) => w.status === 'running').length;
}

// ---------------------------------------------------------------------------
// Decision SSOT 연동 공통 헬퍼 (plan-r2.1 §5.2 — transcriptMapper·agentRunner 공용)

/** 쓰기 가드: demo 모드·DECISION_READONLY=1이면 DB 쓰기 생략(SSOT 읽기 동기화만) */
export function decisionWriteBlocked(state: AppState): boolean {
  return state.mode === 'demo' || process.env.DECISION_READONLY === '1';
}

/** state.routes·sharpCount·splitCount를 SQLite SSOT 실측으로 동기화(읽기전용 구독) */
export function syncRoutesFromSsot(state: AppState, cwd = process.cwd()): void {
  if (state.mode === 'demo') return; // 데모 라우트 표시는 데모 엔진 소유
  try {
    const snap = readTelemetrySnapshot(resolveDbPath(), cwd);
    state.routes = snap.routes;
    const splits = snap.routes.filter((r) => r.forcedSplit === true || r.p < 0.7).length;
    state.splitCount = splits;
    state.sharpCount = snap.routes.length - splits;
  } catch {
    // §3.5 안전 폴백: 텔레메트리 실패 시 기존 라우트 유지
  }
}

export interface ToolDecision {
  route: RouteId;
  toolClass: string;
  tag: 'sharp' | 'split';
  p: number;
  basis: DecisionBasis;
  forcedSplit: boolean;
}

/**
 * 도구 1건의 SSOT 실측 판정(p·basis·sharp/split·forcedSplit).
 * DB 미존재·오류 시 사전확률(p0, basis='prior') 폴백(§3.5).
 *
 * `opts.sharpThreshold`(PB-2A, A-2): 비용 인식 동적 θ_sharp를 전달 가능하다 —
 * 로그 태그 정직성이 목적이며 미지정 시 0.70. TUI 표시 카운터
 * (`syncRoutesFromSsot`의 splitCount/sharpCount)는 표시 기준 0.70을 유지하므로
 * θ > 0.70 시 카운터와 로그가 발산할 수 있음을 명시한다.
 */
export function evaluateToolDecision(
  toolName: string,
  args: Record<string, unknown> | undefined,
  conversationId: string | null,
  cwd = process.cwd(),
  opts?: { sharpThreshold?: number }
): ToolDecision {
  const theta = opts?.sharpThreshold ?? 0.7;
  const { route, toolClass } = classifyTool(toolName, args);
  const fallback = (): ToolDecision => {
    const p = priorP0(route, toolClass);
    return {
      route,
      toolClass,
      tag: p >= theta ? 'sharp' : 'split',
      p,
      basis: 'prior',
      forcedSplit: false,
    };
  };
  const db = openDbSafe(resolveDbPath(), { readOnly: true, busyTimeoutMs: 1000 });
  if (!db) return fallback();
  try {
    const { projectId } = resolveProjectIdentity(cwd);
    const post = getPosterior(db, projectId, route, toolClass);
    const forced = evaluateForced(db, projectId, route, toolClass, conversationId);
    const split = forced.forcedSplit || post.p < theta;
    return {
      route,
      toolClass,
      tag: split ? 'split' : 'sharp',
      p: post.p,
      basis: post.basis,
      forcedSplit: forced.forcedSplit,
    };
  } catch {
    return fallback();
  } finally {
    try {
      db.close();
    } catch {
      /* 무시 */
    }
  }
}

/** §4.5 target_hash = sha256(path || command_prefix) — 재시도 지문 */
export function targetHashForArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const pathArg = args['Path'] ?? args['path'] ?? args['FilePath'] ?? args['DirectoryPath'];
  if (typeof pathArg === 'string' && pathArg) {
    return createHash('sha256').update(pathArg).digest('hex').slice(0, 16);
  }
  const cmdArg = args['CommandLine'] ?? args['command'];
  if (typeof cmdArg === 'string' && cmdArg) {
    const prefix = cmdArg.trim().split(/\s+/).slice(0, 4).join(' ');
    return createHash('sha256').update(prefix).digest('hex').slice(0, 16);
  }
  return null;
}

/** 자기 호출 제외(B6) 판정용 명령문 추출 — engine이 dg.ts/dg-hook.ts 토큰을 탐지 */
export function commandLineOfArgs(args: Record<string, unknown> | undefined): string | null {
  const v = args?.['CommandLine'] ?? args?.['command'];
  return typeof v === 'string' && v ? v : null;
}

// ---------------------------------------------------------------------------
// totalForks 이중 카운트 방지 (선행 버그 #2 — §5.1)

interface AgyMapperCtx {
  counted: Set<string>;
}
const agyMapperCtx = new WeakMap<AppState, AgyMapperCtx>();

/**
 * 도구 스텝 1건 = totalForks 1회만 가산한다.
 * step_index 유효 시 `convId:step_index` 키로 ACTIVE·DONE 어느 쪽이 먼저 와도 1회.
 * step_index 누락(N5)은 ACTIVE에서만 가산한다(DONE은 미상관 스텝으로 간주).
 */
function countAgyForkOnce(
  state: AppState,
  conversationId: string | null,
  stepIndex: number | undefined,
  phase: 'ACTIVE' | 'DONE'
): void {
  if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex)) {
    if (phase === 'ACTIVE') state.totalForks += 1;
    return;
  }
  let ctx = agyMapperCtx.get(state);
  if (!ctx) {
    ctx = { counted: new Set() };
    agyMapperCtx.set(state, ctx);
  }
  const key = `${conversationId ?? ''}:${stepIndex}`;
  if (ctx.counted.has(key)) return;
  ctx.counted.add(key);
  state.totalForks += 1;
}

/**
 * agy --output-format stream-json 의 단일 NDJSON 이벤트를 AppState에 반영합니다.
 */
export function applyAgyEvent(state: AppState, raw: AgyRawEvent): void {
  if (raw.event === 'init') {
    if (raw.conversation_id) {
      state.conversationId = raw.conversation_id;
    }
    if (raw.init?.model) {
      state.modelName = raw.init.model;
      state.modelFlag = `--model ${raw.init.model}`;
      if (raw.init.model.toLowerCase().includes('neon')) {
        state.neonModelName = raw.init.model;
        state.neonModelFlag = `--model ${raw.init.model}`;
        state.neonState = 'run';
        state.neonProgress = 12;
        state.neonLabel = '세션 교차 검증';
      }
    }
    if (raw.init?.cwd) {
      state.cwd = formatCompactPath(raw.init.cwd);
    }
    state.phase = '초기화';
    state.advisorState = '대기 중';
    state.activeTrigger = -1;
    appendLog(
      state,
      'Argon',
      'orange',
      `세션 연결됨 (${raw.init?.model ?? state.modelName})`
    );
    return;
  }

  if (raw.event === 'step_update') {
    const u = raw.step_update;
    if (u.conversation_id) state.conversationId = u.conversation_id;

    if (u.usage?.total_tokens) {
      state.totalTokensUsed = Math.max(state.totalTokensUsed, u.usage.total_tokens);
      state.tokensRead = formatTokensCount(state.totalTokensUsed);
    }

    if (u.step_type === 'user_input') {
      state.phase = '추론 시작';
      return;
    }

    if (u.step_type === 'agent_response') {
      if (u.text_delta) {
        state.latestResponse += u.text_delta;
      }
      if (u.state === 'ACTIVE') {
        state.phase = '응답 스트리밍';
        if (state.modelName.toLowerCase().includes('neon')) {
          state.neonState = 'run';
          state.neonProgress = Math.min(92, Math.max(30, state.neonProgress + 8));
        }
      } else if (u.state === 'DONE') {
        state.phase = '응답 생성';
        const preview = state.latestResponse.trim().split('\n').pop()?.trim();
        if (preview) {
          state.backSummary =
            preview.length > 44 ? preview.slice(0, 43) + '…' : preview;
        }
        if (u.duration_seconds !== undefined) {
          appendLog(
            state,
            'Argon',
            'orange',
            `응답 스텝 완료 (${u.duration_seconds.toFixed(1)}s, 토큰 ${state.tokensRead})`
          );
        }
      }
      return;
    }

    if (u.step_type === 'tool') {
      const toolName = u.tool_name ?? u.tool_info?.name ?? 'tool';
      const cardIdx = classifyToolCard(toolName);
      const card = state.cards[cardIdx]!;
      const hint = summarizeToolParam(toolName, u.tool_info?.parameters);
      const stepSlot = u.step_index ?? state.totalForks;
      const convId = u.conversation_id ?? state.conversationId;
      const params = u.tool_info?.parameters;
      const role = cardIdx === 1 ? 'grep' : cardIdx === 2 ? 'audit' : 'search';

      // 1스텝 1회만 가산 (선행 버그 #2 — ACTIVE·DONE 이중 카운트 제거)
      countAgyForkOnce(state, convId, u.step_index, u.state === 'DONE' ? 'DONE' : 'ACTIVE');

      if (u.state === 'ACTIVE') {
        state.phase = `도구: ${toolName}`;
        // SQLite SSOT 실측 평가 — 고정 휴리스틱/'sharp' 하드코딩 제거(§5.1-2)
        const decision = evaluateToolDecision(toolName, params, convId);
        syncRoutesFromSsot(state);
        card.status = 'running';
        card.progress = Math.min(85, Math.max(25, card.progress + 35));
        card.description = hint ? `${toolName}(${hint})` : `${toolName} 실행 중`;

        updateSwarmWorkerSlot(state, stepSlot, role, hint || toolName, false);
        syncSwarmCount(state);

        appendLog(
          state,
          `Decision 1`,
          'green',
          `도구 분기 → ${toolName}${hint ? ` (${redactSecrets(hint)})` : ''}  ${decision.tag} (p=${decision.p.toFixed(2)}, ${decision.basis})`
        );
      } else if (u.state === 'DONE') {
        const errText = u.tool_info?.error;
        const ok = !errText;
        if (!ok) {
          state.consecutiveToolErrors += 1;
          card.status = 'error';
          if (state.consecutiveToolErrors >= 2) {
            state.activeTrigger = 1;
            state.advisorState = '자문 중';
            state.carbonCalls += 1;
            state.latestAdvice = `» ${redactSecrets(toolName)} 연속 오류 감지 — 파라미터/경로 재검토 필요`;
            appendLog(state, 'Carbon', 'purple', `같은 오류 2회 감지 — ${redactSecrets(toolName)}`);
          }
        } else {
          state.consecutiveToolErrors = 0;
          card.status = 'done';
          card.progress = 100;
        }

        // [N5] step_index가 유효 숫자일 때만 멱등 키 발급 — 누락 시 totalForks 폴백 없이 기록 생략.
        // 쓰기 가드: demo·DECISION_READONLY·has_hook_coverage=1이면 쓰기 생략(SSOT 읽기 동기화만).
        const hasStepIdx = typeof u.step_index === 'number' && Number.isFinite(u.step_index);
        if (!decisionWriteBlocked(state) && hasStepIdx) {
          const dbPath = resolveDbPath();
          const hookCovered = convId ? hasHookCoverageById(dbPath, convId) : false;
          if (!hookCovered) {
            try {
              const { route, toolClass } = classifyTool(toolName, params);
              const { projectId, projectLabel } = resolveProjectIdentity(process.cwd());
              recordToolOutcomeSafe(dbPath, {
                projectId,
                projectLabel,
                route,
                toolClass,
                toolName,
                ok,
                conversationId: convId,
                step: u.step_index,
                targetHash: targetHashForArgs(params),
                errorSnippet: errText ? redactSecrets(String(errText)).slice(0, 300) : null,
                source: 'agy_stream',
                dedupeKey: `agy:${convId ?? 'unknown'}:${u.step_index}`,
                commandLine: redactSecrets(commandLineOfArgs(params) ?? '') || null,
              });
            } catch {
              // fail-open — 수집 실패가 UI를 죽이지 않는다(§3.5)
            }
          }
        }
        syncRoutesFromSsot(state);

        updateSwarmWorkerSlot(state, stepSlot, role, hint || toolName, true);
        syncSwarmCount(state);

        const post = evaluateToolDecision(toolName, params, convId);
        appendLog(
          state,
          'Decision 1',
          'green',
          `${toolName} 결과 → ${post.tag} (p=${post.p.toFixed(2)}, ${post.basis})`
        );

        const dur =
          u.duration_seconds !== undefined ? ` (${u.duration_seconds.toFixed(2)}s)` : '';
        const out = u.tool_info?.output ? ` · ${redactSecrets(u.tool_info.output)}` : '';
        appendLog(
          state,
          `Hydrogen ${role}`,
          'blue',
          `${toolName}${hint ? ` [${redactSecrets(hint)}]` : ''} 완료${dur}${out}`
        );
      }
      return;
    }

    // 기타 step_type(subagent 등)
    if (u.step_type) {
      appendLog(
        state,
        'Hydrogen',
        'blue',
        `${u.step_type} (${u.state ?? 'UPDATE'})`
      );
    }
    return;
  }

  if (raw.event === 'result') {
    const r = raw.result;
    if (r.conversation_id) state.conversationId = r.conversation_id;
    if (r.usage?.total_tokens) {
      state.totalTokensUsed = Math.max(state.totalTokensUsed, r.usage.total_tokens);
      state.tokensRead = formatTokensCount(state.totalTokensUsed);
    }

    if (r.response && r.response.trim().length > 0) {
      state.latestResponse = r.response.trim();
    }

    // 모든 실행 중인 워커 완료 마킹
    for (const w of state.workers) {
      if (w.status === 'running') {
        w.status = 'done';
        w.progress = 100;
      }
    }
    syncSwarmCount(state);

    if (r.status === 'SUCCESS') {
      state.phase = '완료';
      state.activeTrigger = 2;
      state.advisorState = '대기 중';
      const firstLine = state.latestResponse.split('\n').find((l) => l.trim().length > 0) ?? '응답 완료';
      state.backSummary =
        firstLine.length > 42 ? firstLine.slice(0, 41) + '… (r:전문)' : `${firstLine} (r:전문)`;
      if (state.modelName.toLowerCase().includes('neon')) {
        state.neonState = 'pass';
        state.neonProgress = 100;
        state.neonVerified += 1;
        state.neonSummary = firstLine;
        state.neonHistory.push({
          time: formatNowHHMMSS(),
          label: state.neonLabel || '세션 교차 검증',
          status: 'pass',
          summary: firstLine,
          model: state.neonModelName,
        });
      }
      appendLog(
        state,
        state.modelName.toLowerCase().includes('neon') ? 'Neon' : 'Argon',
        state.modelName.toLowerCase().includes('neon') ? 'neon' : 'orange',
        `턴 완료 (${r.duration_seconds?.toFixed(1) ?? '?'}s · r 키로 전문 보기)`
      );
    } else {
      state.phase = '오류';
      state.activeTrigger = 1;
      state.advisorState = '자문 중';
      const errMsg = redactSecrets(r.error ?? '실행 오류');
      state.latestAdvice = `» 실행 중단: ${errMsg}`;
      state.backSummary = `오류: ${errMsg.slice(0, 36)}`;
      if (state.modelName.toLowerCase().includes('neon')) {
        state.neonState = 'fail';
        state.neonProgress = 100;
        state.neonSummary = errMsg;
      }
      appendLog(state, 'Carbon', 'purple', `오류 발생 — ${errMsg}`);
    }
  }
}
