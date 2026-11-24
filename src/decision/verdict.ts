/**
 * PR-A3 Fail-Closed 구조화 Verdict 검증 + `dg retro` 마크다운 포매터
 * (loopforge-arch-hydrogen §4.2·§5.1 PR-A3, LoopForge GateResult + fork/head 결합).
 *
 * 목적: Verifier가 남기는 `.herdr/verify/<fork_id>-verdict.json`(SSOT)을
 * ① 파일·크기·JSON 파싱 ② fork_id/target_head 결속 ③ 모순 판정 3중 불변식으로
 * 검증해, 검증 불가 상태가 절대 통과(pass)로 해석되지 않게 한다 — 모든 거부는
 * `effectiveDecision:'human'` 폴백(fail-closed)이다.
 * 선택 top-level `merge_danger`(door·blast_radius, mattpocock/skills `pr` 어휘)는
 * 존재 시 스키마 검증돼 문서에 보존되고, strict 모드 backprop 게이트가 필수 검사한다.
 *
 * 외부 연결:
 * - `dg.ts backprop --verdict-file`(Stage 2 배선): `validateVerdictFile`로 판정 파일을
 *   검증해 pass/rework/fail/human 분기·`waiting_human` 파킹을 낸다.
 * - `dg.ts retro --fork --out`: `buildRetroMarkdown`이 DB 시도 횟수·원인·실패 도구
 *   통계를 다음 워커 브리프용 마크다운으로 찍는다.
 * - `.herdr/roles/verifier.md`·`lead.md`: 이 모듈의 `VerdictDocument` 스키마·불변식 계약.
 *
 * 주의: 외부 npm 의존성 0개, `erasableSyntaxOnly` 준수(enum 금지, `as const`+`type`만).
 * `redactSecrets`(PR-A1)과는 선택적 `sanitize` 콜백으로만 결합한다 — 직접 import하지
 * 않아 모듈 의존 방향을 단방향(dg → verdict)으로 유지한다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Verifier가 남길 수 있는 판정 4종 — CLI·판정 문서가 공유하는 SSOT 값 목록 */
export const VERDICT_DECISIONS = ['pass', 'rework', 'fail', 'human'] as const;
export type VerdictDecision = (typeof VERDICT_DECISIONS)[number];

/** finding 심각도 등급 — `P0`/`P1`은 pass 판정과 공존할 수 없다(불변식 3) */
export const FINDING_SEVERITIES = ['P0', 'P1', 'P2', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Merge Danger door 값 — mattpocock/skills `pr` 어휘 흡수(합류 방향성) */
export const MERGE_DANGER_DOORS = ['one-way', 'two-way'] as const;
export type MergeDangerDoor = (typeof MERGE_DANGER_DOORS)[number];

export interface VerdictFinding {
  severity: FindingSeverity;
  title: string;
  evidence: string;
}

/** 합류 위험 표기(선택) — 검증자가 merge 방향성·영향 반경을 판정과 함께 남긴다 */
export interface MergeDanger {
  door: MergeDangerDoor;
  blast_radius: string;
}

export interface VerdictDocument {
  schema_version: 1;
  fork_id: string;
  target_head?: string;
  decision: VerdictDecision;
  reason: string;
  action_required?: string;
  findings: VerdictFinding[];
  checked_commands?: string[];
  artifacts?: string[];
  /** 선택 — 존재하면 door·blast_radius가 검증되고 backprop 출력에 에코된다.
   * strict dispatch 모드의 `dg backprop --verdict-file`은 유효한 verdict에 이 필드를
   * 필수로 요구한다(`mergeDangerStrictViolation` 게이트, UsageError exit 2). */
  merge_danger?: MergeDanger;
}

/** 검증 결과 — `valid:false`면 반드시 `effectiveDecision:'human'`(fail-closed) */
export interface VerdictValidationResult {
  valid: boolean;
  effectiveDecision: VerdictDecision;
  errors: string[];
  document?: VerdictDocument;
}

export interface ValidateVerdictDataOptions {
  expectedForkId: string;
  /** full sha 권장. 지정 시 문서 `target_head`와 일치·7자 이상 prefix 비교로 결속한다 */
  expectedHead?: string;
}

export interface ValidateVerdictFileOptions extends ValidateVerdictDataOptions {
  maxBytes?: number;
}

/** verdict 파일 크기 상한(64KB) — 과도하게 큰 판정 문서는 압축폭탄·오염 방지 차원 거부 */
export const DEFAULT_VERDICT_MAX_BYTES = 65536;

const MAX_REASON_LENGTH = 4000;
const MAX_ACTION_REQUIRED_LENGTH = 4000;
const MAX_FINDING_TITLE_LENGTH = 500;
/** merge_danger.blast_radius 상한(문자 수) — finding title과 같은 기준 */
const MAX_BLAST_RADIUS_LENGTH = 500;
/** HEAD prefix 비교 최소 길이 — 그 미만 약칭은 모호해서 Stale Verdict로 거부 */
const MIN_HEAD_PREFIX_LENGTH = 7;
/** retro 표 셀에 들어갈 오류 스니펫 상한(문자 수) */
const RETRO_SNIPPET_MAX_CHARS = 200;

function failClosed(errors: string[]): VerdictValidationResult {
  return { valid: false, effectiveDecision: 'human', errors };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
  );
}

