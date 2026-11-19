/**
 * `gemini-decision-1` REST API 어댑터 + 모드별 적용 정책 (plan-r2.1 §4.8 — 추가 2, brief-decision-api §2·§3).
 *
 * 목적: 콜드스타트(`basis='prior'`) 앞단 분류에 외부 Decision 모델(`POST /v1beta/decisions`)
 * 결과를 `off | shadow | on` 3단계로 접목한다. `off`는 로컬 EWMA Beta 완결(네트워크 0),
 * `shadow`는 병행 호출 후 가상 판정만 기록(적용 0), `on`은 하드 안전 가드를 통과한
 * API 판정을 실제 적용한다.
 *
 * 외부 연결:
 * - `dg route|gate`·`scripts/dispatch.ts`가 `applyDecisionApi` 단일 진입으로 호출해
 *   두 경로의 정책이 100% 일치한다.
 * - 인증은 `x-goog-api-key` 헤더 전용 — URL `?key=` 쿼리 절대 금지, 키는 로그·반환·
 *   DB 어디에도 기록하지 않는다(오류 문자열은 `redactSecrets` + 명시 키 스크럽 2중 적용).
 *
 * 주의:
 * - `GEMINI_DECISION_API_KEY` 부재·공백이면 `shadow`/`on` 요청도 `off`로 강등(무비용·무I/O).
 * - `on` 모드도 `basis='measured'`이면 `--context`/`--api-eval` 없이는 API를 호출하지
 *   않는다(학습된 로컬 EWMA 신뢰).
 * - 하드 안전 가드는 절대 우회 불가: `requires_write`(sharpEligible=false)·
 *   `forced_split`·`localRisk != 'low'`·API riskTier 상승은 항상 `split`을 강제한다.
 * - 모든 네트워크·타임아웃·HTTP·JSON·스키마 오류는 fail-safe: 호출자에 예외를 던지지
 *   않고 구조화 실패(`ok:false`)와 로컬 판정 폴백을 반환한다.
 * - 외부 npm 의존성 0, `erasableSyntaxOnly` 준수(enum·파라미터 프로퍼티 없음).
 */
import { escalateRisk, type RiskLevel, type RouteId } from './engine.ts';
import { redactSecrets } from './redact.ts';

export type DecisionApiMode = 'off' | 'shadow' | 'on';

export interface DecisionAdapterInput {
  projectId: string;
  route: RouteId;
  toolClass: string;
  basis: 'prior' | 'measured';
  pLocal: number;
  taskKind?: string | null;
  requiresWrite?: boolean | null;
  riskLevel?: RiskLevel | null;
  samples?: number;
  consecutiveErrors?: number;
  title?: string | null;
  context?: string | null;
}

export interface DecisionAdapterResult {
  p: number;
  source: 'local' | 'api';
}

export interface DecisionAdapter {
  classify(input: DecisionAdapterInput): Promise<DecisionAdapterResult | null>;
}

// ---------- 환경 설정 ----------

export interface DecisionApiConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-decision-1';
const DEFAULT_TIMEOUT_MS = 3000;
const TIMEOUT_MIN_MS = 50;
const TIMEOUT_MAX_MS = 30000;
/** 입력 토큰 단가 ($ / 1M tokens) — output_tokens=0 규약 */
const INPUT_TOKEN_PRICE_PER_M = 0.10;
/** 외부 API로 보내는 context 최대 길이 (리댁션 적용 후 절단) */
const CONTEXT_MAX_CHARS = 4000;
/** 오류 문자열 상한 */
const ERROR_MAX_CHARS = 240;

