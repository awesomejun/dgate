//! `dg suggest-session` — 하이브리드 세션 수명 정책 판정 (LLM 호출 0, 읽기전용).
use serde_json::json;

use crate::args::{bool_flag, optional_flag, ParsedArgs};
use crate::util::prelude::*;
use dgate_core::db::{open_db_safe, resolve_project_identity, OpenDbOptions};
use dgate_core::session_policy::{
    collect_session_metrics_from_db, evaluate_session_policy, SessionPolicyInput,
};

fn opt_usize(args: &ParsedArgs, key: &str) -> Result<Option<usize>, DgError> {
    match optional_flag(args, key) {
        None => Ok(None),
        Some(raw) => raw.trim().parse::<usize>().map(Some).map_err(|_| {
            DgError::Usage(crate::args::UsageError(format!(
                "invalid --{key} \"{raw}\" (expected non-negative integer)"
            )))
        }),
    }
}

pub fn cmd_suggest_session(args: &ParsedArgs, json: bool) -> CmdResult {
    let role = optional_flag(args, "role").unwrap_or_else(|| "coder".to_string());
    let door = optional_flag(args, "door");
    let estimated_files = opt_usize(args, "files")?.unwrap_or(0);
    let same_domain = bool_flag(args, "same-domain");
    let queued_similar = opt_usize(args, "queued")?.unwrap_or(1);
    let session_tasks = opt_usize(args, "session-tasks")?.unwrap_or(0);
    let session_turns = opt_usize(args, "session-turns")?.unwrap_or(0);
    let compacted = bool_flag(args, "compacted");
    let max_warm_tasks = opt_usize(args, "max-warm-tasks")?;
    let max_warm_turns = opt_usize(args, "max-warm-turns")?;
    let explicit_errors = opt_usize(args, "consecutive-errors")?;

    let project_id = optional_flag(args, "project")
        .as_deref()
        .map(|p| resolve_project_identity(std::path::Path::new(p)).project_id);

    let (first_pass_rate, first_pass_samples, db_errors) = match open_db_safe(
        db_flag(args).as_deref(),
        OpenDbOptions {
            read_only: true,
            busy_timeout_ms: Some(3000),
        },
    ) {
        Some(conn) => collect_session_metrics_from_db(&conn, project_id.as_deref()),
        None => (None, 0, 0),
    };

    let input = SessionPolicyInput {
        role,
        door,
        estimated_files,
        same_domain,
        queued_similar,
        consecutive_errors: explicit_errors.unwrap_or(db_errors),
        session_tasks,
        session_turns,
        compacted,
        first_pass_rate,
        first_pass_samples,
        max_warm_tasks,
        max_warm_turns,
    };

    let verdict = evaluate_session_policy(&input);
    let human = format!("[suggest-session] {}", verdict.summary);
    emit(json, human, &json!(verdict));
    Ok(0)
}
