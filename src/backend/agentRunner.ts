import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  TRIGGER_LABELS,
  appendLog,
  flashStatus,
  formatNowHHMMSS,
  formatTokensCount,
} from '../state/store.ts';
import { parseJsonLine } from '../state/streamAdapter.ts';
import { resolveDbPath, resolveProjectIdentity } from '../decision/db.ts';
import { classifyTool } from '../decision/engine.ts';
import { recordToolOutcomeSafe } from '../decision/telemetry.ts';
import { buildSanitizedChildEnv, redactSecrets } from '../decision/redact.ts';
import {
  commandLineOfArgs,
  decisionWriteBlocked,
  syncRoutesFromSsot,
  targetHashForArgs,
} from './agyStreamMapper.ts';
import type { AppState, BackendKind, EffortLevel } from '../types.ts';

export type BackendPreference = 'auto' | 'agy' | 'api';

/** Gemini REST 호출 타임아웃 — `GEMINI_REST_TIMEOUT_MS`로 오버라이드 가능 */
function restTimeoutMs(): number {
  return Number(process.env.GEMINI_REST_TIMEOUT_MS) || 60_000;
}

/** agy 자식 프로세스 무출력 스톨 한계 — `HERDR_AGY_STALL_MS`로 오버라이드 가능 */
function agyStallMs(): number {
  return Number(process.env.HERDR_AGY_STALL_MS) || 180_000;
}

export interface RunnerOptions {
  preference: BackendPreference;
  autoApprove: boolean;
}

export function detectBackend(preference: BackendPreference): BackendKind {
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const agyCheck = spawnSync('which', ['agy'], { encoding: 'utf8' });
  const hasAgy = agyCheck.status === 0 && (agyCheck.stdout?.trim().length ?? 0) > 0;

  if (preference === 'agy') return hasAgy ? 'agy' : 'none';
  if (preference === 'api') return hasApiKey ? 'gemini-api' : 'none';
  if (hasAgy) return 'agy';
  if (hasApiKey) return 'gemini-api';
  return 'none';
}

const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/;

export function inferEffortFromModel(modelName: string): EffortLevel | null {
  const m = EFFORT_SUFFIX_RE.exec(modelName);
  if (!m) return null;
  const tag = m[1];
  if (tag === 'low' || tag === 'medium' || tag === 'high' || tag === 'max') return tag;
  if (tag === 'xhigh') return 'max';
  return null;
}

export function applyEffortToModelName(modelName: string, effort: EffortLevel): string {
  if (EFFORT_SUFFIX_RE.test(modelName)) {
    const supportsXhigh = modelName.includes('neon') || modelName.includes('hydrogen');
    const mapped = effort === 'max' ? (supportsXhigh ? 'xhigh' : 'high') : effort;
    return modelName.replace(EFFORT_SUFFIX_RE, `-${mapped}`);
  }
  return modelName;
}

function mapEffortForAgy(effort: EffortLevel): string {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      return 'max';
  }
}

function mapModelForGeminiApi(modelName: string): string {
  if (modelName.startsWith('gemini-2.') || modelName.startsWith('gemini-1.')) {
    return modelName;
  }
  return 'gemini-2.5-flash';
}

