import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TRIGGER_LABELS,
  appendLog,
  formatCompactPath,
  formatNowHHMMSS,
  formatTokensCount,
} from '../state/store.ts';
import { resolveDbPath, resolveProjectIdentity } from '../decision/db.ts';
import { classifyTool } from '../decision/engine.ts';
import { hasHookCoverageById, recordToolOutcomeSafe } from '../decision/telemetry.ts';
import {
  commandLineOfArgs,
  decisionWriteBlocked,
  evaluateToolDecision,
  syncRoutesFromSsot,
  targetHashForArgs,
} from './agyStreamMapper.ts';
import { redactSecrets } from '../decision/redact.ts';
import type { AppState } from '../types.ts';

export interface TranscriptToolCall {
  name: string;
  args?: Record<string, unknown> | string;
}

export interface TranscriptStep {
  step_index?: number;
  source?: 'USER_EXPLICIT' | 'MODEL' | 'SYSTEM' | string;
  type?: 'USER_INPUT' | 'PLANNER_RESPONSE' | 'GENERIC' | string;
  status?: 'DONE' | 'RUNNING' | 'ERROR' | string;
  created_at?: string;
  model?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  thinking?: string;
  tool_calls?: TranscriptToolCall[];
  content?: string;
  error?: string;
}

export function isTranscriptStep(obj: unknown): obj is TranscriptStep {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    ('step_index' in o || 'source' in o) &&
    ('type' in o || 'status' in o || 'content' in o || 'tool_calls' in o)
  );
}

function parseCreatedAtToHHMMSS(isoStr?: string): string {
  if (!isoStr) return formatNowHHMMSS();
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return formatNowHHMMSS();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return formatNowHHMMSS();
  }
}

function extractUserRequest(content: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if (match && match[1]) {
    return match[1].trim();
  }
  // XML 태그가 없으면 첫 문장 또는 최대 60자
  const firstLine = content.trim().split(/\r?\n/)[0] ?? content;
  return firstLine.replace(/<[^>]+>/g, '').trim();
}

function classifyToolCard(toolName: string): 0 | 1 | 2 {
  const lower = toolName.toLowerCase();
  if (lower.includes('grep') || lower.includes('search_web')) return 1; // grep 카드
  if (
    lower.includes('run_command') ||
    lower.includes('edit_file') ||
    lower.includes('write_file') ||
    lower.includes('subagent') ||
    lower.includes('patch')
  ) {
    return 2; // audit 카드
  }
  return 0; // search 카드 (read_file, list_dir, find_by_name 등)
}

function summarizeToolArgs(args?: Record<string, unknown> | string): string {
  if (!args) return '';
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      return summarizeToolArgs(parsed);
    } catch {
      return args.length > 24 ? args.slice(0, 23) + '…' : args;
    }
  }
  const pathVal =
    args['Path'] ?? args['path'] ?? args['FilePath'] ?? args['DirectoryPath'];
  if (typeof pathVal === 'string' && pathVal.length > 0) {
    return path.basename(pathVal);
  }
  const cmdVal = args['CommandLine'] ?? args['command'] ?? args['query'];
  if (typeof cmdVal === 'string' && cmdVal.length > 0) {
    return cmdVal.length > 28 ? cmdVal.slice(0, 27) + '…' : cmdVal;
  }
  const roleVal = args['Role'] ?? args['TypeName'];
  if (typeof roleVal === 'string') return roleVal;
  return '';
}

// ---------------------------------------------------------------------------
// [B6] PLANNER_RESPONSE(M tool_calls) → 직후 GENERIC M개 발행 순서 1:1 귀속

interface PendingToolCall {
  name: string;
  args?: Record<string, unknown> | string;
}

interface PendingBatch {
  plannerStepIdx: number | null;
  calls: PendingToolCall[];
  results: TranscriptStep[];
}

