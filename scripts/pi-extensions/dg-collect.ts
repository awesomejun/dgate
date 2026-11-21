/**
 * dg-collect — pi 세션의 도구 사용을 dgate SSOT(decision.db)에 자동 수집.
 *
 * 목적: 판단 루프의 데이터 기반. 모든 pi 세션(리드·워커 포함)이 도구를 쓸 때마다
 * `dg hook --collect`(PATH 셸 — Rust 우선)로 도구별 성공/실패 샘플을 쌓는다.
 * 멱등(dedupe toolCall.id)·fail-open(수집 실패가 도구 루프를 절대 멈추지 않음).
 *
 * 외부 연결: dgate `.agents/hooks/dg-hook.ts`와 동일 stdin 계약 —
 *   {"toolCall":{"id","name","args"},"conversationId","cwd","error"}
 *
 * 주의:
 * - guard(차단)는 하지 않는다. 전역 수집은 관측 전용이며, 읽기전용 강제는
 *   워커 모드 세션의 `.agents/hooks.json` 가드가 담당한다(역할 분리).
 * - 결과 패치를 반환하지 않는다(return void) — 도구 결과를 절대 수정하지 않는다.
 */
import { spawn } from "node:child_process";

const DG_BIN = process.env["DG_COLLECT_BIN"] ?? "dg";

interface ToolResultEvent {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
}

interface PiApi {
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: unknown) => void): void;
}

function errorSnippet(event: ToolResultEvent): string | undefined {
  if (!event.isError) return undefined;
  const content = event.content;
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : "")).join(" ")
    : String(content ?? "");
  return text.slice(0, 200);
}

export default function (pi: PiApi): void {
  pi.on("tool_result", (event) => {
    try {
      if (!event.toolCallId || !event.toolName) return;
      const payload = JSON.stringify({
        toolCall: { id: event.toolCallId, name: event.toolName, args: event.input ?? {} },
        cwd: process.cwd(),
        error: errorSnippet(event),
      });
      const child = spawn(DG_BIN, ["hook", "--collect"], {
        env: { ...process.env, HERDR_DB_WRITE: "1" },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", () => {}); // dg 부재·PATH 이상 — 조용히 스킵
      child.stdin.on("error", () => {});
      child.stdin.write(payload);
      child.stdin.end();
    } catch {
      // fail-open — 수집 실패가 도구 결과에 영향을 주지 않는다
    }
  });
}