/**
 * HEAD 결속 규칙: 문서 `target_head`가 `expectedHead`와 동일하거나, 한쪽이 다른 쪽의
 * 7자 이상 prefix면 일치로 본다(git 약칭 표기 허용). 그 외는 전부 불일치(Stale).
 */
function headMatches(docHead: string, expectedHead: string): boolean {
  if (docHead === expectedHead) return true;
  const shorter = docHead.length <= expectedHead.length ? docHead : expectedHead;
  const longer = docHead.length <= expectedHead.length ? expectedHead : docHead;
  return shorter.length >= MIN_HEAD_PREFIX_LENGTH && longer.startsWith(shorter);
}

/**
 * 불변식 1·2·3을 파싱된 JSON 값에 적용한다. 파일 I/O 없이 순수 검증이라
 * `dg backprop`가 파싱된 문서를 이미 들고 있을 때도 재사용 가능하다.
 *
 * 모든 위반은 누적돼 한 번에 보고되고, 위반이 1건이라도 있으면
 * `{ valid:false, effectiveDecision:'human' }`로 폴백한다 — 절대 pass로 넘어가지 않는다.
 */
export function validateVerdictData(
  raw: unknown,
  opts: ValidateVerdictDataOptions,
): VerdictValidationResult {
  const errors: string[] = [];

  // --- 불변식 1: 최소 구조·스키마 (Fail-Closed) ---
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return failClosed(['verdict 문서가 JSON 객체가 아닙니다']);
  }
  const doc = raw as Record<string, unknown>;

  if (doc.schema_version !== 1) {
    errors.push(`schema_version가 1이 아닙니다: ${JSON.stringify(doc.schema_version)}`);
  }

  const decision = doc.decision;
  const isKnownDecision =
    typeof decision === 'string' &&
    (VERDICT_DECISIONS as readonly string[]).includes(decision);
  if (!isKnownDecision) {
    errors.push(`알 수 없는 decision: ${JSON.stringify(decision) ?? 'undefined'}`);
  }

  if (typeof doc.reason !== 'string' || doc.reason.trim().length === 0) {
    errors.push('reason가 빈 문자열이거나 누락됐습니다');
  } else if (doc.reason.length > MAX_REASON_LENGTH) {
    errors.push(`reason가 ${MAX_REASON_LENGTH}자를 초과했습니다: ${doc.reason.length}자`);
  }

  if (typeof doc.action_required === 'string' && doc.action_required.length > MAX_ACTION_REQUIRED_LENGTH) {
    errors.push(
      `action_required가 ${MAX_ACTION_REQUIRED_LENGTH}자를 초과했습니다: ${doc.action_required.length}자`,
    );
  }

  // --- findings 스키마: 배열 + 항목별 severity/title/evidence 검증 ---
  let findings: VerdictFinding[] = [];
  if (!Array.isArray(doc.findings)) {
    errors.push('findings가 배열이 아닙니다');
  } else {
    const parsedFindings: VerdictFinding[] = [];
    const rawFindings = doc.findings as unknown[];
    for (let i = 0; i < rawFindings.length; i += 1) {
      const item = rawFindings[i];
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`findings[${i}]가 객체가 아닙니다`);
        continue;
      }
      const finding = item as Record<string, unknown>;
      const severity = finding.severity;
      if (
        typeof severity !== 'string' ||
        !(FINDING_SEVERITIES as readonly string[]).includes(severity)
      ) {
        errors.push(
          `findings[${i}].severity가 허용 값(P0|P1|P2|info)이 아닙니다: ${JSON.stringify(severity)}`,
        );
      }
      const title = finding.title;
      if (typeof title !== 'string' || title.trim().length === 0) {
        errors.push(`findings[${i}].title이 빈 문자열이거나 누락됐습니다`);
      } else if (title.length > MAX_FINDING_TITLE_LENGTH) {
        errors.push(
          `findings[${i}].title이 ${MAX_FINDING_TITLE_LENGTH}자를 초과했습니다: ${title.length}자`,
        );
      }
      if (typeof finding.evidence !== 'string') {
        errors.push(`findings[${i}].evidence가 문자열이 아닙니다`);
      }
      parsedFindings.push({
        severity: severity as FindingSeverity,
        title: title as string,
        evidence: finding.evidence as string,
      });
    }
    findings = parsedFindings;
  }

  if (doc.checked_commands !== undefined && !isStringArray(doc.checked_commands)) {
    errors.push('checked_commands가 문자열 배열이 아닙니다');
  }
  if (doc.artifacts !== undefined && !isStringArray(doc.artifacts)) {
    errors.push('artifacts가 문자열 배열이 아닙니다');
  }

  // --- merge_danger 스키마(선택): mattpocock/skills `pr` Merge Danger 어휘 흡수 —
  // 누락·null은 부재 취급(백워드 호환), 존재하면 door(one-way|two-way)·
  // blast_radius(비공백 500자 이하)를 검증해 위반은 불변식 1 구조 위반으로 fail-closed한다 ---
  let mergeDanger: MergeDanger | undefined;
  const rawMergeDanger: unknown = doc.merge_danger;
  if (rawMergeDanger !== undefined && rawMergeDanger !== null) {
    if (typeof rawMergeDanger !== 'object' || Array.isArray(rawMergeDanger)) {
      errors.push('merge_danger가 객체가 아닙니다');
    } else {
      const md = rawMergeDanger as Record<string, unknown>;
      const doorOk =
        typeof md.door === 'string' &&
        (MERGE_DANGER_DOORS as readonly string[]).includes(md.door);
      if (!doorOk) {
        errors.push(
          `merge_danger.door가 허용 값(one-way|two-way)이 아닙니다: ${JSON.stringify(md.door)}`,
        );
      }
      const blast = md.blast_radius;
      const blastNonEmpty = typeof blast === 'string' && blast.trim().length > 0;
      if (!blastNonEmpty) {
        errors.push('merge_danger.blast_radius가 빈 문자열이거나 누락됐습니다');
      } else if (blast.length > MAX_BLAST_RADIUS_LENGTH) {
        errors.push(
          `merge_danger.blast_radius가 ${MAX_BLAST_RADIUS_LENGTH}자를 초과했습니다: ${blast.length}자`,
        );
      }
      if (doorOk && blastNonEmpty && (blast as string).length <= MAX_BLAST_RADIUS_LENGTH) {
        mergeDanger = { door: md.door as MergeDangerDoor, blast_radius: blast as string };
      }
    }
  }

  // --- 불변식 2: Fork & HEAD 결속 (Replay·Stale 차단) ---
  if (typeof doc.fork_id !== 'string' || doc.fork_id !== opts.expectedForkId) {
    errors.push(
      `fork_id 불일치(Replay 의심): 문서=${JSON.stringify(doc.fork_id)}, 예상=${JSON.stringify(opts.expectedForkId)}`,
    );
  }
  if (typeof opts.expectedHead === 'string' && opts.expectedHead.trim().length > 0) {
    if (typeof doc.target_head !== 'string' || doc.target_head.trim().length === 0) {
      errors.push('expectedHead가 지정됐는데 target_head가 없습니다 (Stale Verdict 거부)');
    } else if (!headMatches(doc.target_head.trim(), opts.expectedHead.trim())) {
      errors.push(
        `target_head 불일치 (Stale Verdict): 문서=${doc.target_head}, 예상=${opts.expectedHead}`,
      );
    }
  }

  // --- 불변식 3: 모순 판정 차단 ---
  if (isKnownDecision && decision === 'pass') {
    const blocking = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
    if (blocking.length > 0) {
      errors.push(
        `pass 판정에 P0/P1 finding이 ${blocking.length}건 존재합니다 (P2/info만 허용)`,
      );
    }
  }
  if (isKnownDecision && (decision === 'fail' || decision === 'rework')) {
    if (findings.length === 0) {
      errors.push(`${decision} 판정에 findings가 없습니다 (근거 없는 FAIL/REWORK 차단)`);
    } else if (!findings.some((f) => f.evidence.trim().length > 0)) {
      errors.push(
        `${decision} 판정의 findings에 비공백 evidence가 1건도 없습니다 (근거 없는 FAIL/REWORK 차단)`,
      );
    }
  }
  if (isKnownDecision && decision === 'human') {
    if (
      typeof doc.action_required !== 'string' ||
      doc.action_required.trim().length === 0
    ) {
      errors.push('human 판정에 action_required가 비어 있거나 누락됐습니다');
    }
  }

  if (errors.length > 0) {
    return failClosed(errors);
  }

  // --- 정상 문서 정규화 반환 ---
  const document: VerdictDocument = {
    schema_version: 1,
    fork_id: doc.fork_id as string,
    decision: decision as VerdictDecision,
    reason: doc.reason as string,
    findings,
  };
  if (typeof doc.target_head === 'string') document.target_head = doc.target_head;
  if (typeof doc.action_required === 'string') document.action_required = doc.action_required;
  if (isStringArray(doc.checked_commands)) document.checked_commands = [...doc.checked_commands];
  if (isStringArray(doc.artifacts)) document.artifacts = [...doc.artifacts];
  if (mergeDanger !== undefined) document.merge_danger = mergeDanger;
  return { valid: true, effectiveDecision: document.decision, errors: [], document };
}