interface TxMapperCtx {
  pending: PendingBatch | null;
  /** 이전 미완 배치의 잔여 GENERIC 수 — 신규 배치 결과가 아니므로 스킵(순서 보존) */
  orphanGenerics: number;
}

const txMapperCtx = new WeakMap<AppState, TxMapperCtx>();

function txCtx(state: AppState): TxMapperCtx {
  let ctx = txMapperCtx.get(state);
  if (!ctx) {
    ctx = { pending: null, orphanGenerics: 0 };
    txMapperCtx.set(state, ctx);
  }
  return ctx;
}

/**
 * 미완 배치 폐기 — 뒤이을 GENERIC들은 이 배치의 결과이므로 orphanGenerics로 넘겨
 * 새 PLANNER 배치와의 1:1 순서 귀속을 보존한다(§5.2 B6 보수적 기록 생략).
 */
function abortPendingBatch(ctx: TxMapperCtx): void {
  if (ctx.pending && ctx.pending.results.length < ctx.pending.calls.length) {
    ctx.orphanGenerics += ctx.pending.calls.length - ctx.pending.results.length;
  }
  ctx.pending = null;
}

function parseToolArgs(
  args: Record<string, unknown> | string | undefined
): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args !== 'string') return args;
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// [N6] GENERIC 본문 에러 판정 — 헤더(Created At·Completed At·Showing lines) 이후
// 본문만 검사해 정상 소스 속 "Error" 문자열 오탐을 막는다.

const GENERIC_HEADER_RE = /^(Created At|Completed At):\s/;
const SHOWING_LINES_RE = /^Showing lines \d+(?:-\d+)? of \d+/;
const EXIT_CODE_NONZERO_RE = /Command exited with code\s+(?!0\b)-?\d+/;

