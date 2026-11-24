//! `dg merge-train` — 직렬 머지 트레인 자동화.
//!
//! `dgate_core::merge_train::execute_merge_train`(순수 판정)을 `GhMergeTrainRunner`
//! (gh/git CLI 실구현)로 구동한다 — 머지 순서·재시도 예산은 코어가, 프로세스 호출은
//! 이 파일이 담당한다(dgate-sublead-pipeline-spec.md §1.3).
//!
//! 종료 코드:
//! - 0: `merged` 또는 `--dry-run`(예정 단계만 출력)
//! - 1: `failed`(CI 실패·타임아웃·러너 오류) / `blocked`(merge state != clean)
//! - 2: 사용법 오류 · `HERDR_ROLE=sublead` 물리 차단(sublead-design.md 항목 8)
//!
//! 주의:
//! - 모든 gh/git 호출은 `--repo` 디렉터리를 cwd로 실행한다(gh가 remote로 repo를 해석).
//! - 이 명령은 `gh pr merge --squash`를 실제로 호출한다 — dry-run 외 호출은
//!   HERDR_MERGE_GATE 같은 상위 가드의 승인 맥락에서만 쓰인다.

use std::path::{Path, PathBuf};
use std::process::Command as ProcCommand;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::args::{bool_flag, optional_flag, parse_int_flag, require_flag, ParsedArgs, UsageError};
use crate::util::prelude::*;
use dgate_core::merge_train::{
    self, CiRunOutcome, MergeStateStatus, MergeTrainConfig, MergeTrainRunner, MergeTrainStatus,
};

pub fn cmd_merge_train(args: &ParsedArgs, json: bool) -> CmdResult {
    // sublead 물리 차단 — 머지는 최상위 리드 전용(docs/sublead-design.md 항목 8).
    let caller_role = std::env::var("HERDR_ROLE").ok();
    if let Some(msg) = merge_train::sublead_merge_train_violation(caller_role.as_deref()) {
        return Err(DgError::Usage(UsageError(msg)));
    }

    let pr_raw = require_flag(args, "pr")?;
    let pr_number = pr_raw.parse::<u64>().map_err(|_| {
        DgError::Usage(UsageError(format!("--pr must be an integer: {pr_raw}")))
    })?;
    let repo_dir = optional_flag(args, "repo")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if !repo_dir.is_dir() {
        return Err(DgError::Usage(UsageError(format!(
            "--repo directory not found: {}",
            repo_dir.display()
        ))));
    }
    let ci_label = optional_flag(args, "ci-label")
        .unwrap_or_else(|| merge_train::DEFAULT_CI_LABEL.to_string());
    let max_reruns = parse_int_flag(args, "max-reruns", merge_train::DEFAULT_MAX_RERUNS as i64)?;
    if max_reruns < 0 {
        return Err(DgError::Usage(UsageError(
            "--max-reruns must be >= 0".to_string(),
        )));
    }
    let poll_interval_ms = parse_int_flag(
        args,
        "poll-interval-ms",
        merge_train::DEFAULT_POLL_INTERVAL_MS as i64,
    )?;
    if poll_interval_ms <= 0 {
        return Err(DgError::Usage(UsageError(
            "--poll-interval-ms must be > 0".to_string(),
        )));
    }
    let timeout_ms = parse_int_flag(args, "timeout-ms", merge_train::DEFAULT_TIMEOUT_MS as i64)?;
    if timeout_ms <= 0 {
        return Err(DgError::Usage(UsageError(
            "--timeout-ms must be > 0".to_string(),
        )));
    }

    let cfg = MergeTrainConfig {
        pr_number,
        repo_dir: repo_dir.clone(),
        ci_label: ci_label.clone(),
        max_reruns: max_reruns as u32,
        worktree_path: optional_flag(args, "worktree").map(PathBuf::from),
        dry_run: bool_flag(args, "dry-run"),
        poll_interval_ms: poll_interval_ms as u64,
        timeout_ms: timeout_ms as u64,
    };

    let mut runner = GhMergeTrainRunner::new(
        repo_dir,
        ci_label,
        cfg.poll_interval_ms,
        cfg.timeout_ms,
    );
    let report = merge_train::execute_merge_train(&cfg, &mut runner);

    let human = match report.status {
        MergeTrainStatus::DryRun => format!(
            "[merge-train] PR #{pr_number} dry-run — 예정 단계 {}개",
            report.steps.len()
        ),
        _ => format!(
            "[merge-train] PR #{pr_number} {} (reruns={}/{} steps={}){}",
            report.status.as_str(),
            report.reruns_used,
            cfg.max_reruns,
            report.steps.len(),
            report
                .reason
                .as_deref()
                .map(|r| format!(" — {r}"))
                .unwrap_or_default()
        ),
    };
    let mut data = serde_json::to_value(&report).unwrap_or_else(|_| json!({}));
    data["cmd"] = json!("merge-train");
    data["exit_code"] = json!(report.exit_code());
    emit(json, human, &data);
    Ok(report.exit_code())
}