export function resolveDecisionApiConfig(env: Record<string, string | undefined> = process.env): DecisionApiConfig {
  const baseUrl = (env.DECISION_API_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = (env.DECISION_API_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const rawTimeout = Number.parseInt(env.DECISION_API_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, rawTimeout))
    : DEFAULT_TIMEOUT_MS;
  const apiKey = env.GEMINI_DECISION_API_KEY?.trim() ?? '';
  return { baseUrl, model, timeoutMs, apiKey };
}

// ---------- 모드 파싱 ----------

export function isDecisionApiMode(v: string): v is DecisionApiMode {
  return v === 'off' || v === 'shadow' || v === 'on';
}

/**
 * `DECISION_API` 파싱 + 무키 강등 규칙.
 * - `overrideMode`가 주어지면(`--decision-api` CLI 값) 그 값을 우선한다.
 * - 정상값(`shadow`|`on`)이 아니면 `off`.
 * - `shadow`/`on`이어도 `GEMINI_DECISION_API_KEY` 부재 시 `off` (네트워크 I/O·비용 0).
 */
export function parseDecisionApiMode(
  env: Record<string, string | undefined> = process.env,
  overrideMode?: DecisionApiMode
): DecisionApiMode {
  const raw = (overrideMode ?? env.DECISION_API ?? 'off').trim().toLowerCase();
  if (raw !== 'shadow' && raw !== 'on') return 'off';
  const key = env.GEMINI_DECISION_API_KEY;
  return key && key.trim() ? raw : 'off';
}

// ---------- 요청 프롬프트 / 본문 ----------

/**
 * 외부 API `input` 프롬프트 — title·context는 반드시 `redactSecrets`를 거친 뒤
 * 전송한다(절단보다 리댁션 선행 — 경계 걸친 시크릿도 탐지되도록).
 */
export function buildDecisionPromptInput(input: DecisionAdapterInput): string {
  const lines: string[] = [`route: ${input.route}`, `tool_class: ${input.toolClass}`];
  if (input.taskKind != null && input.taskKind !== '') lines.push(`task_kind: ${input.taskKind}`);
  if (input.requiresWrite != null) lines.push(`requires_write: ${input.requiresWrite}`);
  if (input.riskLevel != null) lines.push(`risk_level: ${input.riskLevel}`);
  lines.push(`local_p: ${input.pLocal}`);
  lines.push(`local_basis: ${input.basis}`);
  lines.push(`samples: ${input.samples ?? 0}`);
  lines.push(`consecutive_errors: ${input.consecutiveErrors ?? 0}`);
  if (input.title != null && input.title !== '') lines.push(`title: ${redactSecrets(input.title)}`);
  if (input.context != null && input.context !== '') {
    lines.push(`context: ${redactSecrets(input.context).slice(0, CONTEXT_MAX_CHARS)}`);
  }
  return lines.join('\n');
}

const DECISION_QUESTIONS = {
  should_fast_path: {
    type: 'noul',
    instructions:
      'Estimate the probability that this step succeeds cleanly on a single-turn fast-path without multi-step orchestration.',
    criteria: {
      true_description:
        'Simple, bounded, read-only or low-risk operation with high likelihood of first-try success.',
      false_description:
        'Ambiguous, write-heavy, high-risk, multi-file, or error-prone operation requiring structured planning or verification.',
    },
  },
  risk_tier: {
    type: 'choice',
    instructions: 'Classify the operational risk tier of this operation.',
    criteria: {
      low: 'Read-only inspection, search, or isolated non-destructive check.',
      medium: 'Bounded single-file edit, local config change, or moderate blast radius.',
      high: 'Multi-file refactor, migration, security/auth change, deployment, or destructive action.',
    },
  },
} as const;

export function buildDecisionRequestBody(model: string, promptInput: string): Record<string, unknown> {
  return { model, input: promptInput, questions: DECISION_QUESTIONS };
}

// ---------- 응답 파싱 ----------

export interface DecisionApiDetailedResult {
  ok: boolean;
  p: number | null;
  confidence: number | null;
  riskTier: RiskLevel | null;
  inputTokens: number | null;
  costUsd: number | null;
  costStatus: 'estimated' | 'unknown';
  latencyMs: number;
  model: string;
  error: string | null;
}

export interface DetailedDecisionAdapter extends DecisionAdapter {
  classifyDetailed(input: DecisionAdapterInput): Promise<DecisionApiDetailedResult>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isRiskTier(v: unknown): v is RiskLevel {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * `answers.should_fast_path.noul` 필수 유효성 + 선택 필드 추출.
 * noul이 유한수가 아니면 fail-safe 오류로 던진다(호출자가 `ok:false`로 변환).
 */
function parseDecisionApiAnswers(data: unknown): {
  p: number;
  confidence: number | null;
  riskTier: RiskLevel | null;
  inputTokens: number | null;
  costUsd: number | null;
  costStatus: 'estimated' | 'unknown';
} {
  const root = asRecord(data);
  const answers = asRecord(root?.answers);
  const sfp = asRecord(answers?.should_fast_path);
  const noul = sfp?.noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) {
    throw new Error('invalid_response: missing should_fast_path.noul');
  }
  const conf = sfp?.confidence;
  const confidence =
    typeof conf === 'number' && Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : null;
  const rt = asRecord(answers?.risk_tier);
  const riskTier = isRiskTier(rt?.choice) ? rt.choice : null;
  const usage = asRecord(root?.usage);
  const usageMeta = asRecord(root?.usage_metadata);
  const it =
    usage?.total_input_tokens ??
    usage?.input_tokens ??
    usageMeta?.input_tokens ??
    usageMeta?.total_input_tokens;
  const inputTokens = typeof it === 'number' && Number.isInteger(it) && it >= 0 ? it : null;
  const costUsd = inputTokens !== null ? Number(((inputTokens * INPUT_TOKEN_PRICE_PER_M) / 1_000_000).toFixed(8)) : null;
  return {
    p: Math.min(0.99, Math.max(0.01, noul)),
    confidence,
    riskTier,
    inputTokens,
    costUsd,
    costStatus: inputTokens !== null ? 'estimated' : 'unknown',
  };
}

/** 명시 API 키 스크럽 — 커스텀 테스트 키가 표준 토큰 정규식에 걸리지 않는 경우를 대비 */
function scrubApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  let out = text;
  if (out.includes(apiKey)) out = out.split(apiKey).join('<redacted>');
  const encoded = encodeURIComponent(apiKey);
  if (encoded !== apiKey && out.includes(encoded)) out = out.split(encoded).join('<redacted>');
  return out;
}

function sanitizeApiError(msg: string, apiKey: string): string {
  return redactSecrets(scrubApiKey(msg, apiKey)).slice(0, ERROR_MAX_CHARS);
}

// ---------- 어댑터 구현 ----------

/**
 * 공식 Decisions REST 호출 구현 — `POST ${baseUrl}/v1beta/decisions`.
 * 인증은 `x-goog-api-key` 헤더 전용이다(`?key=` 쿼리 금지). 모든 실패는
 * `ok:false` 구조화 결과로 변환해 호출 경로를 죽이지 않는다(fail-safe).
 */
export class GeminiDecisionAdapter implements DetailedDecisionAdapter {
  private readonly config: DecisionApiConfig;

  constructor(config: DecisionApiConfig) {
    this.config = config;
  }

  get model(): string {
    return this.config.model;
  }

  async classify(input: DecisionAdapterInput): Promise<DecisionAdapterResult | null> {
    const res = await this.classifyDetailed(input);
    return res.ok && res.p !== null ? { p: res.p, source: 'api' } : null;
  }

  async classifyDetailed(input: DecisionAdapterInput): Promise<DecisionApiDetailedResult> {
    const startedAt = Date.now();
    const { baseUrl, model, timeoutMs, apiKey } = this.config;
    const fail = (msg: string): DecisionApiDetailedResult => ({
      ok: false,
      p: null,
      confidence: null,
      riskTier: null,
      inputTokens: null,
      costUsd: null,
      costStatus: 'unknown',
      latencyMs: Date.now() - startedAt,
      model,
      error: sanitizeApiError(msg, apiKey),
    });
    try {
      const body = JSON.stringify(buildDecisionRequestBody(model, buildDecisionPromptInput(input)));
      const res = await fetch(`${baseUrl}/v1beta/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) return fail(`http_${res.status}: ${text.slice(0, 400)}`);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return fail('invalid_response: malformed_json');
      }
      const parsed = parseDecisionApiAnswers(data);
      return {
        ok: true,
        ...parsed,
        latencyMs: Date.now() - startedAt,
        model,
        error: null,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

/** 노옵 로컬 구현 — 네트워크 I/O 없음, 항상 로컬 판정 유지(null/fail 결과) */
export class NoopDecisionAdapter implements DetailedDecisionAdapter {
  async classify(_input: DecisionAdapterInput): Promise<DecisionAdapterResult | null> {
    return null;
  }

  async classifyDetailed(_input: DecisionAdapterInput): Promise<DecisionApiDetailedResult> {
    return {
      ok: false,
      p: null,
      confidence: null,
      riskTier: null,
      inputTokens: null,
      costUsd: null,
      costStatus: 'unknown',
      latencyMs: 0,
      model: '',
      error: 'decision api disabled',
    };
  }
}

export function createDecisionAdapter(
  mode: DecisionApiMode = parseDecisionApiMode(),
  env: Record<string, string | undefined> = process.env
): DetailedDecisionAdapter {
  if (mode === 'off') return new NoopDecisionAdapter();
  return new GeminiDecisionAdapter(resolveDecisionApiConfig(env));
}

// ---------- 모드별 적용 정책 + 감사 ----------

export interface DecisionApiAudit {
  mode: 'shadow' | 'on';
  model: string;
  applied: boolean;
  ok: boolean;
  p_local: number;
  p_api: number | null;
  confidence: number | null;
  risk_tier: RiskLevel | null;
  local_decision: 'sharp' | 'split';
  api_decision: 'sharp' | 'split' | null;
  disagreed: boolean | null;
  input_tokens: number | null;
  cost_usd: number | null;
  cost_status: 'estimated' | 'unknown';
  latency_ms: number;
  error: string | null;
}

export interface ApplyDecisionApiInput {
  mode: DecisionApiMode;
  adapter: DetailedDecisionAdapter;
  localDecision: 'sharp' | 'split';
  pLocal: number;
  sharpThreshold: number;
  basis: 'prior' | 'measured';
  /** route: spec.sharpEligible, gate: true */
  sharpEligible: boolean;
  /** route: 에스컬레이션된 태스크 위험도, gate: riskOverride ?? 'low' */
  localRisk: RiskLevel;
  forcedSplit: boolean;
  /** `--api-eval` 또는 비공백 `--context` — measured 기반에서도 강제 API 평가 */
  forceApiEval?: boolean;
  adapterInput: DecisionAdapterInput;
}

export interface ApplyDecisionApiResult {
  decision: 'sharp' | 'split';
  p: number;
  risk: RiskLevel;
  audit: DecisionApiAudit | null;
}

/**
 * 모드별 Decision API 적용 정책 — dg.ts·dispatch.ts 공용 단일 진입.
 *
 * - `off`: 즉시 반환 (HTTP 0, audit null).
 * - `shadow`: API 호출 + 동일 하드 가드로 가상 `api_decision` 계산·불일치 기록만
 *   (`applied:false` — 로컬 decision/p/risk 절대 불변).
 * - `on`: `basis='prior'` 또는 `forceApiEval`일 때만 호출. 성공 시 하드 가드로
 *   `apiDecision`을 계산해 적용(`applied:true`), 실패 시 로컬 폴백(`applied:false`).
 *
 * 하드 안전 가드(우회 불가): `apiDecision = sharpEligible && effectiveRisk==='low'
 * && !forcedSplit && pApi >= sharpThreshold ? 'sharp' : 'split'` —
 * `effectiveRisk`는 `escalateRisk(localRisk, api.riskTier)`로 상향만 허용한다.
 * EWMA 격리: 이 경로는 `decision_events`에 어떤 행도 기록하지 않는다.
 */
export async function applyDecisionApi(input: ApplyDecisionApiInput): Promise<ApplyDecisionApiResult> {
  const { mode, localDecision, pLocal, localRisk } = input;
  if (mode === 'off') {
    return { decision: localDecision, p: pLocal, risk: localRisk, audit: null };
  }
  if (mode === 'on' && input.basis === 'measured' && input.forceApiEval !== true) {
    // 학습된 로컬 EWMA 신뢰 — API 호출 0회, 감사 없음
    return { decision: localDecision, p: pLocal, risk: localRisk, audit: null };
  }

  const res = await input.adapter.classifyDetailed(input.adapterInput);

  let apiDecision: 'sharp' | 'split' | null = null;
  let effectiveRisk = localRisk;
  if (res.ok && res.p !== null) {
    effectiveRisk = escalateRisk(localRisk, res.riskTier ?? undefined);
    apiDecision =
      input.sharpEligible && effectiveRisk === 'low' && !input.forcedSplit && res.p >= input.sharpThreshold
        ? 'sharp'
        : 'split';
  }
  const audit: DecisionApiAudit = {
    mode,
    model: res.model,
    applied: false,
    ok: res.ok,
    p_local: pLocal,
    p_api: res.p,
    confidence: res.confidence,
    risk_tier: res.riskTier,
    local_decision: localDecision,
    api_decision: apiDecision,
    disagreed: apiDecision !== null ? apiDecision !== localDecision : null,
    input_tokens: res.inputTokens,
    cost_usd: res.costUsd,
    cost_status: res.costStatus,
    latency_ms: res.latencyMs,
    error: res.error,
  };
  if (mode === 'on' && res.ok && apiDecision !== null) {
    audit.applied = true;
    return { decision: apiDecision, p: res.p, risk: effectiveRisk, audit };
  }
  return { decision: localDecision, p: pLocal, risk: localRisk, audit };
}
