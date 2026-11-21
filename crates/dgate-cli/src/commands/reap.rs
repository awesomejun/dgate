//! `dg reap` — 종료 자식 터미널 자동 정리(CAO kept-children 리퍼 패턴 흡수).
//!
//! `finished` 상태가 유휴 창(기본 30분) 지난 터미널만 `hc rm`으로 정리한다.
//! 살아있는 터미널은 절대 건드리지 않고, `keep` 표시가 된 터미널은 보존한다.
//! `--dry-run`은 대상 목록만 출력한다.
use std::process::Command as ProcCommand;

use serde_json::json;

use crate::args::{optional_flag, parse_int_flag, ParsedArgs};
use crate::util::prelude::*;

const DEFAULT_IDLE_MINUTES: i64 = 30;

/// 정리 대상 선별(순수 함수 — 테스트 대상): finished + keep 아님 + 유휴 창 경과.
pub fn select_reap_candidates(
    terminals: &[serde_json::Value],
    now_ms: i64,
    idle_minutes: i64,
) -> Vec<(String, Option<String>)> {
    let window_ms = idle_minutes.saturating_mul(60_000);
    terminals
        .iter()
        .filter_map(|t| {
            if t.get("state").and_then(|v| v.as_str()) != Some("finished") {
                return None;
            }
            if t.get("keep").and_then(|v| v.as_bool()).unwrap_or(false) {
                return None;
            }
            let finished_ms = t.get("finished_ms").and_then(|v| v.as_i64())?;
            if now_ms.saturating_sub(finished_ms) < window_ms {
                return None;
            }
            let address = t.get("address").and_then(|v| v.as_str())?.to_string();
            let name = t.get("name").and_then(|v| v.as_str()).map(str::to_string);
            Some((address, name))
        })
        .collect()
}

pub fn cmd_reap(args: &ParsedArgs, json: bool) -> CmdResult {
    let idle_minutes = parse_int_flag(args, "minutes", DEFAULT_IDLE_MINUTES)?.max(0);
    let dry_run = crate::args::bool_flag(args, "dry-run");
    let hc = std::env::var("HC_BIN").unwrap_or_else(|_| "hc".to_string());

    let raw = ProcCommand::new(&hc)
        .args(["ls", "--all", "--json"])
        .output()
        .map_err(|e| DgError::Fatal(format!("hc 실행 불가: {e}")))?;
    let parsed: serde_json::Value = serde_json::from_slice(&raw.stdout)
        .map_err(|e| DgError::Fatal(format!("hc ls 파싱 실패: {e}")))?;
    let terminals = parsed
        .get("terminals")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let now_ms = crate::util::now_ms();
    let targets = select_reap_candidates(&terminals, now_ms, idle_minutes);
    let mut removed = 0usize;
    let mut failed: Vec<String> = Vec::new();
    if !dry_run {
        for (addr, _) in &targets {
            match ProcCommand::new(&hc).args(["rm", addr]).output() {
                Ok(o) if o.status.success() => removed += 1,
                _ => failed.push(addr.clone()),
            }
        }
    }
    let listing: Vec<String> = targets
        .iter()
        .map(|(a, n)| format!("{a}({})", n.clone().unwrap_or_else(|| "-".into())))
        .collect();
    emit(
        json,
        format!(
            "[reap] 대상 {}건 — {}{}",
            targets.len(),
            if dry_run { "dry-run(정리 안 함)".to_string() } else { format!("정리 {removed}건") },
            if failed.is_empty() {
                String::new()
            } else {
                format!(" · 실패: {}", failed.join(","))
            }
        ),
        &json!({
            "candidates": targets.len(),
            "removed": if dry_run { 0 } else { removed },
            "dry_run": dry_run,
            "idle_minutes": idle_minutes,
            "terminals": listing,
            "failed": failed,
        }),
    );
    if !failed.is_empty() {
        return Ok(2);
    }
    Ok(0)
}

#[cfg(test)]
mod reap_tests {
    use super::*;
    use serde_json::json;

    fn term(state: &str, finished_ms_ago: i64, keep: bool, addr: &str) -> serde_json::Value {
        json!({
            "address": addr,
            "state": state,
            "keep": keep,
            "finished_ms": 1_000_000 - finished_ms_ago,
        })
    }

    #[test]
    fn selects_only_finished_aged_unkept() {
        let now = 1_000_000i64;
        let list = vec![
            term("finished", 40 * 60_000, false, "t-old"),      // 대상
            term("finished", 10 * 60_000, false, "t-fresh"),     // 유휴 창 이내
            term("live", 0, false, "t-live"),                    // 살아있음(finished_ms 가짜값도 무관)
            term("finished", 40 * 60_000, true, "t-kept"),       // keep 보존
            json!({"address": "t-nofin", "state": "finished"}),  // finished_ms 누락
        ];
        let out = select_reap_candidates(&list, now, 30);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "t-old");
        // 창 0이면 방금 종료도 대상
        let out0 = select_reap_candidates(&list, now, 0);
        assert!(out0.iter().any(|(a, _)| a == "t-fresh"));
        assert!(!out0.iter().any(|(a, _)| a == "t-nofin"));
    }
}
