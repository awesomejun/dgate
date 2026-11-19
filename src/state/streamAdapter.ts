import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { applyAgyEvent, isAgyRawEvent } from '../backend/agyStreamMapper.ts';
import {
  applyTranscriptStep,
  isTranscriptStep,
} from '../backend/transcriptMapper.ts';
import type { AgentColorKey } from '../theme.ts';
import type { AppState, StreamEvent } from '../types.ts';
import { TRIGGER_LABELS, appendLog, createInitialState, formatNowHHMMSS } from './store.ts';

function inferAgentColor(agent: string, explicit?: AgentColorKey): AgentColorKey {
  if (explicit) return explicit;
  const lower = agent.toLowerCase();
  if (lower.includes('argon')) return 'orange';
  if (lower.includes('hydrogen')) return 'blue';
  if (lower.includes('decision')) return 'green';
  if (lower.includes('neon')) return 'neon';
  if (lower.includes('carbon')) return 'purple';
  return 'fg';
}

/**
 * 단일 JSONL 이벤트 객체를 AppState에 반영하는 리듀서
 */
export function applyStreamEvent(state: AppState, ev: StreamEvent): void {
  switch (ev.type) {
    case 'reset': {
      const fresh = createInitialState('stream');
      Object.assign(state, fresh);
      return;
    }
    case 'session': {
      if (ev.sessionId !== undefined) state.sessionId = ev.sessionId;
      if (ev.cwd !== undefined) state.cwd = ev.cwd;
      if (ev.model !== undefined) {
        state.modelFlag = ev.model.startsWith('--') ? ev.model : `--model ${ev.model}`;
      }
      if (ev.effort !== undefined) state.effort = ev.effort;
      return;
    }
    case 'phase': {
      state.phase = ev.phase;
      if (ev.summary !== undefined) state.mainSummary = ev.summary;
      if (ev.backSummary !== undefined) state.backSummary = ev.backSummary;
      if (ev.argonBuilds !== undefined) state.argonBuilds = ev.argonBuilds;
      return;
    }
    case 'decision': {
      if (ev.forks !== undefined) state.totalForks = ev.forks;
      else state.totalForks += 1;

      let sharp = 0;
      let split = 0;
      state.routes = ev.routes.map((r) => {
        const clamped = Math.max(0, Math.min(1, r.p));
        if (clamped >= 0.7) sharp++;
        else split++;
        return { name: r.name, p: clamped, targetHint: r.targetHint };
      });
      state.sharpCount = sharp;
      state.splitCount = split;
      return;
    }
    case 'swarm': {
      if (ev.max !== undefined) state.swarmMax = ev.max;
      if (ev.active !== undefined) state.swarmActive = ev.active;
      if (ev.cards && ev.cards.length > 0) {
        state.cards = ev.cards.map((c) => ({
          name: c.name,
          model: c.model ?? 'Hydrogen',
          progress: Math.max(0, Math.min(100, Math.round(c.progress))),
          description: c.description ?? '',
          status: c.status ?? (c.progress >= 100 ? 'done' : 'running'),
        }));
      }
      // 개별 슬롯 상태 동기화
      for (let i = 0; i < state.workers.length; i++) {
        const w = state.workers[i]!;
        if (i < state.swarmActive) {
          w.status = 'running';
          w.progress = Math.min(99, ((w.progress + 17) % 95) + 5);
        } else {
          w.status = i < state.swarmActive + 5 ? 'done' : 'idle';
          w.progress = w.status === 'done' ? 100 : 0;
        }
      }
      return;
    }
    case 'advisor': {
      state.activeTrigger = ev.trigger;
      state.advisorState = ev.state ?? (ev.trigger < 0 ? '대기 중' : '자문 중');
      if (ev.calls !== undefined) state.carbonCalls = ev.calls;
      else if (ev.trigger >= 0) state.carbonCalls += 1;
      if (ev.tokens !== undefined) state.tokensRead = ev.tokens;
      if (ev.advice !== undefined) {
        state.latestAdvice = ev.advice.startsWith('»') ? ev.advice : `» ${ev.advice}`;
        const tIdx: 0 | 1 | 2 = ev.trigger === -1 ? 0 : ev.trigger;
        state.adviceHistory.push({
          time: formatNowHHMMSS(),
          triggerIndex: tIdx,
          triggerLabel: TRIGGER_LABELS[tIdx],
          text: ev.advice.replace(/^»\s*/, ''),
          tokensRead: state.tokensRead,
        });
      }
      return;
    }
    case 'neon': {
      const prevState = state.neonState;
      state.neonState = ev.state;
      if (ev.model !== undefined) {
        state.neonModelName = ev.model.replace(/^--model\s+/, '');
        state.neonModelFlag = ev.model.startsWith('--') ? ev.model : `--model ${ev.model}`;
      }
      if (ev.label !== undefined) {
        state.neonLabel = ev.label;
      }
      if (ev.progress !== undefined) {
        state.neonProgress = Math.max(0, Math.min(100, Math.round(ev.progress)));
      } else if (ev.state === 'pass') {
        state.neonProgress = 100;
      } else if (ev.state === 'idle') {
        state.neonProgress = 0;
      }
      if (ev.verified !== undefined) {
        state.neonVerified = ev.verified;
      } else if (ev.state === 'pass' && prevState !== 'pass') {
        state.neonVerified += 1;
      }
      if (ev.summary !== undefined) {
        state.neonSummary = ev.summary;
      }
      if (ev.state === 'pass' || ev.state === 'fail') {
        state.neonHistory.push({
          time: formatNowHHMMSS(),
          label: ev.label ?? (state.neonLabel || '교차 검증'),
          status: ev.state,
          summary:
            ev.summary ??
            (ev.state === 'pass' ? '검증 통과 · 회귀 및 누락 없음' : '검증 실패 · 재확인 필요'),
          model: state.neonModelName,
        });
        if (state.neonHistory.length > 50) {
          state.neonHistory.splice(0, state.neonHistory.length - 50);
        }
      }
      return;
    }
    case 'log': {
      appendLog(
        state,
        ev.agent,
        inferAgentColor(ev.agent, ev.color),
        ev.message,
        ev.time ?? formatNowHHMMSS()
      );
      return;
    }
  }
}

