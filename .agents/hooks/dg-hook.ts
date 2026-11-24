#!/usr/bin/env node
/**
 * `.agents/hooks/dg-hook.ts` — 네이티브 훅 가드·수집기 (plan-r2.1 §6.2, B4, N-NEW-1 교정판).
 *
 * 목적: `PreToolUse --guard`가 위임 채널(`HERDR_DELEGATE_MODE=hc`)·읽기전용
 * (`HERDR_READONLY=1`) 위반을 차단하고, `PostToolUse --collect`가 도구 결과를
 * SQLite WAL SSOT에 기록한다.
 *
 * 외부 연결:
 * - `.agents/hooks.json`이 `dg hook --guard|--collect`(네이티브 우선)를 호출하고,
 *   `dg` 미설치 환경에서는 `node hooks/dg-hook.ts --guard|--collect` 폴백으로 호출한다.
 *   훅 cwd는 `hooks.json`이 위치한 디렉터리(`.agents/`)이므로(N-NEW-1) 이 파일의
 *   모듈 import는 `import.meta.url` 기준 상대경로로 해석돼 어떤 cwd에서도 동작한다.
 * - stdin: `{"toolCall":{"id","name","args"},"stepIdx","conversationId","cwd","transcriptPath"[,"error"]}`.
 * - stdout: guard → `{"decision":"allow"|"deny","reason":...}` / collect → `{}`.
 *
 * 주의:
 * - guard는 `HERDR_READONLY=1`일 때 **fail-closed**: stdin JSON 파싱 실패·`toolCall`
 *   누락·내부 예외 시 `{"decision":"deny","reason":"readonly guard: fail-closed"}`(exit 0).
 * - readonly 가드(B1·N-b): 명령 문자열의 개행·CR·널바이트 다중명령, 허용 명령의
 *   쓰기·외부실행 플래그(`--output`·`--pre`·`--import` 등), 셸 실행 도구 별칭
 *   (`bash`·`shell`·`exec`·`powershell`)와 소문자 `write`·`edit`까지 전부 차단한다.
 * - collect은 **fail-open**: 어떤 파싱 실패·DB 오류·잠금(`busy_timeout=250ms`)이어도
 *   `{}` 출력 후 exit 0 — 에이전트 도구 루프를 절대 정지시키지 않는다(§3.5).
 * - DB 기록은 `HERDR_DB_WRITE === '1'` AND `DECISION_READONLY !== '1'`일 때만 수행.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDbSafe, resolveProjectIdentity } from '../../src/decision/db.ts';
import { classifyTool, isSelfInvocation, recordToolOutcome } from '../../src/decision/engine.ts';
import { redactSecrets } from '../../src/decision/redact.ts';

const DELEGATE_DENY_REASON = 'Delegation must use hc CLI in herdr-quad mode';
const FAIL_CLOSED_REASON = 'readonly guard: fail-closed';

/** hc 단일 위임 채널 강제 — `HERDR_DELEGATE_MODE=hc` 세션에서 무조건 deny */
const DELEGATE_DENY_TOOLS = new Set(['invoke_subagent', 'manage_subagents', 'swarm']);

/** `HERDR_READONLY=1` 무조건 deny — 실측 존재 도구 (§6.2/B4) */
const READONLY_DENY_TOOLS = new Set([
  'write_file',
  'edit_file',
  'manage_subagents',
  'schedule',
  'manage_task',
  'invoke_subagent',
]);
/** 타 CLI 호환 별칭 (실측 미존재 — 주석 분리 후 동일 deny, §6.2 / N-b: 소문자 write·edit 포함) */
const READONLY_DENY_TOOL_ALIASES = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'swarm',
  'write',
  'edit',
]);
/** 셸 실행 계열 도구명 — `run_command`와 동일한 읽기전용 명령 검증을 거친다 (N-b) */
const SHELL_EXEC_TOOL_NAMES = new Set(['run_command', 'bash', 'shell', 'exec', 'powershell']);

// ---------- 머지 게이트(자문 완료 관문 집행) ----------

/** advisor pass 유효 창 — pass 1건으로 이어지는 즉시 머지만 허용(30분). */
const ADVISOR_PASS_TTL_MS = 30 * 60 * 1000;

/** 병합·발행 명령 패턴 — `gh pr merge` 전체 변형 + main/master 직접 push. */
function isMergePublishCommand(raw: string): boolean {
  if (raw.includes('gh pr merge')) return true;
  if (raw.includes('git push')) {
    return [' main', ':main', '/main', ' master', ':master', '/master'].some((p) => raw.includes(p));
  }
  return false;
}

