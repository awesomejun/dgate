/**
 * `src/decision/redact.ts` — 시크릿 방어 3중 경계 공용 리댁션 유틸 (PR-A1, §4.1 Layer B·C).
 *
 * 목적: 로그·오류 스니펫·DB `error_snippet`/`command_line`·자식 워커 env 상속 경로로
 * 평문 시크릿이 유출되는 것을 원천 차단한다.
 *
 * 외부 연결:
 * - `agentRunner.ts`(appendLog·latestAdvice·recordToolOutcomeSafe·spawn env),
 *   `agyStreamMapper.ts`·`transcriptMapper.ts`(errorSnippet·tool_info.output 로그),
 *   `.agents/hooks/dg-hook.ts`(--collect errorSnippet·commandLine)가 호출한다.
 * - 외부 npm 의존성 0. `erasableSyntaxOnly` 준수(enum·파라미터 프로퍼티 없음).
 *
 * 주의:
 * - `redactSecrets`는 무예외(Zero-Throw) 순수 함수다 — 어떤 입력·환경에서도 예외를
 *   던지지 않으므로 fail-open 수집 경로(`§3.5`) 어디에나 안전하게 삽입할 수 있다.
 * - 리댁션은 절단(slice) **이전**에 적용해야 한다. 절단 후 적용하면 시크릿이
 *   잘린 경계에 걸쳐 패턴 매칭이 무효화된다.
 */

/** 규칙 1: 런타임 env 스크러빙 대상 키 — 값 길이 >= 8만 수집(짧은 더미 오치환 방지) */
const ENV_SECRET_KEY_RE =
  /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$|^GEMINI_API_KEY$|^GOOGLE_API_KEY$/i;

const MIN_SECRET_LEN = 8;

// 규칙 2: 정규식 패턴 세트 — 모듈 로드 시 1회 컴파일(g 플래그는 lastIndex가
// replace() 실행 시 리셋되므로 재사용 안전).
const ENV_ASSIGN_RE =
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY))\s*[:=]\s*(['"]?)([^\s'"&;]+)\2/g;
const AUTH_HEADER_RE =
  /(\b(?:Authorization|x-goog-api-key|x-api-key)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?)([^\s,'"]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/g;
const URL_QUERY_RE = /([?&](?:key|api_key|apikey|token|access_token|secret|auth)=)([^&\s'"]+)/gi;
const USERINFO_RE = /(https?:\/\/[^:@\/\s]+:)([^@\/\s]+)(@)/gi;
const KNOWN_PREFIX_RES = [
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /sk-[A-Za-z0-9\-_]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

const REDACTED = '<redacted>';

/** 현재 process.env에서 스크러빙 대상 시크릿 값 수집 (길이 >= 8, 긴 것 우선) */
function collectEnvSecretValues(extraValues?: readonly string[]): string[] {
  const values = new Set<string>();
  try {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== 'string' || value.length < MIN_SECRET_LEN) continue;
      if (!ENV_SECRET_KEY_RE.test(key)) continue;
      values.add(value);
    }
  } catch {
    // env 열거 실패 시 env 스크러빙만 생략 — 아래 extraValues·패턴 규칙은 유지
  }
  for (const v of extraValues ?? []) {
    if (typeof v === 'string' && v.length >= MIN_SECRET_LEN) values.add(v);
  }
  // 부분 문자열 관계(한 시크릿이 다른 시크릿의 접두)일 때 긴 값부터 치환해야
  // 짧은 값이 먼저 잘라내어 긴 값 매칭이 깨지는 일이 없다.
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * 문자열 내 시크릿을 `<redacted>`로 치환한다. 절대 예외를 던지지 않는다.
 * 적용 규칙: ① 런타임 env 실측값(raw + encodeURIComponent) ② 패턴 정규식 세트.
 */
export function redactSecrets(input: string, extraValues?: readonly string[]): string {
  try {
    if (typeof input !== 'string' || input.length === 0) return input;
    let out = input;

    // 규칙 1 — 런타임 실측 env 값: 원문과 URL 인코딩 형태 모두 치환.
    // split/join은 임의 문자(정규식 메타 포함)도 안전하게 치환한다.
    for (const secret of collectEnvSecretValues(extraValues)) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret && out.includes(encoded)) {
        out = out.split(encoded).join(REDACTED);
      }
    }

    // 규칙 2 — 패턴 세트
    out = out.replace(ENV_ASSIGN_RE, `$1=$2${REDACTED}$2`);
    out = out.replace(AUTH_HEADER_RE, `$1${REDACTED}`);
    out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
    out = out.replace(URL_QUERY_RE, `$1${REDACTED}`);
    out = out.replace(USERINFO_RE, `$1${REDACTED}$3`);
    for (const re of KNOWN_PREFIX_RES) {
      out = out.replace(re, REDACTED);
    }
    return out;
  } catch {
    // Zero-Throw 계약: 치환 실패 시에도 호출 경로(UI·수집)를 죽이지 않는다.
    return input;
  }
}

// ---------------------------------------------------------------------------
// Layer B — 자식 워커 env 최소 격리

/** 자식 env에서 제거할 민감 키 패턴 (Layer B) */
const CHILD_SENSITIVE_KEY_RE =
  /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$|^(GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/i;

/** 민감 패턴에 걸려도 유지하는 안전 기본 키(정확 일치, 대소문자 무시) */
const SAFE_EXACT_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'DGATE_DB_PATH',
  'DECISION_ORCHESTRATOR_DB_PATH',
  'GEMINI_TRICK_DB_PATH',
  'PI_BIN',
  'AGY_BIN',
  'DEVIN_BIN',
  'HC_BIN',
  'CLAUDE_BIN',
]);

/** 유지 접두사 (대소문자 무시) */
const SAFE_KEY_PREFIXES = ['LC_', 'XDG_', 'HERDR_', 'DECISION_'];

function isSafeKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SAFE_EXACT_KEYS.has(upper)) return true;
  return SAFE_KEY_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * 자식 프로세스에 상속할 env를 구성한다.
 * `baseEnv`(기본 process.env)에서 민감 키를 제거하되 `allowKeys`·안전 기본 키는
 * 유지하고 `extraEnv`를 병합한다(`undefined` 값은 해당 키 삭제).
 */
export function buildSanitizedChildEnv(opts?: {
  allowKeys?: readonly string[];
  extraEnv?: Record<string, string | undefined>;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = opts?.baseEnv ?? process.env;
  const allow = new Set((opts?.allowKeys ?? []).map((k) => k.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!isSafeKey(key) && !allow.has(key.toUpperCase()) && CHILD_SENSITIVE_KEY_RE.test(key)) {
      continue;
    }
    out[key] = value;
  }
  for (const [key, value] of Object.entries(opts?.extraEnv ?? {})) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}
