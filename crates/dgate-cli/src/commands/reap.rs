//! `dg reap` — 종료 자식 터미널 자동 정리(CAO kept-children 리퍼 패턴 흡수).
//!
//! `finished` 상태가 유휴 창(기본 30분) 지난 터미널만 `hc rm`으로 정리한다.
//! 살아있는 터미널은 절대 건드리지 않고, `keep` 표시가 된 터미널은 보존한다.
//! `--dry-run`은 대상 목록만 출력한다.
use std::collections::{HashMap, HashSet};
use std::process::Command as ProcCommand;

use serde_json::json;

use crate::args::{optional_flag, parse_int_flag, ParsedArgs, UsageError};
use crate::util::prelude::*;

const DEFAULT_IDLE_MINUTES: i64 = 30;
const MAX_ANCESTOR_DEPTH: usize = 32;

/// 터미널 `addr`의 `parent` 체인을 따라가 `owner_root`의 하위(진부분트리)인지 판정한다.
/// 자기 자신(`addr == owner_root`)은 포함하지 않으며, 순환 참조는 depth/visited로 차단한다.
fn is_descendant_of(
    addr: &str,
    owner_root: &str,
    parent_map: &HashMap<String, String>,
) -> bool {
    if addr == owner_root {
        return false;
    }
    let mut cur = addr;
    let mut visited: HashSet<&str> = HashSet::new();
    for _ in 0..MAX_ANCESTOR_DEPTH {
        if !visited.insert(cur) {
            return false;
        }
        let Some(parent) = parent_map.get(cur) else {
            return false;
        };
        if parent == owner_root {
            return true;
        }
        cur = parent.as_str();
    }
    false
}

/// 정리 대상 선별(순수 함수 — 테스트 대상): finished + keep 아님 + 유휴 창 경과.
/// `owner_root`가 `Some(addr)`이면 해당 주소의 조상 트리 하위 터미널만 선별한다(sublead 스코핑).
pub fn select_reap_candidates_scoped(
    terminals: &[serde_json::Value],
    now_ms: i64,
    idle_minutes: i64,
    owner_root: Option<&str>,
) -> Vec<(String, Option<String>)> {
    let window_ms = idle_minutes.saturating_mul(60_000);
    let parent_map: HashMap<String, String> = if owner_root.is_some() {
        terminals
            .iter()
            .filter_map(|t| {
                let addr = t.get("address").and_then(|v| v.as_str())?;
                let parent = t
                    .get("parent")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())?;
                Some((addr.to_string(), parent.to_string()))
            })
            .collect()
    } else {
        HashMap::new()
    };
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
            if let Some(root) = owner_root {
                if !is_descendant_of(&address, root, &parent_map) {
                    return None;
                }
            }
            let name = t.get("name").and_then(|v| v.as_str()).map(str::to_string);
            Some((address, name))
        })
        .collect()
}

/// 정리 대상 선별(기존 전역 API 보존 — `owner_root = None`).
pub fn select_reap_candidates(
    terminals: &[serde_json::Value],
    now_ms: i64,
    idle_minutes: i64,
) -> Vec<(String, Option<String>)> {
    select_reap_candidates_scoped(terminals, now_ms, idle_minutes, None)
}

pub fn cmd_reap(args: &ParsedArgs, json: bool) -> CmdResult {
    let idle_minutes = parse_int_flag(args, "minutes", DEFAULT_IDLE_MINUTES)?.max(0);
    let dry_run = crate::args::bool_flag(args, "dry-run");
    let role = optional_flag(args, "role")
        .or_else(|| std::env::var("HERDR_ROLE").ok())
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let owner_root: Option<String> = if role == "sublead" {
        let owner = optional_flag(args, "owner")
            .or_else(|| std::env::var("HC_TERMINAL_ID").ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(root) = owner else {
            return Err(DgError::Usage(UsageError(
                "sublead reap 거부: --owner 또는 HC_TERMINAL_ID가 필요합니다 (전역 정리 차단)"
                    .to_string(),
            )));
        };
        Some(root)
    } else {
        optional_flag(args, "owner")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
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
    let targets = select_reap_candidates_scoped(
        &terminals,
        now_ms,
        idle_minutes,
        owner_root.as_deref(),
    );
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

    #[test]
    fn scoped_reap_only_touches_sublead_descendants() {
        let now = 1_000_000i64;
        let aged = now - 40 * 60_000;
        let list = vec![
            json!({"address": "t-subA", "state": "finished", "keep": false, "finished_ms": aged}),
            json!({"address": "t-subA-child", "parent": "t-subA", "state": "finished", "keep": false, "finished_ms": aged}),
            json!({"address": "t-subA-grand", "parent": "t-subA-child", "state": "finished", "keep": false, "finished_ms": aged}),
            json!({"address": "t-subB-child", "parent": "t-subB", "state": "finished", "keep": false, "finished_ms": aged}),
            json!({"address": "t-orphan", "state": "finished", "keep": false, "finished_ms": aged}),
            json!({"address": "t-cyc1", "parent": "t-cyc2", "state": "finished", "keep": false, "finished_ms": aged}),
            json!({"address": "t-cyc2", "parent": "t-cyc1", "state": "finished", "keep": false, "finished_ms": aged}),
        ];
        let out = select_reap_candidates_scoped(&list, now, 30, Some("t-subA"));
        let addrs: Vec<&str> = out.iter().map(|(a, _)| a.as_str()).collect();
        assert_eq!(addrs, vec!["t-subA-child", "t-subA-grand"]);
    }
}
