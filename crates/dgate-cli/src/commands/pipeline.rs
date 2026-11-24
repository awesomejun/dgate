//! `dg pipeline init|step|status` — 결정적 sublead 파이프라인 상태머신(0토큰).
//!
//! `dgate_core::pipeline`의 순수 상태머신을 파일 영속 상태(`.herdr/pipelines/<run_id>.json`)
//! 위에서 구동한다 — 상주 sublead LLM 없이 `coder → verifier → rework/advisor-g3 → READY_PR`
//! 전이를 계산하고, 재시도 소진·human 판정 등 에스컬레이션만 sublead LLM 단발 기동으로 넘긴다.
//!
//! 종료 코드:
//! - 0: 정상 전이(status 포함) / 1: 상태 파일 입출력 실패
//! - 2: 사용법 오류(필수 플래그 누락·알 수 없는 이벤트/서브커맨드·상태 파일 부재)
//! - 3: 파이프라인이 `Escalated`에 도달(fail-closed — sublead 단발 기동 필요 신호)
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::args::{bool_flag, optional_flag, parse_int_flag, require_flag, ParsedArgs, UsageError};
use crate::util::prelude::*;
use dgate_core::pipeline::{
    self, check_scope_glob, PipelineAction, PipelineEvent, PipelineInit, PipelinePhase,
};
use dgate_core::verdict::{self, ValidateVerdictOptions};

pub fn cmd_pipeline(sub: Option<&str>, args: &ParsedArgs, json: bool) -> CmdResult {
    match sub {
        Some("init") => cmd_init(args, json),
        Some("step") => cmd_step(args, json),
        Some("status") => cmd_status(args, json),
        other => Err(DgError::Usage(UsageError(format!(
            "unknown pipeline subcommand: {} (allowed: init|step|status)",
            other.unwrap_or("(missing)")
        )))),
    }
}