// ---------------------------------------------------------------------------
// GhMergeTrainRunner — gh/git CLI 실구현
// ---------------------------------------------------------------------------

/// gh/git 호출을 repo_dir cwd로 실행하는 실제 머지 트레인 러너.
pub struct GhMergeTrainRunner {
    repo_dir: PathBuf,
    ci_label: String,
    poll_interval: Duration,
    timeout: Duration,
}

impl GhMergeTrainRunner {
    pub fn new(repo_dir: PathBuf, ci_label: String, poll_interval_ms: u64, timeout_ms: u64) -> Self {
        Self {
            repo_dir,
            ci_label,
            poll_interval: Duration::from_millis(poll_interval_ms.max(100)),
            timeout: Duration::from_millis(timeout_ms.max(1_000)),
        }
    }

    /// gh 호출 — 성공 시 stdout, 실패 시 stderr를 포함한 Err.
    fn gh(&self, args: &[&str]) -> Result<String, String> {
        run_cli(&self.repo_dir, "gh", args)
    }

    /// `gh pr view <pr>` → (head 브랜치, head SHA).
    fn pr_head(&self, pr: u64) -> Result<(String, String), String> {
        let out = self.gh(&[
            "pr",
            "view",
            &pr.to_string(),
            "--json",
            "headRefName,headRefOid",
        ])?;
        let v: Value = serde_json::from_str(&out)
            .map_err(|e| format!("gh pr view JSON 파싱 실패: {e}"))?;
        let branch = v["headRefName"].as_str().unwrap_or_default();
        let sha = v["headRefOid"].as_str().unwrap_or_default();
        if branch.is_empty() || sha.is_empty() {
            return Err(format!("gh pr view {pr}: headRefName/headRefOid 누락"));
        }
        Ok((branch.to_string(), sha.to_string()))
    }

    /// PR 헤드 브랜치의 pull_request 이벤트 run 목록(최신순, databaseId/headSha/status/conclusion).
    fn pr_runs(&self, pr: u64) -> Result<Vec<Value>, String> {
        let (branch, _sha) = self.pr_head(pr)?;
        let out = self.gh(&[
            "run",
            "list",
            "--branch",
            &branch,
            "--event",
            "pull_request",
            "--json",
            "databaseId,headSha,status,conclusion,workflowName",
            "--limit",
            "20",
        ])?;
        serde_json::from_str(&out).map_err(|e| format!("gh run list JSON 파싱 실패: {e}"))
    }

    /// 신규 CI 대상 run 선별 — head SHA 일치 + databaseId > after_run_id.
    /// ci_label과 동명 워크플로가 있으면 그 run들로 한정한다(다중 워크플로 오인 방지).
    fn ci_candidates<'a>(&self, runs: &'a [Value], head_sha: &str, after_run_id: Option<u64>) -> Vec<&'a Value> {
        let matched: Vec<&Value> = runs
            .iter()
            .filter(|r| r["headSha"].as_str() == Some(head_sha))
            .filter(|r| match after_run_id {
                Some(after) => r["databaseId"].as_u64().unwrap_or(0) > after,
                None => true,
            })
            .collect();
        let labeled: Vec<&Value> = matched
            .iter()
            .copied()
            .filter(|r| r["workflowName"].as_str() == Some(self.ci_label.as_str()))
            .collect();
        if labeled.is_empty() {
            matched
        } else {
            labeled
        }
    }
}

