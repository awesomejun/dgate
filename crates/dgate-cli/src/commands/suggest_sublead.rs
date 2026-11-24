//! `dg suggest-sublead` — 3축 DB 신호 기반 sublead 도입 제안(LLM 호출 0, 읽기전용).
use serde_json::json;

use crate::args::{optional_flag, ParsedArgs};
use crate::util::prelude::*;
use dgate_core::db::{open_db_safe, resolve_project_identity, OpenDbOptions};
use dgate_core::suggest_sublead::{
    collect_sublead_signals_from_db, evaluate_proactive_scopes, evaluate_sublead_suggestion,
    SubleadSuggestSignals,
};

pub fn cmd_suggest_sublead(args: &ParsedArgs, json: bool) -> CmdResult {
    let max_subleads_cap = optional_flag(args, "max-subleads")
        .and_then(|v| v.parse::<i64>().ok())
        .or_else(|| {
            std::env::var("DGATE_MAX_SUBLEADS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
        });

    // 사전 분해 모드: --scopes가 주어지면 DB를 열지 않고 순수 판정만 수행한다.
    if let Some(scopes_raw) = optional_flag(args, "scopes") {
        let scopes: Vec<String> = scopes_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let result = evaluate_proactive_scopes(&scopes, max_subleads_cap);
        let human = format!("[suggest-sublead] {}", result.summary);
        emit(json, human, &json!(result));
        return Ok(0);
    }

    let project_flag = optional_flag(args, "project");
    let project_id = project_flag
        .as_deref()
        .map(|p| resolve_project_identity(std::path::Path::new(p)).project_id);
    let active_workers_override = optional_flag(args, "active-workers")
        .and_then(|v| v.parse::<i64>().ok());

    let signals = match open_db_safe(
        db_flag(args).as_deref(),
        OpenDbOptions { read_only: true, busy_timeout_ms: Some(3000) },
    ) {
        Some(conn) => collect_sublead_signals_from_db(
            &conn,
            project_id.as_deref(),
            active_workers_override,
            max_subleads_cap,
            now_ms(),
        )
        .unwrap_or_else(|_| SubleadSuggestSignals {
            active_wrap_workers: active_workers_override.unwrap_or(0),
            max_subleads_cap,
            ..Default::default()
        }),
        None => SubleadSuggestSignals {
            active_wrap_workers: active_workers_override.unwrap_or(0),
            max_subleads_cap,
            ..Default::default()
        },
    };

    let result = evaluate_sublead_suggestion(signals);
    let human = format!("[suggest-sublead] {}", result.summary);
    emit(json, human, &json!(result));
    Ok(0)
}