export function parseJsonLine(line: string, state: AppState): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
  try {
    const parsed = JSON.parse(trimmed) as StreamEvent | unknown;
    if (isAgyRawEvent(parsed)) {
      applyAgyEvent(state, parsed);
      return true;
    }
    if (isTranscriptStep(parsed)) {
      applyTranscriptStep(state, parsed);
      return true;
    }
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      applyStreamEvent(state, parsed as StreamEvent);
      return true;
    }
  } catch {
    // 일반 텍스트 라인이 파이프로 들어온 경우 세션 로그로 안전하게 수용
    appendLog(state, 'Stream', 'muted', trimmed);
    return true;
  }
  return false;
}

/**
 * 표준 입력(stdin)에서 JSONL 스트림을 실시간으로 구독합니다.
 */
export function attachStdinStream(state: AppState, onUpdate: () => void): void {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on('line', (line) => {
    if (parseJsonLine(line, state)) {
      onUpdate();
    }
  });
}

/**
 * 로컬 JSONL 파일을 읽고, --follow 시 파일에 추가되는 새 라인도 실시간 감지합니다.
 */
export function attachFileStream(
  filePath: string,
  state: AppState,
  follow: boolean,
  replayDelayMs: number,
  onUpdate: () => void
): () => void {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const initialLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let byteOffset = Buffer.byteLength(content, 'utf8');
  let timer: ReturnType<typeof setInterval> | null = null;
  let replayTimer: ReturnType<typeof setTimeout> | null = null;

  if (replayDelayMs > 0 && initialLines.length > 0) {
    let idx = 0;
    const step = () => {
      if (idx >= initialLines.length) return;
      parseJsonLine(initialLines[idx]!, state);
      idx++;
      onUpdate();
      if (idx < initialLines.length) {
        replayTimer = setTimeout(step, replayDelayMs);
      }
    };
    step();
  } else {
    for (const line of initialLines) {
      parseJsonLine(line, state);
    }
    onUpdate();
  }

  if (follow) {
    let leftover = '';
    timer = setInterval(() => {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.size < byteOffset) {
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
        let changed = false;
        for (const p of parts) {
          if (parseJsonLine(p, state)) changed = true;
        }
        if (changed) onUpdate();
      }
    }, 180);
  }

  return () => {
    if (timer) clearInterval(timer);
    if (replayTimer) clearTimeout(replayTimer);
  };
}