impl MergeTrainRunner for GhMergeTrainRunner {
    /// `gh api repos/{repo}/pulls/<pr>/update-branch -X PUT`으로 base 최신화.
    /// 반환값은 update 직전 최신 pull_request run의 databaseId — 신규 CI 판별 하한.
    fn update_branch(&mut self, pr: u64) -> Result<Option<u64>, String> {
        let marker = self
            .pr_runs(pr)?
            .iter()
            .filter_map(|r| r["databaseId"].as_u64())
            .max();
        let endpoint = format!("repos/{{repo}}/pulls/{pr}/update-branch");
        match self.gh(&["api", &endpoint, "-X", "PUT"]) {
            Ok(_) => Ok(marker),
            // 이미 최신이면 API가 422를 반환한다 — 최신화할 것이 없는 정상 경로로 처리.
            Err(e) if e.contains("up to date") || e.contains("no new commits") => Ok(marker),
            Err(e) => Err(e),
        }
    }

    fn add_label(&mut self, pr: u64, label: &str) -> Result<(), String> {
        self.gh(&["pr", "edit", &pr.to_string(), "--add-label", label])
            .map(|_| ())
    }

    fn wait_for_ci_run(&mut self, pr: u64, after_run_id: Option<u64>) -> Result<CiRunOutcome, String> {
        let deadline = Instant::now() + self.timeout;
        loop {
            let (_branch, head_sha) = self.pr_head(pr)?;
            let runs = self.pr_runs(pr)?;
            let candidates = self.ci_candidates(&runs, &head_sha, after_run_id);
            // run list는 최신순 — 완료된 첫 후보가 최신 완료 run.
            if let Some(done) = candidates
                .iter()
                .find(|r| r["status"].as_str() == Some("completed"))
            {
                let run_id = done["databaseId"].as_u64().unwrap_or(0);
                match done["conclusion"].as_str().unwrap_or("") {
                    "success" => return Ok(CiRunOutcome::Passed { run_id }),
                    other => {
                        return Ok(CiRunOutcome::Failed {
                            run_id,
                            summary: format!(
                                "run {run_id} workflow={} conclusion={other}",
                                done["workflowName"].as_str().unwrap_or("?")
                            ),
                        })
                    }
                }
            }
            if Instant::now() >= deadline {
                return Ok(CiRunOutcome::TimedOut);
            }
            std::thread::sleep(self.poll_interval);
        }
    }

    fn rerun_failed(&mut self, run_id: u64) -> Result<(), String> {
        self.gh(&["run", "rerun", &run_id.to_string(), "--failed"])
            .map(|_| ())
    }

    fn check_merge_state(&mut self, pr: u64) -> Result<MergeStateStatus, String> {
        let out = self.gh(&["pr", "view", &pr.to_string(), "--json", "mergeStateStatus"])?;
        let v: Value = serde_json::from_str(&out)
            .map_err(|e| format!("gh pr view JSON 파싱 실패: {e}"))?;
        let raw = v["mergeStateStatus"].as_str().unwrap_or("UNKNOWN");
        Ok(match raw.to_uppercase().as_str() {
            "CLEAN" => MergeStateStatus::Clean,
            "BEHIND" => MergeStateStatus::Behind,
            "CONFLICTING" | "DIRTY" => MergeStateStatus::Dirty,
            // BLOCKED·DRAFT·UNSTABLE·HAS_HOOKS·UNKNOWN 등 — Clean 아님은 전부 Blocked.
            other => MergeStateStatus::Blocked(other.to_string()),
        })
    }

    fn squash_merge(&mut self, pr: u64) -> Result<(), String> {
        self.gh(&["pr", "merge", &pr.to_string(), "--squash", "--delete-branch"])
            .map(|_| ())
    }

    fn cleanup_worktree(&mut self, path: &Path) -> Result<(), String> {
        let path_s = path.to_string_lossy().into_owned();
        run_cli(&self.repo_dir, "git", &["worktree", "remove", &path_s]).map(|_| ())
    }
}

/// 외부 CLI 호출 공용 — 성공 시 stdout 문자열, 실패 시 stderr 포함 오류.
fn run_cli(dir: &Path, bin: &str, args: &[&str]) -> Result<String, String> {
    let out = ProcCommand::new(bin)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("{bin} 실행 불가: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "{bin} {} 실패(exit {}): {}",
            args.join(" "),
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}