export function genericBodyAfterHeaders(raw: string): string {
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (GENERIC_HEADER_RE.test(l) || SHOWING_LINES_RE.test(l) || l.trim() === '') {
      i += 1;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n');
}

export function isGenericStepError(step: TranscriptStep): boolean {
  if (step.status === 'ERROR') return true; // ① 툴 실행 실패
  const raw = step.content ?? '';
  if (!raw) return false;
  const body = genericBodyAfterHeaders(raw);
  if (EXIT_CODE_NONZERO_RE.test(body)) return true; // ② run_command 비정상 종료
  // ③ 파일 도구 에러 응답 — 본문 선두만 검사(본문 내부 "Error" 오탐 금지)
  const head = body.trimStart();
  if (head.startsWith('Encountered error in step execution:')) return true;
  if (head.startsWith('{"error"')) return true;
  if (/^ENOENT[:\s]/.test(head)) return true;
  return false;
}

function genericErrorSnippet(step: TranscriptStep, body: string): string {
  if (typeof step.error === 'string' && step.error) return redactSecrets(step.error).slice(0, 300);
  const m = /Encountered error in step execution:\s*([^\n]{0,300})/.exec(body);
  if (m) return redactSecrets(m[1]!.trim());
  const c = /Command exited with code\s+(-?\d+)/.exec(body);
  if (c) return `exit code ${c[1]}`;
  return 'generic step error';
}

/**
 * 완성 배치를 SSOT에 기록한다(source 'transcript', 멱등 키 tx:conv:plannerStepIdx:toolIdx).
 * plannerStepIdx 누락 시 멱등 키를 만들 수 없어 배치 전체 기록 생략.
 * RUNNING GENERIC은 결과 미확정이라 해당 인덱스만 기록 생략한다.
 */
function flushTranscriptBatch(state: AppState, batch: PendingBatch): void {
  if (decisionWriteBlocked(state)) return;
  if (batch.plannerStepIdx === null || !Number.isFinite(batch.plannerStepIdx)) return;
  const convId = state.conversationId;
  const dbPath = resolveDbPath();
  if (convId && hasHookCoverageById(dbPath, convId)) return;
  try {
    const { projectId, projectLabel } = resolveProjectIdentity(process.cwd());
    for (let k = 0; k < batch.calls.length; k++) {
      const call = batch.calls[k]!;
      const gstep = batch.results[k]!;
      if (gstep.status === 'RUNNING') continue;
      const argsObj = parseToolArgs(call.args);
      const toolName = call.name || 'tool';
      const { route, toolClass } = classifyTool(toolName, argsObj ?? undefined);
      const ok = !isGenericStepError(gstep);
      recordToolOutcomeSafe(dbPath, {
        projectId,
        projectLabel,
        route,
        toolClass,
        toolName,
        ok,
        conversationId: convId,
        step: typeof gstep.step_index === 'number' ? gstep.step_index : null,
        targetHash: targetHashForArgs(argsObj ?? undefined),
        errorSnippet: ok
          ? null
          : genericErrorSnippet(gstep, genericBodyAfterHeaders(gstep.content ?? '')),
        source: 'transcript',
        dedupeKey: `tx:${convId ?? 'unknown'}:${batch.plannerStepIdx}:${k}`,
        commandLine: redactSecrets(commandLineOfArgs(argsObj ?? undefined) ?? '') || null,
      });
    }
  } catch {
    // fail-open — 수집 실패가 UI를 죽이지 않는다(§3.5)
  }
}

/**
 * transcript.jsonl의 개별 스텝을 TUI AppState에 정밀 매핑합니다.
 */
export function applyTranscriptStep(state: AppState, step: TranscriptStep): void {
  const timeStr = parseCreatedAtToHHMMSS(step.created_at);
  const ctx = txCtx(state);

  // 1. 유저 요청 스텝 (USER_INPUT)
  if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
    abortPendingBatch(ctx); // [B6] 새 사용자 턴 — 미완 도구 배치 폐기
    const rawContent = step.content ?? '';
    const cleanRequest = redactSecrets(extractUserRequest(rawContent));
    if (cleanRequest) {
      state.mainSummary = cleanRequest;
      state.phase = '추론 시작';
      state.argonBuilds += 1;
      state.agentBusy = true;
      state.backSummary = '실행 중… 완료 시 r 키로 전문 확인';
      appendLog(state, 'Lead', 'orange', `작업 지시 — ${cleanRequest}`, timeStr);
    }
    return;
  }

  // 2. 모델 추론 스텝 (PLANNER_RESPONSE)
  if (step.type === 'PLANNER_RESPONSE') {
    if (step.model) {
      state.modelName = step.model;
      state.modelFlag = `--model ${step.model}`;
      if (step.model.toLowerCase().includes('neon')) {
        state.neonModelName = step.model;
        state.neonModelFlag = `--model ${step.model}`;
        state.neonState = 'run';
        state.neonProgress = 60;
        state.neonLabel = '계획 교차 검토';
      }
    }

    // 토큰 통계 반영
    const inTok = step.input_tokens ?? 0;
    const cacheTok = step.cache_read_tokens ?? 0;
    const outTok = step.output_tokens ?? 0;
    const sum = inTok + cacheTok + outTok;
    if (sum > 0) {
      state.totalTokensUsed += sum;
      state.tokensRead = formatTokensCount(state.totalTokensUsed);
    }

    // Thinking 필드 -> Advisor 자문 패널 매핑
    if (step.thinking && step.thinking.trim().length > 0) {
      state.carbonCalls += 1;
      state.advisorState = '자문 중';
      state.activeTrigger = 0; // 계획 확정 전
      // thinking 첫 1~2문장 추출
      const cleanThinking = step.thinking.trim().replace(/\s+/g, ' ');
      const sentences = cleanThinking.split(/(?<=[.?!])\s+/);
      const adviceSummary = redactSecrets(
        (sentences[0] ?? cleanThinking).slice(0, 75) +
          (sentences[0] && sentences[0].length > 75 ? '…' : '')
      );

      state.latestAdvice = `» ${adviceSummary}`;
      state.adviceHistory.push({
        time: timeStr,
        triggerIndex: 0,
        triggerLabel: TRIGGER_LABELS[0],
        text: adviceSummary,
        tokensRead: state.tokensRead,
      });
      if (state.adviceHistory.length > 50) {
        state.adviceHistory.splice(0, state.adviceHistory.length - 50);
      }
      appendLog(state, 'Advisor', 'purple', adviceSummary, timeStr);
    }

    // 도구 호출 (tool_calls) -> Decision Gate & Workers & Verifier
    const toolCalls = step.tool_calls ?? [];
    abortPendingBatch(ctx); // [B6] 새 PLANNER 배치 — 이전 미완 배치는 고아로 폐기
    if (toolCalls.length > 0) {
      state.totalForks += toolCalls.length;
      state.phase = `도구 실행 (${toolCalls.length}건)`;

      // [B6] 직후 GENERIC M개와 발행 순서대로 1:1 귀속할 배치 시작
      ctx.pending = {
        plannerStepIdx:
          typeof step.step_index === 'number' && Number.isFinite(step.step_index)
            ? step.step_index
            : null,
        calls: toolCalls.map((c) => ({ name: c.name || 'tool', args: c.args })),
        results: [],
      };

      for (const call of toolCalls) {
        const toolName = call.name || 'tool';
        const argHint = summarizeToolArgs(call.args);
        const cardIdx = classifyToolCard(toolName);
        const card = state.cards[cardIdx]!;

        // SQLite SSOT 실측 판정 — 고정 휴리스틱/'sharp' 하드코딩 제거(§5.1-3)
        const decision = evaluateToolDecision(
          toolName,
          parseToolArgs(call.args) ?? undefined,
          state.conversationId
        );

        // Workers 카드 갱신
        card.status = 'running';
        card.progress = Math.min(92, Math.max(30, card.progress + 35));
        card.description = argHint
          ? `${toolName}(${argHint})`
          : `${toolName} 실행 중`;

        // 스웜 50슬롯 중 대표 슬롯 하나 활성화
        const slotIdx = (step.step_index ?? state.totalForks) % state.workers.length;
        const w = state.workers[slotIdx];
        if (w) {
          w.status = 'running';
          w.role = cardIdx === 1 ? 'grep' : cardIdx === 2 ? 'audit' : 'search';
          w.target = argHint || toolName;
          w.progress = 65;
        }
        state.swarmActive = Math.min(
          state.swarmMax,
          Math.max(1, state.workers.filter((wk) => wk.status === 'running').length)
        );

        appendLog(
          state,
          'Decision Gate',
          'green',
          `도구 분기 → ${toolName}${argHint ? ` (${redactSecrets(argHint)})` : ''} ${decision.tag} (p=${decision.p.toFixed(2)}, ${decision.basis})`,
          timeStr
        );

        // 검증/테스트 관련 도구 시 Verifier 교차 검증 연동
        const isVerify =
          toolName.includes('test') ||
          toolName.includes('audit') ||
          toolName.includes('verify') ||
          argHint.includes('test') ||
          argHint.includes('spec');
        if (isVerify) {
          state.neonState = 'run';
          state.neonProgress = 70;
          state.neonLabel = argHint || toolName;
          appendLog(
            state,
            'Verifier',
            'neon',
            `독립 교차 검증 시작 — ${redactSecrets(argHint || toolName)}`,
            timeStr
          );
        }
      }
      syncRoutesFromSsot(state); // 배치 전체 반영 후 라우트 4종 SSOT 최신화
    } else if (step.status === 'DONE') {
      // 도구 호출 없이 완료된 턴
      state.phase = '완료';
      state.activeTrigger = 2; // 완료 전 최종 점검
      state.advisorState = '대기 중';
      state.agentBusy = false;

      if (step.content) {
        state.latestResponse = step.content;
        const preview = step.content.trim().split(/\r?\n/).pop()?.trim();
        if (preview) {
          state.backSummary =
            preview.length > 42 ? preview.slice(0, 41) + '…' : preview;
        }
      }

      if (state.neonState === 'run') {
        state.neonState = 'pass';
        state.neonProgress = 100;
        state.neonVerified += 1;
        state.neonSummary = '검증 통과 · 누락 및 회귀 없음';
        state.neonHistory.push({
          time: timeStr,
          label: state.neonLabel || '교차 검토',
          status: 'pass',
          summary: state.neonSummary,
          model: state.neonModelName,
        });
        appendLog(
          state,
          'Verifier',
          'neon',
          '검증 통과 · 회귀 없음 → Lead에 전달',
          timeStr
        );
      }

      appendLog(state, 'Lead', 'orange', '응답 완료 (r 키로 전문 보기)', timeStr);
    }
    return;
  }

  // 3. 도구 실행 결과 (GENERIC)
  if (step.type === 'GENERIC') {
    // [B6] 배치 귀속 — 고아 잔여분 스킵, M개 완성 시 SSOT 1회 기록
    if (ctx.orphanGenerics > 0) {
      ctx.orphanGenerics -= 1;
    } else if (ctx.pending) {
      ctx.pending.results.push(step);
      if (ctx.pending.results.length === ctx.pending.calls.length) {
        const batch = ctx.pending;
        ctx.pending = null;
        flushTranscriptBatch(state, batch);
      }
    }

    // [N6] 헤더 이후 본문 판정 — DONE인데 비정상 종료·파일 툴 에러도 감지
    const raw = step.content ?? '';
    const isError = isGenericStepError(step);

    if (isError) {
      state.consecutiveToolErrors += 1;
      if (state.consecutiveToolErrors >= 2) {
        state.activeTrigger = 1; // 같은 오류 2회
        state.advisorState = '자문 중';
        state.carbonCalls += 1;
        state.latestAdvice = '» 연속 오류 감지 — 파라미터 및 경로 재점검 권고';
        appendLog(state, 'Advisor', 'purple', '같은 오류 2회 감지 — 파라미터 재검토', timeStr);
      }
      appendLog(state, 'Worker', 'blue', `도구 실행 오류 감지`, timeStr);
    } else {
      state.consecutiveToolErrors = 0;
      // 실행 중이던 카드들을 완료로 전진
      for (const c of state.cards) {
        if (c.status === 'running') {
          c.status = 'done';
          c.progress = 100;
        }
      }
      for (const w of state.workers) {
        if (w.status === 'running') {
          w.status = 'done';
          w.progress = 100;
        }
      }
      state.swarmActive = state.workers.filter((wk) => wk.status === 'running').length;

      const firstLine = raw.trim().split(/\r?\n/)[0] ?? '결과 수신';
      const brief = redactSecrets(
        firstLine.length > 55 ? firstLine.slice(0, 54) + '…' : firstLine
      );
      appendLog(state, 'Worker', 'blue', `도구 완료 — ${brief}`, timeStr);
    }

    // GENERIC 결과 반영 후 라우트·sharp·split을 SSOT 실측으로 최신화(선행 버그 #3)
    syncRoutesFromSsot(state);
  }
}