/** sublead 기본 머지 금지 명령 패턴(docs/sublead-design.md 항목 8) — `git merge` 포함. */
function isSubleadMergeCommand(raw: string): boolean {
  return isMergePublishCommand(raw) || raw.includes('git merge');
}

/** cwd(및 상위 3단계)의 `.herdr/verify/advisor-pass*` 중 최신 것이 TTL 창 안이면 true. */
function hasFreshAdvisorPass(cwd: string | undefined): boolean {
  if (!cwd) return false;
  let dir: string = cwd;
  for (let i = 0; i < 4; i++) {
    const verify = path.join(dir, '.herdr', 'verify');
    try {
      const names = fs.readdirSync(verify).filter((n) => n.startsWith('advisor-pass') && !n.endsWith('.used'));
      const now = Date.now();
      for (const n of names) {
        if (now - fs.statSync(path.join(verify, n)).mtimeMs <= ADVISOR_PASS_TTL_MS) return true;
      }
    } catch {
      /* 없음 — 상위 계속 탐색 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** 읽기전용 `run_command` 화이트리스트 (§6.2 — 안전 인자 포함 접두사 매칭) */
const READONLY_CMD_PREFIXES = [
  'git status',
  'git diff',
  'git log',
  'node --test',
  'rg',
  'ls',
  'cat',
  'wc',
  'head',
  'tail',
];
/** 파이프·리다이렉션·백그라운드·세미콜론·백틱·개행·CR·널바이트 금지 (B1) */
const FORBIDDEN_SHELL_CHARS = /[|><&;`\n\r\0]/;
/** `$(`·`${` 명령·변수 치환 금지 (B1) */
const FORBIDDEN_CMD_SUBST = /\$\(|\$\{/;
/** 셸이 명령 구분자로 해석하는 제어 문자 — 무조건 즉시 deny (B1) */
const CONTROL_CHARS = /[\n\r\0]/;
/** 변이 토큰 (§6.2 명시 목록 + 자주 쓰이는 쓰기 계열) */
const MUTATING_TOKENS = new Set([
  'rm',
  'mv',
  'cp',
  'chmod',
  'chown',
  'chgrp',
  'tee',
  'dd',
  'sed',
  'npm',
  'npx',
  'ln',
  'truncate',
  'mkfifo',
  'mknod',
  'install',
  'kill',
  'pkill',
  'sudo',
  'su',
  'mount',
  'umount',
  'diskutil',
  'hdiutil',
  'launchctl',
  'defaults',
  'crontab',
  'brew',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pip',
  'pip3',
  'gem',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'open',
  'osascript',
  'patch',
  'sqlite3',
]);

/**
 * 허용 명령별 금지 플래그 (B1) — 토큰이 플래그와 동일하거나 `플래그=` 접두면 deny.
 * 쓰기(`--output`·`-o`)·외부 실행(`--pre`·`--exec`·`--ext-diff`)·설정/코드 주입
 * (`-c`·`--import`·`-e`)처럼 읽기전용 의도를 무력화하는 인자만 나열한다.
 * `-c`는 git에서만 위험(rg -c 카운트·wc -c 바이트 수는 무해)하므로 명령별 스코프.
 */
const DANGEROUS_FLAGS: Record<string, readonly string[]> = {
  git: ['--output', '-o', '-c', '--ext-diff', '--exec', '--upload-pack', '--pager', '--git-dir'],
  rg: ['--pre', '--pre-glob'],
  node: ['--import', '--require', '-r', '-e', '--eval', '-p', '--print', '--loader', '--experimental-loader'],
  ls: ['-o', '--output'],
  cat: ['-o', '--output'],
  wc: ['-o', '--output'],
  head: ['-o', '--output'],
  tail: ['-o', '--output'],
};

function hasDangerousFlag(base: string, tokens: readonly string[]): boolean {
  const flags = DANGEROUS_FLAGS[base];
  if (!flags) return false;
  return tokens.some((t) => flags.some((f) => t === f || t.startsWith(`${f}=`)));
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function allow(): Record<string, unknown> {
  return { decision: 'allow' };
}

function deny(reason: string): Record<string, unknown> {
  return { decision: 'deny', reason };
}

const DENY_MULTILINE_REASON = 'readonly guard: multiline/control char denied';
const DENY_NOT_WHITELISTED_REASON = 'readonly guard: command not whitelisted';

/**
 * `run_command`·셸 실행 도구용 읽기전용 판정 (§6.2, B1): ① 개행·CR·널바이트는
 * 무조건 즉시 deny(별도 reason), ② 화이트리스트 접두사 매칭 AND 파이프/리다이렉션/
 * 백그라운드/명령 치환/변이 토큰 부재, ③ 허용 명령이라도 쓰기·외부실행 플래그
 * (`--output`·`--pre`·`--import` 등) 포함 시 deny일 때만 allow한다.
 */
function readonlyCommandVerdict(cmd: string): { allowed: boolean; reason?: string } {
  if (CONTROL_CHARS.test(cmd)) return { allowed: false, reason: DENY_MULTILINE_REASON };
  const trimmed = cmd.trim();
  if (!trimmed) return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  if (FORBIDDEN_SHELL_CHARS.test(trimmed) || FORBIDDEN_CMD_SUBST.test(trimmed)) {
    return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  }
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0]!;
  const base = first.split('/').pop()!;
  if (MUTATING_TOKENS.has(base)) return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  if (base === 'git' && !/^git\s+(status|diff|log)(\s|$)/.test(trimmed)) {
    return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  }
  if (base === 'node' && !/^node\s+--test(\s|$)/.test(trimmed)) {
    return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  }
  if (!READONLY_CMD_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(`${p} `))) {
    return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  }
  if (hasDangerousFlag(base, tokens.slice(1))) {
    return { allowed: false, reason: DENY_NOT_WHITELISTED_REASON };
  }
  return { allowed: true };
}

interface HookInput {
  toolCall?: { id?: string | number; name?: string; args?: Record<string, unknown> };
  stepIdx?: number;
  conversationId?: string;
  cwd?: string;
  transcriptPath?: string;
  error?: unknown;
  isRetry?: boolean;
}

function readStdinJson(): HookInput {
  const raw = fs.readFileSync(0, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('hook stdin is not an object');
  }
  return parsed as HookInput;
}

// ---------- --guard (PreToolUse) ----------

function runGuard(): void {
  const delegateHc = process.env.HERDR_DELEGATE_MODE === 'hc';
  const readonlyMode = process.env.HERDR_READONLY === '1';

  let input: HookInput;
  try {
    input = readStdinJson();
  } catch {
    // B4: readonly 가드는 fail-closed. 비-readonly 세션은 fail-open(허용)으로 둔다.
    emit(readonlyMode ? deny(FAIL_CLOSED_REASON) : allow());
    return;
  }

  try {
    const toolCall = input.toolCall;
    const name = toolCall?.name;
    if (delegateHc && typeof name === 'string' && DELEGATE_DENY_TOOLS.has(name)) {
      emit(deny(DELEGATE_DENY_REASON));
      return;
    }
    if (readonlyMode) {
      if (!toolCall || typeof name !== 'string' || !name) {
        emit(deny(FAIL_CLOSED_REASON));
        return;
      }
      if (READONLY_DENY_TOOLS.has(name) || READONLY_DENY_TOOL_ALIASES.has(name)) {
        emit(deny(`readonly guard: tool "${name}" is denied`));
        return;
      }
      if (SHELL_EXEC_TOOL_NAMES.has(name)) {
        // run_command·bash·shell·exec·powershell 동일 검증 (N-b) — 인자 키도
        // CommandLine/command/cmd 셋 전부 동일하게 취급해 키별 판정 편차를 없앤다(B1).
        const args = toolCall.args ?? {};
        const raw = args.CommandLine ?? args.command ?? args.cmd;
        if (typeof raw !== 'string') {
          emit(deny(DENY_NOT_WHITELISTED_REASON));
          return;
        }
        const verdict = readonlyCommandVerdict(raw);
        emit(verdict.allowed ? allow() : deny(verdict.reason ?? DENY_NOT_WHITELISTED_REASON));
        return;
      }
      emit(allow());
      return;
    }
    // sublead 기본 머지 금지(docs/sublead-design.md 항목 8): HERDR_MERGE_GATE·advisor pass와 무관 차단
    const subleadMode = (process.env.HERDR_ROLE ?? '').trim().toLowerCase() === 'sublead';
    if (subleadMode && typeof name === 'string' && SHELL_EXEC_TOOL_NAMES.has(name)) {
      const args = toolCall?.args ?? {};
      const raw = args.CommandLine ?? args.command ?? args.cmd;
      if (typeof raw === 'string' && isSubleadMergeCommand(String(raw))) {
        emit(
          deny(
            'sublead merge guard: sublead 세션은 머지·main/master 푸시 금지 — 완료 보고는 READY_PR 핸드오프로 최상위 리드에 전달하세요'
          )
        );
        return;
      }
    }
    // 머지 게이트(완료 관문 집행): advisor pass 없는 병합·발행 명령 차단
    if (process.env.HERDR_MERGE_GATE === '1' && typeof name === 'string' && SHELL_EXEC_TOOL_NAMES.has(name)) {
      const args = toolCall?.args ?? {};
      const raw = args.CommandLine ?? args.command ?? args.cmd;
      if (typeof raw === 'string' && isMergePublishCommand(String(raw)) && !hasFreshAdvisorPass(input.cwd)) {
        emit(deny('merge gate: 최근 advisor pass 없음 — 완료 관문 자문(advisor-g3) 판정 후 재시도 (해제: HERDR_MERGE_GATE 미설정)'));
        return;
      }
    }
    emit(allow());
  } catch {
    emit(readonlyMode ? deny(FAIL_CLOSED_REASON) : allow());
  }
}

// ---------- --collect (PostToolUse, fail-open) ----------

function runCollect(): void {
  try {
    if (process.env.HERDR_DB_WRITE !== '1' || process.env.DECISION_READONLY === '1') {
      emit({});
      return;
    }
    const input = readStdinJson();
    const toolCall = input.toolCall;
    const toolName = toolCall?.name;
    if (!toolCall || typeof toolName !== 'string' || !toolName) {
      emit({});
      return;
    }
    const args = toolCall.args ?? {};
    const commandLine = redactSecrets(String(args.CommandLine ?? args.command ?? ''));
    // B6 자기 호출 제외: commandLine뿐 아니라 path 계열 인자에 dg.ts/dg-hook.ts가
    // 들어도 기록하지 않는다(파일 읽기 자체가 자기 호출인 케이스).
    const selfText = [
      toolName,
      commandLine,
      args.path,
      args.file_path,
      args.filePath,
      args.target_file,
      args.targetFile,
    ]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    if (isSelfInvocation(selfText)) {
      emit({});
      return;
    }
    const convId = typeof input.conversationId === 'string' ? input.conversationId : null;
    const dedupeKey = `hook:${String(convId)}:${String(toolCall.id)}`;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const identity = resolveProjectIdentity(cwd);
    const { route, toolClass } = classifyTool(toolName, args, input.isRetry === true);
    const ok = input.error === undefined || input.error === null || input.error === false;
    const errorSnippet =
      input.error === undefined || input.error === null || input.error === false
        ? null
        : typeof input.error === 'string'
          ? redactSecrets(input.error).slice(0, 400)
          : redactSecrets(JSON.stringify(input.error)).slice(0, 400);

    // 훅 busy_timeout=250ms — 3s 훅 타임아웃 내 즉시 폴백(§3.2/N1)
    const db: DatabaseSync | null = openDbSafe(undefined, { busyTimeoutMs: 250 });
    if (!db) {
      emit({});
      return;
    }
    try {
      // 자기 호출 제외(B6)는 recordToolOutcome 내부 isSelfInvocation 판정에 위임한다.
      recordToolOutcome(db, {
        projectId: identity.projectId,
        projectLabel: identity.projectLabel,
        route,
        toolClass,
        toolName,
        ok,
        weight: 1,
        conversationId: convId,
        step: typeof input.stepIdx === 'number' ? input.stepIdx : null,
        errorSnippet,
        source: 'hook',
        dedupeKey,
        commandLine,
      });
      if (convId) {
        // markHookCoverage(§5.2): transcriptMapper 중복 쓰기 금지 표지
        db.prepare(
          `INSERT INTO session_cursor
             (conversation_id, project_id, has_hook_coverage, session_consec_err, updated_at_ms)
           VALUES (?, ?, 1, 0, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET has_hook_coverage = 1, updated_at_ms = ?`
        ).run(convId, identity.projectId, Date.now(), Date.now());
      }
    } finally {
      try {
        db.close();
      } catch {
        /* 무시 */
      }
    }
    emit({});
  } catch {
    try {
      emit({});
    } catch {
      /* 무시 */
    }
  }
}

// ---------- entry ----------

const mode = process.argv[2];
if (mode === '--guard') {
  runGuard();
} else if (mode === '--collect') {
  runCollect();
} else {
  // 알 수 없는 호출 — 가드 경로가 아니므로 fail-open
  emit({});
}
process.exit(0);
