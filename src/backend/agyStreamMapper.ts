import * as path from 'node:path';
import {
  appendLog,
  formatCompactPath,
  formatNowHHMMSS,
  formatTokensCount,
} from '../state/store.ts';
import type { AppState } from '../types.ts';

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

function updateDecisionRoutes(state: AppState, toolName: string, hadError: boolean): void {
  state.totalForks += 1;
  const isSearch = toolName.includes('grep') || toolName.includes('find') || toolName.includes('list');
  const pFile = toolName.includes('file') || toolName.includes('dir') ? 0.94 : 0.85;
  const pTool = isSearch ? 0.92 : toolName === 'run_command' ? 0.74 : 0.88;
  const pRetry = hadError ? 0.48 : 0.91;

  state.routes = [
    { name: '어느 파일', p: pFile },
    { name: '어느 도구', p: pTool },
    { name: '재시도 또는 중단', p: pRetry },
  ];
  state.sharpCount = state.routes.filter((r) => r.p >= 0.7).length;
  state.splitCount = state.routes.length - state.sharpCount;
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

      if (u.state === 'ACTIVE') {
        state.phase = `도구: ${toolName}`;
        updateDecisionRoutes(state, toolName, false);
        card.status = 'running';
        card.progress = Math.min(85, Math.max(25, card.progress + 35));
        card.description = hint ? `${toolName}(${hint})` : `${toolName} 실행 중`;

        const role = cardIdx === 1 ? 'grep' : cardIdx === 2 ? 'audit' : 'search';
        updateSwarmWorkerSlot(state, stepSlot, role, hint || toolName, false);
        syncSwarmCount(state);

        appendLog(
          state,
          `Decision 1`,
          'green',
          `도구 분기 → ${toolName}${hint ? ` (${hint})` : ''}  sharp`
        );
      } else if (u.state === 'DONE') {
        const errText = u.tool_info?.error;
        const hadError = Boolean(errText);
        if (hadError) {
          state.consecutiveToolErrors += 1;
          updateDecisionRoutes(state, toolName, true);
          card.status = 'error';
          if (state.consecutiveToolErrors >= 2) {
            state.activeTrigger = 1;
            state.advisorState = '자문 중';
            state.carbonCalls += 1;
            state.latestAdvice = `» ${toolName} 연속 오류 감지 — 파라미터/경로 재검토 필요`;
            appendLog(state, 'Carbon', 'purple', `같은 오류 2회 감지 — ${toolName}`);
          }
        } else {
          state.consecutiveToolErrors = 0;
          card.status = 'done';
          card.progress = 100;
        }

        const role = cardIdx === 1 ? 'grep' : cardIdx === 2 ? 'audit' : 'search';
        updateSwarmWorkerSlot(state, stepSlot, role, hint || toolName, true);
        syncSwarmCount(state);

        const dur =
          u.duration_seconds !== undefined ? ` (${u.duration_seconds.toFixed(2)}s)` : '';
        const out = u.tool_info?.output ? ` · ${u.tool_info.output}` : '';
        appendLog(
          state,
          `Hydrogen ${role}`,
          'blue',
          `${toolName}${hint ? ` [${hint}]` : ''} 완료${dur}${out}`
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
      const errMsg = r.error ?? '실행 오류';
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
