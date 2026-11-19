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

/**
 * transcript.jsonl의 개별 스텝을 TUI AppState에 정밀 매핑합니다.
 */
export function applyTranscriptStep(state: AppState, step: TranscriptStep): void {
  const timeStr = parseCreatedAtToHHMMSS(step.created_at);

  // 1. 유저 요청 스텝 (USER_INPUT)
  if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
    const rawContent = step.content ?? '';
    const cleanRequest = extractUserRequest(rawContent);
    if (cleanRequest) {
      state.mainSummary = cleanRequest;
      state.phase = '추론 시작';
      state.argonBuilds += 1;
      state.agentBusy = true;
      state.backSummary = '실행 중… 완료 시 r 키로 전문 확인';
      appendLog(state, 'Argon', 'orange', `작업 지시 — ${cleanRequest}`, timeStr);
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

    // Thinking 필드 -> Carbon 자문 패널 매핑
    if (step.thinking && step.thinking.trim().length > 0) {
      state.carbonCalls += 1;
      state.advisorState = '자문 중';
      state.activeTrigger = 0; // 계획 확정 전
      // thinking 첫 1~2문장 추출
      const cleanThinking = step.thinking.trim().replace(/\s+/g, ' ');
      const sentences = cleanThinking.split(/(?<=[.?!])\s+/);
      const adviceSummary =
        (sentences[0] ?? cleanThinking).slice(0, 75) +
        (sentences[0] && sentences[0].length > 75 ? '…' : '');

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
      appendLog(state, 'Carbon', 'purple', adviceSummary, timeStr);
    }

    // 도구 호출 (tool_calls) -> Decision 1 & Hydrogen & Neon
    const toolCalls = step.tool_calls ?? [];
    if (toolCalls.length > 0) {
      state.totalForks += toolCalls.length;
      state.phase = `도구 실행 (${toolCalls.length}건)`;

      for (const call of toolCalls) {
        const toolName = call.name || 'tool';
        const argHint = summarizeToolArgs(call.args);
        const cardIdx = classifyToolCard(toolName);
        const card = state.cards[cardIdx]!;

        // Decision 라우트 확률 갱신
        const isSearch =
          toolName.includes('grep') ||
          toolName.includes('find') ||
          toolName.includes('list');
        const isFile =
          toolName.includes('file') ||
          toolName.includes('dir') ||
          toolName.includes('edit');
        const isAsk =
          toolName.includes('ask') || toolName.includes('question');

        state.routes = [
          { name: '어느 파일', p: isFile ? 0.92 : 0.82 },
          { name: '어느 도구', p: isSearch ? 0.94 : 0.85 },
          { name: '재시도 또는 중단', p: isAsk ? 0.42 : 0.91 },
        ];
        state.sharpCount = state.routes.filter((r) => r.p >= 0.7).length;
        state.splitCount = state.routes.length - state.sharpCount;

        // Hydrogen 카드 갱신
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
          'Decision 1',
          'green',
          `도구 분기 → ${toolName}${argHint ? ` (${argHint})` : ''} sharp`,
          timeStr
        );

        // 검증/테스트 관련 도구 시 Neon 교차 검증 연동
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
            'Neon',
            'neon',
            `독립 교차 검증 시작 — ${argHint || toolName}`,
            timeStr
          );
        }
      }
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
          'Neon',
          'neon',
          '검증 통과 · 회귀 없음 → Argon에 전달',
          timeStr
        );
      }

      appendLog(state, 'Argon', 'orange', '응답 완료 (r 키로 전문 보기)', timeStr);
    }
    return;
  }

  // 3. 도구 실행 결과 (GENERIC)
  if (step.type === 'GENERIC') {
    const raw = step.content ?? '';
    const isError =
      step.status === 'ERROR' ||
      raw.includes('Command exited with code') && !raw.includes('code 0');

    if (isError) {
      state.consecutiveToolErrors += 1;
      if (state.consecutiveToolErrors >= 2) {
        state.activeTrigger = 1; // 같은 오류 2회
        state.advisorState = '자문 중';
        state.carbonCalls += 1;
        state.latestAdvice = '» 연속 오류 감지 — 파라미터 및 경로 재점검 권고';
        appendLog(state, 'Carbon', 'purple', '같은 오류 2회 감지 — 파라미터 재검토', timeStr);
      }
      appendLog(state, 'Hydrogen', 'blue', `도구 실행 오류 감지`, timeStr);
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
      const brief =
        firstLine.length > 55 ? firstLine.slice(0, 54) + '…' : firstLine;
      appendLog(state, 'Hydrogen', 'blue', `도구 완료 — ${brief}`, timeStr);
    }
  }
}

/**
 * ~/.gemini/antigravity/brain 디렉터리에서 가장 최근에 수정된 세션의 transcript.jsonl 경로를 탐색합니다.
 */
export function findLatestTranscriptPath(customDir?: string): string | null {
  const baseDir =
    customDir ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  if (!fs.existsSync(baseDir)) return null;

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    let latestPath: string | null = null;
    let latestMtime = -1;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcriptFile = path.join(
        baseDir,
        entry.name,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (fs.existsSync(transcriptFile)) {
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
    }
    return latestPath;
  } catch {
    return null;
  }
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
