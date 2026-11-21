//! `dg send <addr> <message…>` — 제출 확인·재전송 내장 메시징(CAO 인박스 패턴 흡수).
//!
//! `hc send`는 붙여넣기가 TUI에 삼켜질 수 있어, 보낸 사람이 영원히 대기하는 결함이
//! 있다(CAO issue #78). 이 명령은 (1) 전송 전 스냅샷(turn·status·화면 꼬리) →
//! (2) `hc send` → (3) 처리 시작 증거 폴링(turn 증가·status 전환·화면 꼬리 변화) →
//! (4) 미확인 시 재전송(기본 3회) — 최종 미확인은 exit 1로 호출자에게 신호.
//!
//! 주의:
//! - 증거 기준은 "이 전송의 처리 시작"이지 응답 완료가 아니다(그건 hc wait 영역).
//! - `HC_BIN` 환경변수로 hc 실행 파일 경로를 오버라이드할 수 있다.
use std::process::Command as ProcCommand;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::args::{optional_flag, parse_int_flag, ParsedArgs};
use crate::util::prelude::*;

/// 1회 전송당 제출 확인 폴링 창(초 단위 상수는 패턴 출처와 동일하게 8s).
const CONFIRM_TIMEOUT_MS: u64 = 8_000;
const POLL_INTERVAL_MS: u64 = 1_000;
const DEFAULT_MAX_ATTEMPTS: i64 = 3;

fn hc_bin() -> String {
    std::env::var("HC_BIN").unwrap_or_else(|_| "hc".to_string())
}

fn hc_output(args: &[&str]) -> Option<String> {
    let out = ProcCommand::new(hc_bin()).args(args).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 제출 확인 스냅샷 — turn·status·화면 꼬리 3종.
#[derive(Clone, Debug, PartialEq)]
pub struct SendSnap {
    pub turn: i64,
    pub status: Option<String>,
    pub tail: String,
}

pub fn take_snapshot(addr: &str) -> Option<SendSnap> {
    let raw = hc_output(&["get", addr, "--json"])?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let tail = hc_output(&["read", addr, "--lines", "3"]).unwrap_or_default();
    Some(SendSnap {
        turn: v.get("turn").and_then(|t| t.as_i64()).unwrap_or(0),
        status: v.get("status").and_then(|s| s.as_str()).map(str::to_string),
        tail,
    })
}

/// 처리 시작 증거: turn 증가 · status 전환 · 화면 꼬리 변화(메시지 등장 포함).
pub fn delivery_confirmed(before: &SendSnap, after: &SendSnap, needle: &str) -> bool {
    if after.turn > before.turn {
        return true;
    }
    if after.status != before.status && after.status.is_some() {
        return true;
    }
    if after.tail != before.tail {
        return true;
    }
    // 셸 계열 터미널 폴백 — 화면에 메시지 흔적이 보이면 전달은 확인된 것.
    let head: String = needle.chars().take(40).collect();
    !head.trim().is_empty() && after.tail.contains(head.trim())
}

pub fn cmd_send(args: &ParsedArgs, json: bool) -> CmdResult {
    let to = optional_flag(args, "to").filter(|s| !s.is_empty()).ok_or_else(|| {
        DgError::Usage(crate::args::UsageError(
            "usage: dg send <addr> <message…> [--attempts N] [--json]".to_string(),
        ))
    })?;
    let message = optional_flag(args, "message").unwrap_or_default();
    if message.trim().is_empty() {
        return Err(DgError::Usage(crate::args::UsageError(
            "dg send: 메시지가 비어 있다".to_string(),
        )));
    }
    let max_attempts = parse_int_flag(args, "attempts", DEFAULT_MAX_ATTEMPTS)?.max(1);

    let before = take_snapshot(&to);
    let mut attempts = 0i64;
    let mut last_error = String::new();
    while attempts < max_attempts {
        attempts += 1;
        match ProcCommand::new(hc_bin()).args(["send", &to, &message]).output() {
            Ok(o) if !o.status.success() => {
                last_error = format!(
                    "hc send 실패: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                );
                break; // hc 자체 오류 — 재시도 무의미
            }
            Err(e) => {
                last_error = format!("hc 실행 불가: {e}");
                break;
            }
            _ => {}
        }
        let deadline = Instant::now() + Duration::from_millis(CONFIRM_TIMEOUT_MS);
        loop {
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            if let (Some(b), Some(a)) = (&before, take_snapshot(&to)) {
                if delivery_confirmed(b, &a, &message) {
                    emit(
                        json,
                        format!("[send] {to} 전달 확인(시도 {attempts}) — 처리 시작 관측됨"),
                        &json!({"to": to, "confirmed": true, "attempts": attempts}),
                    );
                    return Ok(0);
                }
            }
            if Instant::now() >= deadline {
                break;
            }
        }
    }
    emit(
        json,
        format!("[send] {to} 전달 미확인(시도 {attempts}) {last_error}"),
        &json!({"to": to, "confirmed": false, "attempts": attempts, "last_error": last_error}),
    );
    Ok(1)
}

#[cfg(test)]
mod send_tests {
    use super::*;

    fn snap(turn: i64, status: Option<&str>, tail: &str) -> SendSnap {
        SendSnap {
            turn,
            status: status.map(str::to_string),
            tail: tail.to_string(),
        }
    }

    #[test]
    fn confirm_signals() {
        let b = snap(3, Some("idle"), "screen-a");
        // turn 증가
        assert!(delivery_confirmed(&b, &snap(4, Some("idle"), "screen-a"), "msg"));
        // status 전환
        assert!(delivery_confirmed(&b, &snap(3, Some("working"), "screen-a"), "msg"));
        // 화면 꼬리 변화
        assert!(delivery_confirmed(&b, &snap(3, Some("idle"), "screen-b"), "msg"));
        // 셸 폴백 — 화면에 메시지 등장
        assert!(delivery_confirmed(&b, &snap(3, None, "> dg-send-test-42 확인"), "dg-send-test-42"));
        // 무변화
        assert!(!delivery_confirmed(&b, &snap(3, Some("idle"), "screen-a"), "msg"));
        // 빈 needle 은 꼬리 히트로 오인 금지
        assert!(!delivery_confirmed(&b, &snap(3, Some("idle"), "screen-a"), "   "));
    }
}