// Gemini REST API Function Calling용 경량 로컬 읽기 도구
function executeLocalReadOnlyTool(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const root = process.cwd();
  try {
    if (name === 'list_dir') {
      const rel = typeof args['path'] === 'string' ? args['path'] : '.';
      const target = path.resolve(root, rel);
      if (!target.startsWith(root)) return { error: '워크스페이스 외부 접근 제한' };
      const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 60);
      return {
        entries: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
      };
    }
    if (name === 'read_file') {
      const rel = typeof args['path'] === 'string' ? args['path'] : '';
      const target = path.resolve(root, rel);
      if (!target.startsWith(root)) return { error: '워크스페이스 외부 접근 제한' };
      const content = fs.readFileSync(target, 'utf8');
      return {
        content: content.slice(0, 8000),
        truncated: content.length > 8000,
      };
    }
    if (name === 'grep_search') {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      if (!query) return { matches: [] };
      const res = spawnSync('grep', ['-rn', '--exclude-dir=.git', '--exclude-dir=node_modules', query, '.'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
      });
      const lines = (res.stdout ?? '').split('\n').filter(Boolean).slice(0, 25);
      return { matches: lines };
    }
    return { error: `알 수 없는 도구: ${name}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export class AgentRunner {
  backend: BackendKind;
  autoApprove: boolean;
  activeChild: ChildProcess | null = null;
  abortController: AbortController | null = null;
  advisorChild: ChildProcess | null = null;
  neonChild: ChildProcess | null = null;
  neonAbortController: AbortController | null = null;

  constructor(opts: RunnerOptions) {
    this.backend = detectBackend(opts.preference);
    this.autoApprove = opts.autoApprove;
  }

  cancel(state: AppState, onUpdate: () => void): boolean {
    let canceled = false;
    if (this.activeChild) {
      this.activeChild.kill('SIGTERM');
      this.activeChild = null;
      canceled = true;
    }
    if (this.advisorChild) {
      this.advisorChild.kill('SIGTERM');
      this.advisorChild = null;
      canceled = true;
    }
    if (this.neonChild) {
      this.neonChild.kill('SIGTERM');
      this.neonChild = null;
      canceled = true;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      canceled = true;
    }
    if (this.neonAbortController) {
      this.neonAbortController.abort();
      this.neonAbortController = null;
      canceled = true;
    }
    if (canceled) {
      state.agentBusy = false;
      state.phase = '중단됨';
      state.advisorState = '대기 중';
      if (state.neonState === 'run') {
        state.neonState = 'idle';
        state.neonProgress = 0;
        state.neonSummary = '교차 검증이 중단되었습니다';
      }
      appendLog(state, 'Lead', 'orange', '사용자에 의해 현재 실행이 중단되었습니다');
      flashStatus(state, '실행 중단됨');
      onUpdate();
    }
    return canceled;
  }

  async runPrompt(prompt: string, state: AppState, onUpdate: () => void): Promise<void> {
    if (this.backend === 'none') {
      flashStatus(state, '사용 가능한 백엔드(agy 또는 GEMINI_API_KEY)가 없습니다', 4000);
      appendLog(
        state,
        'Advisor',
        'purple',
        '백엔드 미연결: agy 로그인 또는 GEMINI_API_KEY 환경변수가 필요합니다'
      );
      onUpdate();
      return;
    }

    if (state.agentBusy) {
      flashStatus(state, '이전 에이전트 작업이 진행 중입니다 (/cancel 로 중단 가능)');
      return;
    }

    state.agentBusy = true;
    state.argonBuilds += 1;
    state.mainSummary = prompt;
    state.latestResponse = '';
    state.responseScrollOffset = 0;
    state.consecutiveToolErrors = 0;
    state.phase = '계획 수립';
    state.backSummary = '실행 중… 완료 시 r 키로 응답 전문 확인';
    for (const c of state.cards) {
      c.progress = 0;
      c.status = 'idle';
    }

    appendLog(state, 'Lead', 'orange', `작업 지시 — ${redactSecrets(prompt)}`);
    onUpdate();

    if (this.backend === 'agy') {
      this.runWithAgy(prompt, state, onUpdate);
    } else {
      await this.runWithGeminiApi(prompt, state, onUpdate);
    }
  }

  private runWithAgy(prompt: string, state: AppState, onUpdate: () => void): void {
    const args: string[] = [
      '--output-format',
      'stream-json',
      '--model',
      state.modelName,
    ];
    // 모델명에 이미 -low/-medium/-high/-xhigh 접미사가 있으면 --effort 플래그와 충돌하므로 생략
    if (!EFFORT_SUFFIX_RE.test(state.modelName)) {
      args.push('--effort', mapEffortForAgy(state.effort));
    }
    if (state.conversationId) {
      args.push('--conversation', state.conversationId);
    }
    if (this.autoApprove) {
      args.push('--dangerously-skip-permissions');
    }
    args.push(`--print=${prompt}`);

    const child = spawn('agy', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSanitizedChildEnv({ allowKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }),
    });
    this.activeChild = child;

    // 무출력 스톨 타이머 — stdout/stderr 청크마다 리셋, 초과 시 SIGTERM → 5s 후 SIGKILL
    const stallMs = agyStallMs();
    let stallTimer: NodeJS.Timeout | null = null;
    let stallKillTimer: NodeJS.Timeout | null = null;
    let stalled = false;
    const clearStallTimers = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (stallKillTimer) {
        clearTimeout(stallKillTimer);
        stallKillTimer = null;
      }
    };
    const armStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        appendLog(
          state,
          'Advisor',
          'purple',
          `agy 무출력 스톨 감지 — ${Math.round(stallMs / 1000)}s 무응답, 강제 종료(stall)`
        );
        onUpdate();
        try {
          child.kill('SIGTERM');
        } catch {
          /* 무시 */
        }
        stallKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 무시 */
          }
        }, 5_000);
      }, stallMs);
    };
    armStallTimer();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      armStallTimer();
      if (parseJsonLine(line, state)) {
        onUpdate();
      }
    });

    const errRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    errRl.on('line', (line) => {
      armStallTimer();
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('warning:')) return;
      appendLog(state, 'Lead', 'orange', redactSecrets(trimmed));
      onUpdate();
    });

    child.on('error', (err) => {
      clearStallTimers();
      if (this.activeChild === child) this.activeChild = null;
      state.agentBusy = false;
      state.phase = '오류';
      appendLog(state, 'Advisor', 'purple', `agy 실행 실패: ${redactSecrets(err.message)}`);
      flashStatus(state, `실행 오류: ${redactSecrets(err.message)}`);
      onUpdate();
    });

    child.on('close', (code) => {
      clearStallTimers();
      if (this.activeChild === child) this.activeChild = null;
      state.agentBusy = false;
      if (stalled) {
        state.phase = '오류';
        state.activeTrigger = 1;
        state.advisorState = '자문 중';
        appendLog(state, 'Advisor', 'purple', 'agy 무응답 스톨(stall) — 프로세스 강제 종료됨');
      } else if (code !== 0 && state.phase !== '완료' && state.phase !== '중단됨') {
        state.phase = '오류';
        state.activeTrigger = 1;
        state.advisorState = '자문 중';
        appendLog(state, 'Advisor', 'purple', `프로세스 종료 코드 ${code}`);
      }
      onUpdate();
    });
  }

  /**
   * Advisor(자문 모델)에게 현재 상태/질문에 대한 별도 자문을 요청합니다.
   */
  askCarbonAdvisor(question: string, state: AppState, onUpdate: () => void): void {
    if (this.backend !== 'agy') {
      flashStatus(state, 'Advisor 직접 호출은 agy 백엔드에서 지원됩니다');
      return;
    }
    if (this.advisorChild) {
      flashStatus(state, 'Advisor 자문이 이미 실행 중입니다');
      return;
    }

    state.activeTrigger = 0;
    state.advisorState = '자문 중';
    state.carbonCalls += 1;
    appendLog(state, 'Advisor', 'purple', `자문 분석 중 — ${redactSecrets(question)}`);
    onUpdate();

    const contextHint = state.latestResponse
      ? `최근 Lead 응답 요약:\n${state.latestResponse.slice(0, 1500)}\n\n`
      : '';
    const advisorPrompt = `${contextHint}당신은 코딩 세션의 메타 자문(Advisor)입니다. 코드를 직접 수정하지 말고, 다음 질문에 대해 한국어 2문장 이내로 핵심 조언만 간결히 답하세요:\n${question}`;

    const args = [
      '--output-format',
      'stream-json',
      '--model',
      'gemini-4-carbon-high',
      `--print=${advisorPrompt}`,
    ];

    const child = spawn('agy', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSanitizedChildEnv({ allowKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }),
    });
    this.advisorChild = child;

    let accText = '';
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line) as {
          event?: string;
          step_update?: { step_type?: string; text_delta?: string; usage?: { total_tokens?: number } };
          result?: { response?: string; usage?: { total_tokens?: number } };
        };
        if (obj.event === 'step_update' && obj.step_update?.step_type === 'agent_response') {
          if (obj.step_update.text_delta) accText += obj.step_update.text_delta;
        }
        if (obj.event === 'result') {
          if (obj.result?.response) accText = obj.result.response;
          if (obj.result?.usage?.total_tokens) {
            state.totalTokensUsed += obj.result.usage.total_tokens;
            state.tokensRead = formatTokensCount(state.totalTokensUsed);
          }
        }
      } catch {
        // 무시
      }
    });

    child.on('close', () => {
      if (this.advisorChild === child) this.advisorChild = null;
      const clean = redactSecrets(accText.trim().replace(/\s+/g, ' '));
      if (clean.length > 0) {
        state.latestAdvice = `» ${clean}`;
        state.adviceHistory.push({
          time: formatNowHHMMSS(),
          triggerIndex: 0,
          triggerLabel: TRIGGER_LABELS[0],
          text: clean,
          tokensRead: state.tokensRead,
        });
        appendLog(state, 'Advisor', 'purple', clean);
      }
      state.advisorState = '대기 중';
      onUpdate();
    });
  }

  /**
   * Verifier(독립 교차 검증 역할)에게 계획·변경 diff·응답의 교차 검증을 요청합니다.
   */
  askNeonVerify(target: string, state: AppState, onUpdate: () => void): void {
    if (this.backend === 'none') {
      flashStatus(state, '사용 가능한 백엔드(agy 또는 GEMINI_API_KEY)가 없습니다', 4000);
      return;
    }
    if (this.neonChild || this.neonAbortController) {
      flashStatus(state, 'Verifier 교차 검증이 이미 실행 중입니다');
      return;
    }

    const label = target.length > 18 ? target.slice(0, 17) + '…' : target;
    state.neonState = 'run';
    state.neonProgress = 18;
    state.neonLabel = label;
    state.neonSummary = `${label} 독립 교차 검증 중…`;
    appendLog(state, 'Verifier', 'neon', `독립 교차 검증 시작 — ${redactSecrets(target)}`);
    flashStatus(state, `Verifier 교차 검증 시작 (${state.neonModelName})`);
    onUpdate();

    const contextHint = state.latestResponse
      ? `최근 Lead 작업/응답 요약:\n${state.latestResponse.slice(0, 2000)}\n\n`
      : `현재 Lead 작업 요약: ${state.mainSummary}\n\n`;
    const verifyPrompt = `${contextHint}당신은 코딩 세션의 독립 교차 검증 역할(Verifier)입니다. 코드를 직접 수정하지 말고, 누락·회귀·엣지케이스 관점에서 아래 대상을 검증해 주세요. 첫 머리에 [PASS] 또는 [FAIL]을 붙이고 한국어 2문장 이내로 핵심 결과만 간결히 답하세요:\n${target}`;

    const finalizeNeon = (rawText: string, failedExec = false) => {
      const clean = redactSecrets(rawText.trim().replace(/\s+/g, ' '));
      const isFail = failedExec || /^\[FAIL\]/i.test(clean);
      const display = clean.replace(/^\[(PASS|FAIL)\]\s*/i, '') || (isFail ? '검증 실패' : '회귀·누락 없음');
      state.neonState = isFail ? 'fail' : 'pass';
      state.neonProgress = 100;
      state.neonSummary = display;
      if (!isFail) {
        state.neonVerified += 1;
      }
      state.neonHistory.push({
        time: formatNowHHMMSS(),
        label,
        status: isFail ? 'fail' : 'pass',
        summary: display,
        model: state.neonModelName,
      });
      if (state.neonHistory.length > 50) {
        state.neonHistory.splice(0, state.neonHistory.length - 50);
      }
      appendLog(
        state,
        'Verifier',
        'neon',
        `${isFail ? '검증 주의' : '검증 통과'} — ${display}`
      );
      flashStatus(state, isFail ? 'Verifier 교차 검증 주의 항목 발견 (n:상세)' : 'Verifier 교차 검증 통과 (n:상세)');
      onUpdate();
    };

    if (this.backend === 'agy') {
      const args = [
        '--output-format',
        'stream-json',
        '--model',
        state.neonModelName,
        `--print=${verifyPrompt}`,
      ];
      const child = spawn('agy', args, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildSanitizedChildEnv({ allowKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }),
      });
      this.neonChild = child;

      let accText = '';
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        try {
          const obj = JSON.parse(line) as {
            event?: string;
            step_update?: { step_type?: string; text_delta?: string; usage?: { total_tokens?: number } };
            result?: { response?: string; usage?: { total_tokens?: number }; error?: string };
          };
          if (obj.event === 'step_update') {
            state.neonProgress = Math.min(92, state.neonProgress + 12);
            if (obj.step_update?.step_type === 'agent_response' && obj.step_update.text_delta) {
              accText += obj.step_update.text_delta;
            }
            onUpdate();
          }
          if (obj.event === 'result') {
            if (obj.result?.response) accText = obj.result.response;
            if (obj.result?.usage?.total_tokens) {
              state.totalTokensUsed += obj.result.usage.total_tokens;
              state.tokensRead = formatTokensCount(state.totalTokensUsed);
            }
          }
        } catch {
          // 무시
        }
      });

      child.on('error', (err) => {
        if (this.neonChild === child) this.neonChild = null;
        finalizeNeon(`agy 실행 오류: ${err.message}`, true);
      });

      child.on('close', (code) => {
        if (this.neonChild === child) this.neonChild = null;
        if (state.neonState !== 'run') return; // cancel됨
        finalizeNeon(accText || (code === 0 ? '검증 완료' : `종료 코드 ${code}`), code !== 0);
      });
      return;
    }

    // GEMINI_API_KEY REST API 폴백 교차 검증 — 키는 헤더로만 전달(?key= URL 폐기)
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    const apiModel = mapModelForGeminiApi(state.neonModelName);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent`;
    const ctrl = new AbortController();
    this.neonAbortController = ctrl;

    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(restTimeoutMs())]),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: verifyPrompt }] }],
      }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          usageMetadata?: { totalTokenCount?: number };
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        if (data.usageMetadata?.totalTokenCount) {
          state.totalTokensUsed += data.usageMetadata.totalTokenCount;
          state.tokensRead = formatTokensCount(state.totalTokensUsed);
        }
        const txt = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        finalizeNeon(txt || '검증 완료', false);
      })
      .catch((err) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          finalizeNeon(err instanceof Error ? err.message : String(err), true);
        }
      })
      .finally(() => {
        if (this.neonAbortController === ctrl) this.neonAbortController = null;
      });
  }

  /**
   * GEMINI_API_KEY 환경변수를 이용한 직접 Gemini REST API + 로컬 읽기 도구 루프
   */
  private async runWithGeminiApi(
    prompt: string,
    state: AppState,
    onUpdate: () => void
  ): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    const apiModel = mapModelForGeminiApi(state.modelName);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent`;

    const ctrl = new AbortController();
    this.abortController = ctrl;

    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: prompt }] },
    ];
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'list_dir',
            description: '현재 워크스페이스의 파일 및 디렉터리 목록을 조회합니다.',
            parameters: {
              type: 'OBJECT',
              properties: { path: { type: 'STRING', description: '상대 경로' } },
            },
          },
          {
            name: 'read_file',
            description: '워크스페이스 내 파일 내용을 읽습니다.',
            parameters: {
              type: 'OBJECT',
              properties: { path: { type: 'STRING', description: '파일 상대 경로' } },
              required: ['path'],
            },
          },
          {
            name: 'grep_search',
            description: '워크스페이스 내 문자열 패턴을 검색합니다.',
            parameters: {
              type: 'OBJECT',
              properties: { query: { type: 'STRING', description: '검색할 문자열' } },
              required: ['query'],
            },
          },
        ],
      },
    ];

    try {
      for (let round = 0; round < 6; round++) {
        state.phase = round === 0 ? '추론 중' : `도구 후 추론 (${round})`;
        onUpdate();

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(restTimeoutMs())]),
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: '당신은 DGATE TUI의 Lead 리드 에이전트입니다. 한국어로 명확하게 답하고, 파일 확인이 필요하면 제공된 도구를 사용하세요.',
                },
              ],
            },
            contents,
            tools,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
        }

        const data = (await res.json()) as {
          usageMetadata?: { totalTokenCount?: number };
          candidates?: Array<{
            content?: {
              role?: string;
              parts?: Array<{
                text?: string;
                functionCall?: { name: string; args?: Record<string, unknown> };
              }>;
            };
          }>;
        };

        if (data.usageMetadata?.totalTokenCount) {
          state.totalTokensUsed += data.usageMetadata.totalTokenCount;
          state.tokensRead = formatTokensCount(state.totalTokensUsed);
        }

        const candidateContent = data.candidates?.[0]?.content;
        const parts = candidateContent?.parts ?? [];
        const fnCalls = parts.filter((p) => Boolean(p.functionCall));
        const textParts = parts.map((p) => p.text ?? '').join('');

        if (textParts) {
          state.latestResponse += textParts;
        }

        if (fnCalls.length === 0) {
          state.phase = '완료';
          state.activeTrigger = 2;
          const firstLine =
            state.latestResponse.split('\n').find((l) => l.trim().length > 0) ?? '응답 완료';
          state.backSummary =
            firstLine.length > 42 ? firstLine.slice(0, 41) + '… (r:전문)' : `${firstLine} (r:전문)`;
          appendLog(state, 'Lead', 'orange', '응답 완료 (r 키로 전문 보기)');
          break;
        }

        contents.push({ role: 'model', parts });
        const fnResponses: Array<Record<string, unknown>> = [];

        for (const p of fnCalls) {
          const fc = p.functionCall!;
          state.totalForks += 1;
          state.swarmActive = Math.min(state.swarmMax, state.swarmActive + 1);
          const cardIdx = fc.name === 'grep_search' ? 1 : 0;
          state.cards[cardIdx]!.status = 'running';
          state.cards[cardIdx]!.progress = 60;
          appendLog(state, 'Decision Gate', 'green', `도구 실행 → ${redactSecrets(fc.name)}`);
          onUpdate();

          const output = executeLocalReadOnlyTool(fc.name, fc.args ?? {});
          const hadError = typeof output['error'] === 'string';
          state.consecutiveToolErrors = hadError ? state.consecutiveToolErrors + 1 : 0;

          // SSOT 기록(source 'rest_api') — demo·DECISION_READONLY 쓰기 가드(§5.2-C)
          if (!decisionWriteBlocked(state)) {
            try {
              const fcArgs = fc.args ?? {};
              const { route, toolClass } = classifyTool(fc.name, fcArgs);
              const { projectId, projectLabel } = resolveProjectIdentity(process.cwd());
              recordToolOutcomeSafe(resolveDbPath(), {
                projectId,
                projectLabel,
                route,
                toolClass,
                toolName: fc.name,
                ok: !hadError,
                conversationId: state.conversationId,
                targetHash: targetHashForArgs(fcArgs),
                errorSnippet: hadError ? redactSecrets(String(output['error'])).slice(0, 300) : null,
                source: 'rest_api',
                commandLine: commandLineOfArgs(fcArgs),
              });
            } catch {
              // fail-open — 수집 실패가 UI를 죽이지 않는다(§3.5)
            }
            syncRoutesFromSsot(state);
          }

          // 같은 오류 2연속 → Pre-Lead Gate 점등(§5.2-C.4)
          if (state.consecutiveToolErrors >= 2) {
            state.activeTrigger = 1;
            state.advisorState = '자문 중';
            state.carbonCalls += 1;
            state.latestAdvice = `» ${redactSecrets(fc.name)} 연속 오류 감지 — 파라미터/경로 재검토 필요`;
            appendLog(state, 'Advisor', 'purple', `같은 오류 2회 감지 — ${redactSecrets(fc.name)}`);
          }

          state.cards[cardIdx]!.status = hadError ? 'error' : 'done';
          state.cards[cardIdx]!.progress = 100;
          state.swarmActive = Math.max(0, state.swarmActive - 1);
          appendLog(
            state,
            'Worker',
            'blue',
            `${fc.name} ${hadError ? '실패' : '완료'}${hadError ? ` — ${redactSecrets(String(output['error'])).slice(0, 60)}` : ''}`
          );
          fnResponses.push({
            functionResponse: {
              name: fc.name,
              response: output,
            },
          });
        }
        contents.push({ role: 'user', parts: fnResponses });
      }
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        state.phase = '오류';
        state.activeTrigger = 1;
        state.advisorState = '자문 중';
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        state.latestAdvice = `» API 오류: ${msg}`;
        appendLog(state, 'Advisor', 'purple', `API 오류 — ${msg}`);
      }
    } finally {
      this.abortController = null;
      state.agentBusy = false;
      onUpdate();
    }
  }
}