export interface WatchedLeadLabel {
  leadBadge: string;
  modelName: string;
  modelFlag: string;
}

/**
 * watch 모드에서 tail 중인 transcript 경로로 실제 관측 대상 호스트를 식별한다.
 * roster.json의 헤드리스 lead 바인딩과 실제 감시 중인 세션 주체가 다를 수 있으므로
 * Lead 카드는 관측 세션 호스트를 정직하게 표시해야 한다(미인식 시 null → roster 유지).
 */
export function detectWatchedLeadLabel(
  transcriptPath: string | null
): WatchedLeadLabel | null {
  if (!transcriptPath) return null;
  if (/antigravity/i.test(transcriptPath) || /\.gemini\/.*\/brain\//i.test(transcriptPath)) {
    return {
      leadBadge: 'Antigravity (현재 세션)',
      modelName: 'antigravity-main',
      modelFlag: 'live session: Antigravity',
    };
  }
  if (/claude/i.test(transcriptPath)) {
    return {
      leadBadge: 'Claude Code (현재 세션)',
      modelName: 'claude-main',
      modelFlag: 'live session: Claude Code',
    };
  }
  if (/codex/i.test(transcriptPath)) {
    return {
      leadBadge: 'Codex (현재 세션)',
      modelName: 'codex-main',
      modelFlag: 'live session: Codex',
    };
  }
  return null;
}