/// `--state-dir` 또는 기본 `.herdr/pipelines`(cwd 상대).
fn state_dir(args: &ParsedArgs) -> PathBuf {
    optional_flag(args, "state-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(pipeline::DEFAULT_STATE_DIR))
}

fn cmd_init(args: &ParsedArgs, json: bool) -> CmdResult {
    let fork_id = require_flag(args, "fork")?;
    let brief = require_flag(args, "brief")?;
    let branch = require_flag(args, "branch")?;
    let worktree = optional_flag(args, "worktree");
    let scope = optional_flag(args, "scope");
    let max_reworks = parse_int_flag(args, "max-reworks", pipeline::DEFAULT_MAX_REWORKS as i64)?;
    if max_reworks < 0 {
        return Err(DgError::Usage(UsageError(
            "--max-reworks must be >= 0".to_string(),
        )));
    }
    // 모델 계약 — 플래그 > 환경변수 > 빈 문자열(미지정은 이종 검사에서 fail-closed).
    let coder_model = optional_flag(args, "coder-model")
        .or_else(|| std::env::var("HERDR_CODER_MODEL").ok())
        .unwrap_or_default();
    let verifier_model = optional_flag(args, "verifier-model")
        .or_else(|| std::env::var("HERDR_VERIFIER_MODEL").ok())
        .unwrap_or_default();

    let (state, action) = pipeline::init_pipeline(&PipelineInit {
        fork_id: fork_id.clone(),
        run_id: None,
        brief_path: brief.clone(),
        worktree_path: worktree.clone(),
        branch: branch.clone(),
        scope_glob: scope.clone(),
        max_reworks: max_reworks as u32,
        coder_model,
        verifier_model,
    });

    let dir = state_dir(args);
    let state_file = match pipeline::save_state(&dir, &state) {
        Ok(p) => p,
        Err(e) => {
            emit(
                json,
                format!("[pipeline init] {fork_id} state 저장 실패: {e}"),
                &json!({
                    "action": "init",
                    "fork_id": fork_id,
                    "saved": false,
                    "errors": [e],
                }),
            );
            return Ok(1);
        }
    };

    // 스코프 가드 — 브리프/워크트리 등 선언된 대상 경로가 도메인 밖이면 경고(비치명적).
    let mut targets = vec![brief.as_str()];
    if let Some(w) = &worktree {
        targets.push(w.as_str());
    }
    let scope_warnings = scope
        .as_deref()
        .map(|s| check_scope_glob(s, &targets))
        .unwrap_or_default();
    for w in &scope_warnings {
        crate::util::eprint_line(&format!("[dg pipeline] scope warning: {w}"));
    }

    emit(
        json,
        format!(
            "[pipeline init] {fork_id} → {} next={}",
            state.phase.as_str(),
            action.label()
        ),
        &json!({
            "action": "init",
            "fork_id": fork_id,
            "run_id": state.run_id,
            "phase": state.phase.as_str(),
            "state_file": state_file,
            "next_action": action,
            "scope_warnings": scope_warnings,
        }),
    );
    Ok(0)
}

fn cmd_step(args: &ParsedArgs, json: bool) -> CmdResult {
    let fork_id = require_flag(args, "fork")?;
    let event_name = require_flag(args, "event")?;
    let dir = state_dir(args);
    let state = pipeline::load_state(&dir, &fork_id)
        .map_err(|e| DgError::Usage(UsageError(e)))?;

    let head = optional_flag(args, "head");
    let reason = optional_flag(args, "reason");
    let mut verdict_errors: Vec<String> = Vec::new();
    let event = match event_name.as_str() {
        "coder-ok" => PipelineEvent::CoderExited {
            exit_code: 0,
            head_sha: head.clone(),
            stalled: false,
        },
        "coder-fail" => PipelineEvent::CoderExited {
            exit_code: 1,
            head_sha: head.clone(),
            stalled: bool_flag(args, "stalled"),
        },
        "verdict" => {
            let vf = require_flag(args, "verdict-file")?;
            // fail-closed — 무효 verdict는 effective_decision=Human → 즉시 에스컬레이션.
            // HEAD 결속은 --head > 상태 파일의 head_sha 순으로 적용한다.
            let v = verdict::validate_verdict_file(
                Path::new(&vf),
                &ValidateVerdictOptions {
                    expected_fork_id: state.fork_id.clone(),
                    expected_head: head.clone().or_else(|| state.head_sha.clone()),
                },
            );
            verdict_errors = v.errors.clone();
            PipelineEvent::VerdictReceived {
                decision: v.effective_decision,
                verdict_path: vf,
            }
        }
        "g3-pass" => {
            let pr = match optional_flag(args, "pr") {
                Some(raw) => Some(raw.parse::<u64>().map_err(|_| {
                    DgError::Usage(UsageError(format!("--pr must be an integer: {raw}")))
                })?),
                None => None,
            };
            PipelineEvent::AdvisorG3Result {
                passed: true,
                pr_number: pr,
                reason: reason.clone(),
            }
        }
        "g3-fail" => PipelineEvent::AdvisorG3Result {
            passed: false,
            pr_number: None,
            reason: reason.clone(),
        },
        other => {
            return Err(DgError::Usage(UsageError(format!(
                "invalid --event \"{other}\" (allowed: coder-ok|coder-fail|verdict|g3-pass|g3-fail)"
            ))))
        }
    };

    let (next_state, action) = pipeline::advance_pipeline(state, event);
    let state_file = match pipeline::save_state(&dir, &next_state) {
        Ok(p) => p,
        Err(e) => {
            emit(
                json,
                format!("[pipeline step] {fork_id} state 저장 실패: {e}"),
                &json!({
                    "action": "step",
                    "fork_id": fork_id,
                    "saved": false,
                    "errors": [e],
                }),
            );
            return Ok(1);
        }
    };

    // READY_PR 신호 — EmitReadyPr 액션일 때만 `READY_PR=<num> HEAD=<sha> G3=PASS`.
    let ready_pr_signal = match &action {
        PipelineAction::EmitReadyPr {
            pr_number,
            head_sha,
        } => Some(format!(
            "READY_PR={} HEAD={} G3=PASS",
            pr_number,
            head_sha.as_deref().unwrap_or("unknown")
        )),
        _ => None,
    };

    let mut human = format!(
        "[pipeline step] {fork_id} {event_name} → {} next={}",
        next_state.phase.as_str(),
        action.label()
    );
    if let PipelineAction::WakeSubleadEscalation { reason } = &action {
        human.push_str(&format!(" reason={reason}"));
    }
    if let Some(sig) = &ready_pr_signal {
        human.push_str(&format!("\n{sig}"));
    }

    emit(
        json,
        human,
        &json!({
            "action": "step",
            "fork_id": fork_id,
            "event": event_name,
            "phase": next_state.phase.as_str(),
            "attempt": next_state.attempt,
            "max_reworks": next_state.max_reworks,
            "state_file": state_file,
            "next_action": action,
            "ready_pr_signal": ready_pr_signal,
            "verdict_errors": verdict_errors,
            "escalation_reason": next_state.escalation_reason,
        }),
    );
    // Escalated 도달은 sublead 단발 기동 신호 — verdict fail-closed(exit 3)와 같은 계약.
    Ok(if next_state.phase == PipelinePhase::Escalated {
        3
    } else {
        0
    })
}

fn cmd_status(args: &ParsedArgs, json: bool) -> CmdResult {
    let fork_id = require_flag(args, "fork")?;
    let dir = state_dir(args);
    let state = pipeline::load_state(&dir, &fork_id)
        .map_err(|e| DgError::Usage(UsageError(e)))?;

    emit(
        json,
        format!(
            "[pipeline] {fork_id} phase={} attempt={}/{} transitions={}",
            state.phase.as_str(),
            state.attempt,
            state.max_reworks,
            state.history.len()
        ),
        &json!({
            "action": "status",
            "state_file": pipeline::state_file_path(&dir, &state.run_id),
            "state": state,
        }),
    );
    Ok(0)
}