/**
 * `.herdr/verify/<fork_id>-verdict.json` 파일을 읽어 `validateVerdictData`로 검증한다.
 * 파일 미존재·크기 초과·읽기 실패·JSON 파싱 실패까지 전부 fail-closed(`human`)다.
 */
export function validateVerdictFile(
  filePath: string,
  opts: ValidateVerdictFileOptions,
): VerdictValidationResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_VERDICT_MAX_BYTES;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return failClosed([`verdict 파일을 찾을 수 없습니다: ${filePath}`]);
  }
  if (!stat.isFile()) {
    return failClosed([`verdict 경로가 파일이 아닙니다: ${filePath}`]);
  }
  if (stat.size > maxBytes) {
    return failClosed([`verdict 파일 크기 초과: ${stat.size}바이트 > 최대 ${maxBytes}바이트`]);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return failClosed([
      `verdict 파일 읽기 실패: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return failClosed([
      `verdict JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  return validateVerdictData(parsed, opts);
}

/** strict dispatch 모드 게이트(집행 장치) — `dg backprop --verdict-file`이 유효한
 * verdict에 `merge_danger`를 필수로 요구한다(mattpocock `pr` 어휘, verifier.md §4).
 * 무효 verdict(valid:false)는 이 게이트가 아니라 기존 fail-closed 경로(escalate_human
 * exit 3)가 처리하므로 여기선 통과시킨다. 위반 메시지를 반환하면 UsageError(exit 2)로
 * 거부하고, `null`이면 통과한다. 모드 판정(readDispatchMode)은 호출자가 주입한다. */
export function mergeDangerStrictViolation(
  mode: 'off' | 'strict',
  verdict: VerdictValidationResult,
): string | null {
  if (mode !== 'strict' || !verdict.valid) return null;
  if (verdict.document?.merge_danger !== undefined) return null;
  return 'strict dispatch 모드: verdict에 merge_danger(door: one-way|two-way, blast_radius ≤500자)가 필수다 — 검증자 계약 .herdr/roles/verifier.md §4 (해제: dg dispatch-mode off)';
}

/** Verdict SSOT 경로 — 입·출력 계약이 `.herdr/verify/`에 쌍으로 결속된다 */
export function resolveVerdictPath(repoDir: string, forkId: string): string {
  return path.join(repoDir, '.herdr', 'verify', `${forkId}-verdict.json`);
}

/** retro 실패 도구 표본 — DB 집계에서 상위 N건을 뽑아 전달한다 */
export interface RetroFailedTool {
  toolName: string;
  count: number;
  lastError?: string;
}

/**
 * `dg retro` 입력 — DB(`forks`·`decision_events`)에서 뽑은 회고 재료.
 * `sanitize`는 선택적 문자열 스크러빙 콜백(예: `redactSecrets`)으로,
 * verdict.ts가 redact.ts를 직접 import하지 않고 결합하기 위한 결합점이다.
 */
export interface RetroInput {
  forkId: string;
  projectLabel?: string;
  route: string;
  toolClass: string;
  status: string;
  attempts?: number;
  cause?: string;
  reworkCount?: number;
  reason?: string;
  topFailedTools: RetroFailedTool[];
  recommendations: string[];
  sanitize?: (s: string) => string;
}

/** 표 셀·인용에 넣기 전 whitespace 정규화 — 줄바꿈이 마크다운 구조를 깨뜨리지 않게 한다 */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 마크다운 표 셀 이스케이프 — `|`가 열 구분자로 오인되지 않게 한다 */
function escapeTableCell(text: string): string {
  return text.replaceAll('|', '\\|');
}

/**
 * 다음 시도 워커 브리프에 주입할 리트로 마크다운을 생성한다(순수 함수, 파일 쓰기 없음).
 * 구성: 제목 → 프로젝트/라우트 요약 줄 → 상태·원인·시도·재작업 표 → 실패 도구 상위
 * 5건(절단) → 다음 시도 권고(최대 3줄). 오류·사유 문자열은 sanitize(지정 시)를
 * **전체 문자열에 먼저** 적용한 뒤 잘라낸다(절단이 패턴을 가르는 누출을 막기 위해).
 */
export function buildRetroMarkdown(input: RetroInput): string {
  const clean = (s: string): string => (input.sanitize !== undefined ? input.sanitize(s) : s);

  const lines: string[] = [];
  lines.push(`# Loop Retro — ${input.forkId}`);
  lines.push('');
  if (input.projectLabel !== undefined && input.projectLabel.trim().length > 0) {
    lines.push(`- 프로젝트: ${clean(toSingleLine(input.projectLabel))}`);
  }
  lines.push(`- 라우트 / 도구 클래스: ${input.route} / ${input.toolClass}`);
  lines.push('');
  lines.push('## 요약');
  lines.push('');
  lines.push('| 항목 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| 상태 | ${escapeTableCell(clean(toSingleLine(input.status)))} |`);
  lines.push(
    `| 원인 | ${input.cause !== undefined && input.cause.trim().length > 0 ? escapeTableCell(clean(toSingleLine(input.cause))) : '-'} |`,
  );
  lines.push(`| 시도 횟수 | ${input.attempts !== undefined ? String(input.attempts) : '-'} |`);
  lines.push(
    `| 재작업 횟수 | ${input.reworkCount !== undefined ? String(input.reworkCount) : '-'} |`,
  );
  if (input.reason !== undefined && input.reason.trim().length > 0) {
    lines.push('');
    lines.push(`> reason: ${clean(toSingleLine(input.reason))}`);
  }
  lines.push('');
  lines.push('## 실패 도구 상위 5건');
  lines.push('');
  const top = input.topFailedTools.slice(0, 5);
  if (top.length === 0) {
    lines.push('(실패 도구 표본 없음)');
  } else {
    lines.push('| # | 도구 | 실패 횟수 | 최근 오류 |');
    lines.push('| --- | --- | --- | --- |');
    top.forEach((tool, index) => {
      const lastError =
        tool.lastError !== undefined && tool.lastError.trim().length > 0
          ? escapeTableCell(clean(toSingleLine(tool.lastError)).slice(0, RETRO_SNIPPET_MAX_CHARS))
          : '-';
      lines.push(
        `| ${index + 1} | ${escapeTableCell(clean(toSingleLine(tool.toolName)))} | ${tool.count} | ${lastError} |`,
      );
    });
  }
  lines.push('');
  lines.push('## 다음 시도 권고');
  lines.push('');
  const recommendations = input.recommendations.slice(0, 3).map((r) => clean(toSingleLine(r)));
  if (recommendations.length === 0) {
    lines.push('1. (권고 없음 — 원인 데이터를 보강한 뒤 다시 생성한다)');
  } else {
    recommendations.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * `git rev-parse HEAD` 동기 조회 — `dg backprop --expected-head` 인자 채움용.
 * git 부재·비 repo·실패 어느 경우든 예외를 던지지 않고 `null`을 반환한다(무예외).
 */
export function resolveGitHead(repoDir: string): string | null {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  const head = result.stdout.trim();
  return head.length > 0 ? head : null;
}