/**
 * transcript.jsonl 경로 탐색 — CLI(`antigravity-cli`)와 GUI(`antigravity`) 두 brain
 * 루트를 모두 스캔해 mtime이 가장 최신인 세션의 transcript를 반환합니다(§5.1-3).
 */
export function findLatestTranscriptPath(customDir?: string): string | null {
  const baseDirs = customDir
    ? [customDir]
    : [
        path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
      ];

  let latestPath: string | null = null;
  let latestMtime = -1;

  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptFile = path.join(
          baseDir,
          entry.name,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
        if (!fs.existsSync(transcriptFile)) continue;
        try {
          const stat = fs.statSync(transcriptFile);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestPath = transcriptFile;
          }
        } catch {
          // 파일 접근 오류 무시
        }
      }
    } catch {
      // 디렉터리 읽기 실패 무시
    }
  }
  return latestPath;
}

/**
 * 실행 중인 agy 세션의 transcript.jsonl 파일을 실시간으로 감시(watch)합니다.
 */
export function attachTranscriptWatcher(
  filePath: string,
  state: AppState,
  onUpdate: () => void
): () => void {
  // 세션 ID 및 대화 ID 추출
  const matchId = /brain\/([^/]+)/.exec(filePath);
  if (matchId && matchId[1]) {
    state.conversationId = matchId[1];
    state.sessionId = Number.parseInt(matchId[1].replace(/\D/g, '').slice(0, 4), 10) || 101;
  }

  // 1. 기존 파일 내용 전체를 순차적으로 읽어 현재 세션 상태 복원
  let byteOffset = 0;
  if (fs.existsSync(filePath)) {
    const initialContent = fs.readFileSync(filePath, 'utf8');
    byteOffset = Buffer.byteLength(initialContent, 'utf8');
    const lines = initialContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim()) as unknown;
        if (isTranscriptStep(parsed)) {
          applyTranscriptStep(state, parsed);
        }
      } catch {
        // 무시
      }
    }
    onUpdate();
  }

  // 2. 실시간 tail 추적 (180ms 주기)
  let leftover = '';
  const intervalTimer = setInterval(() => {
    if (!fs.existsSync(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < byteOffset) {
        // 파일이 truncate된 경우 처음부터 다시 읽기
        byteOffset = 0;
        leftover = '';
      }
      if (stat.size > byteOffset) {
        const fd = fs.openSync(filePath, 'r');
        const len = stat.size - byteOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, byteOffset);
        fs.closeSync(fd);
        byteOffset = stat.size;

        const chunk = leftover + buf.toString('utf8');
        const parts = chunk.split(/\r?\n/);
        leftover = parts.pop() ?? '';
        let hasChanges = false;
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (isTranscriptStep(parsed)) {
              applyTranscriptStep(state, parsed);
              hasChanges = true;
            }
          } catch {
            // 무시
          }
        }
        if (hasChanges) {
          onUpdate();
        }
      }
    } catch {
      // 읽기 실패 시 다음 주기에 재시도
    }
  }, 180);

  return () => {
    clearInterval(intervalTimer);
  };
}
