//! 직렬 머지 트레인 엔진 — `update-branch → ci-full 라벨 → CI 대기(실패 시 rerun) →
//! merge state 확인 → squash merge → worktree 정리` 순서를 결정적으로 구동한다.
//!
//! `dgate-sublead-pipeline-spec.md` §1.3의 직렬 머지 트레인(paperwork-runtime 실전
//! 피드백)을 구현한다. 실행 레이어는 `MergeTrainRunner` 트레이트로 추상화해 모의 러너로
//! 전체 시나리오를 결정적 단위 테스트로 고정한다.
//!
//! 외부 연결:
//! - `dg merge-train`(`crates/dgate-cli/src/commands/merge_train.rs`)이 gh/git CLI 구현
//!   `GhMergeTrainRunner`를 주입해 `execute_merge_train`을 호출한다.
//! - `HERDR_ROLE=sublead` 차단은 `sublead_merge_train_violation`로 물리 집행한다
//!   (docs/sublead-design.md 항목 8 — 머지는 최상위 리드 전용).
//!
//! 주의:
//! - 러너 메서드의 `Err`는 재시도 없이 즉시 `Failed`로 종결한다 — CI `Failed`(실패한
//!   run 관측)와 인프라 오류(gh/git 호출 실패)를 구분해야 재시도 예산을 정확히 소비한다.
//! - `rerun`은 같은 `databaseId`의 새 attempt를 시작하므로, 재대기 시에도 원래
//!   `sync_run_id` 하한을 그대로 쓴다(run은 동일 id로 완료된다).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// CI 트리거 라벨 기본값.
pub const DEFAULT_CI_LABEL: &str = "ci-full";
/// CI 실패 시 `gh run rerun --failed` 허용 횟수 기본값.
pub const DEFAULT_MAX_RERUNS: u32 = 1;
/// CI 완료 폴링 주기 기본값(ms).
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 5_000;
/// CI 완료 대기 상한 기본값(ms) — 30분.
pub const DEFAULT_TIMEOUT_MS: u64 = 1_800_000;

const STEP_UPDATE_BRANCH: &str = "update_branch";
const STEP_ADD_LABEL: &str = "add_label";
const STEP_WAIT_CI: &str = "wait_for_ci_run";
const STEP_RERUN: &str = "rerun_failed";
const STEP_CHECK_STATE: &str = "check_merge_state";
const STEP_SQUASH: &str = "squash_merge";
const STEP_CLEANUP: &str = "cleanup_worktree";

/// 머지 트레인 설정 — `new(pr, repo)`로 기본값을 채우고 필요 필드를 덮어쓴다.
#[derive(Debug, Clone)]
pub struct MergeTrainConfig {
    pub pr_number: u64,
    pub repo_dir: PathBuf,
    /// PR에 부여할 CI 트리거 라벨(기본 `ci-full`).
    pub ci_label: String,
    /// CI 실패 시 rerun 허용 횟수(기본 1 — 총 2회 CI 기회).
    pub max_reruns: u32,
    /// 머지 성공 후 `git worktree remove`할 경로(선택).
    pub worktree_path: Option<PathBuf>,
    /// true면 러너 호출 0회로 예정 단계 목록만 반환한다.
    pub dry_run: bool,
    pub poll_interval_ms: u64,
    pub timeout_ms: u64,
}

impl MergeTrainConfig {
    pub fn new(pr_number: u64, repo_dir: PathBuf) -> Self {
        Self {
            pr_number,
            repo_dir,
            ci_label: DEFAULT_CI_LABEL.to_string(),
            max_reruns: DEFAULT_MAX_RERUNS,
            worktree_path: None,
            dry_run: false,
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

/// `wait_for_ci_run`의 종료 관측 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CiRunOutcome {
    /// run 완료 + conclusion=success.
    Passed { run_id: u64 },
    /// run 완료 + 실패 계열 conclusion — `summary`는 사람용 실패 요약.
    Failed { run_id: u64, summary: String },
    /// timeout_ms 안에 완료 관측 실패.
    TimedOut,
}

/// `check_merge_state`의 PR 머지 가능 상태.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeStateStatus {
    /// 머지 가능(CLEAN).
    Clean,
    /// base 대비 뒤처짐(BEHIND) — update-branch가 필요한 상태.
    Behind,
    /// 브랜치 보호·리뷰 미충족 등으로 차단(BLOCKED·DRAFT·UNSTABLE 등, 사유 포함).
    Blocked(String),
    /// 충돌(CONFLICTING/DIRTY) — 수동 해소 필요.
    Dirty,
}

impl MergeStateStatus {
    /// 사람 출력·reason용 라벨(Blocked는 내부 사유 포함).
    pub fn as_str(&self) -> String {
        match self {
            MergeStateStatus::Clean => "clean".to_string(),
            MergeStateStatus::Behind => "behind".to_string(),
            MergeStateStatus::Blocked(reason) => format!("blocked({reason})"),
            MergeStateStatus::Dirty => "dirty".to_string(),
        }
    }
}

/// 머지 트레인 실행 레이어 추상화 — 실구현은 CLI의 `GhMergeTrainRunner`.
/// 모든 메서드는 관측 대상 인자만 받고, 오류는 `Err(String)`으로 보고한다.
pub trait MergeTrainRunner {
    /// 브랜치 최신화(`gh api …/pulls/<pr>/update-branch`) 후, 신규 CI 판별 하한이 될
    /// 최신 synchronize workflow run의 `databaseId`를 반환한다(없으면 None).
    fn update_branch(&mut self, pr: u64) -> Result<Option<u64>, String>;
    /// `gh pr edit <pr> --add-label <label>` — CI 트리거 라벨 부여.
    fn add_label(&mut self, pr: u64, label: &str) -> Result<(), String>;
    /// `databaseId > after_run_id`인 새 CI run이 완료될 때까지 대기한다.
    /// `after_run_id`가 None이면 완료된 최신 run을 대상으로 한다.
    fn wait_for_ci_run(&mut self, pr: u64, after_run_id: Option<u64>) -> Result<CiRunOutcome, String>;
    /// `gh run rerun <run_id> --failed` — 실패한 run의 failed job만 재실행.
    fn rerun_failed(&mut self, run_id: u64) -> Result<(), String>;
    /// `gh pr view <pr> --json mergeStateStatus` → 머지 가능 상태.
    fn check_merge_state(&mut self, pr: u64) -> Result<MergeStateStatus, String>;
    /// `gh pr merge <pr> --squash --delete-branch`.
    fn squash_merge(&mut self, pr: u64) -> Result<(), String>;
    /// `git worktree remove <path>`(worktree_path 지정 시 머지 후 1회).
    fn cleanup_worktree(&mut self, path: &Path) -> Result<(), String>;
}

/// 머지 트레인 최종 상태 — 종료 코드는 `exit_code()`로 매핑한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeTrainStatus {
    /// `--dry-run` — 러너 호출 0회, 예정 단계 목록만 반환(exit 0).
    DryRun,
    /// squash merge 완료(exit 0). worktree 정리 실패는 reason으로만 남긴다.
    Merged,
    /// CI 실패·타임아웃·러너 오류 — 재시도 소진 포함(exit 1).
    Failed,
    /// `check_merge_state != Clean` — 머지 중단(exit 1).
    Blocked,
}

impl MergeTrainStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MergeTrainStatus::DryRun => "dry_run",
            MergeTrainStatus::Merged => "merged",
            MergeTrainStatus::Failed => "failed",
            MergeTrainStatus::Blocked => "blocked",
        }
    }

    /// 종료 코드 — DryRun/Merged=0, Failed/Blocked=1.
    pub fn exit_code(&self) -> i32 {
        match self {
            MergeTrainStatus::DryRun | MergeTrainStatus::Merged => 0,
            MergeTrainStatus::Failed | MergeTrainStatus::Blocked => 1,
        }
    }
}

/// `execute_merge_train`의 결과 보고 — JSON 출력·테스트 단언용.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergeTrainReport {
    pub pr_number: u64,
    pub status: MergeTrainStatus,
    /// 실제 실행된 단계 라벨 순서(dry-run은 예정 목록).
    pub steps: Vec<String>,
    /// 소비한 rerun 횟수(0~max_reruns).
    pub reruns_used: u32,
    /// 통과한 CI run databaseId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ci_run_id: Option<u64>,
    /// Failed/Blocked 사유(또는 Merged 시 cleanup 실패 경고).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl MergeTrainReport {
    /// `status.exit_code()` 위임 — CLI 종료 코드.
    pub fn exit_code(&self) -> i32 {
        self.status.exit_code()
    }
}

/// dry-run용 예정 단계 목록 — 설정 의존(rerun 예산·worktree 지정)으로 조립한다.
fn planned_steps(cfg: &MergeTrainConfig) -> Vec<String> {
    let mut steps = vec![
        STEP_UPDATE_BRANCH.to_string(),
        STEP_ADD_LABEL.to_string(),
        STEP_WAIT_CI.to_string(),
    ];
    if cfg.max_reruns > 0 {
        steps.push(STEP_RERUN.to_string());
    }
    steps.push(STEP_CHECK_STATE.to_string());
    steps.push(STEP_SQUASH.to_string());
    if cfg.worktree_path.is_some() {
        steps.push(STEP_CLEANUP.to_string());
    }
    steps
}

fn fail(report: &mut MergeTrainReport, reason: String) -> MergeTrainReport {
    report.status = MergeTrainStatus::Failed;
    report.reason = Some(reason);
    report.clone()
}

/// 순수 실행 함수 — 러너 호출 순서·재시도 예산만 관리한다.
///
/// 순서: update_branch → add_label → wait_for_ci_run(실패 시 rerun_failed 후 재대기,
/// 예산 소진·TimedOut 시 Failed) → check_merge_state(Clean 아니면 Blocked) →
/// squash_merge → worktree_path 있으면 cleanup_worktree → Merged.
pub fn execute_merge_train(
    cfg: &MergeTrainConfig,
    runner: &mut dyn MergeTrainRunner,
) -> MergeTrainReport {
    let pr = cfg.pr_number;
    let mut report = MergeTrainReport {
        pr_number: pr,
        status: MergeTrainStatus::Failed,
        steps: Vec::new(),
        reruns_used: 0,
        ci_run_id: None,
        reason: None,
    };
    if cfg.dry_run {
        report.status = MergeTrainStatus::DryRun;
        report.steps = planned_steps(cfg);
        return report;
    }

    // 1) 브랜치 최신화 — 반환 run id가 이후 CI 판별의 databaseId 하한.
    let sync_run_id = match runner.update_branch(pr) {
        Ok(run_id) => {
            report.steps.push(STEP_UPDATE_BRANCH.to_string());
            run_id
        }
        Err(e) => return fail(&mut report, format!("update_branch 실패: {e}")),
    };
    // 2) CI 트리거 라벨 부여.
    match runner.add_label(pr, &cfg.ci_label) {
        Ok(()) => report.steps.push(STEP_ADD_LABEL.to_string()),
        Err(e) => return fail(&mut report, format!("add_label 실패: {e}")),
    }
    // 3) CI 완료 대기 — Failed면 예산 안에서 rerun_failed 1회 후 재대기.
    loop {
        match runner.wait_for_ci_run(pr, sync_run_id) {
            Ok(outcome @ (CiRunOutcome::Passed { .. } | CiRunOutcome::Failed { .. })) => {
                report.steps.push(STEP_WAIT_CI.to_string());
                match outcome {
                    CiRunOutcome::Passed { run_id } => {
                        report.ci_run_id = Some(run_id);
                        break;
                    }
                    CiRunOutcome::Failed { run_id, summary }
                        if report.reruns_used < cfg.max_reruns =>
                    {
                        match runner.rerun_failed(run_id) {
                            Ok(()) => {
                                report.reruns_used += 1;
                                report.steps.push(STEP_RERUN.to_string());
                            }
                            Err(e) => {
                                return fail(
                                    &mut report,
                                    format!("rerun_failed(run_id={run_id}) 실패: {e}"),
                                )
                            }
                        }
                    }
                    CiRunOutcome::Failed { summary, .. } => {
                        let used = report.reruns_used;
                        return fail(
                            &mut report,
                            format!("CI 실패 — rerun 예산 소진({used}/{}): {summary}",
                                cfg.max_reruns),
                        )
                    }
                    CiRunOutcome::TimedOut => unreachable!("outcome은 Passed|Failed로 한정"),
                }
            }
            Ok(CiRunOutcome::TimedOut) => {
                report.steps.push(STEP_WAIT_CI.to_string());
                return fail(&mut report, "CI 완료 대기 타임아웃".to_string());
            }
            Err(e) => return fail(&mut report, format!("wait_for_ci_run 실패: {e}")),
        }
    }
    // 4) 머지 가능 상태 — Clean만 진행.
    match runner.check_merge_state(pr) {
        Ok(MergeStateStatus::Clean) => report.steps.push(STEP_CHECK_STATE.to_string()),
        Ok(state) => {
            report.status = MergeTrainStatus::Blocked;
            report.reason = Some(format!("merge state {} — 머지 중단", state.as_str()));
            return report;
        }
        Err(e) => return fail(&mut report, format!("check_merge_state 실패: {e}")),
    }
    // 5) squash merge → (선택) worktree 정리.
    match runner.squash_merge(pr) {
        Ok(()) => report.steps.push(STEP_SQUASH.to_string()),
        Err(e) => return fail(&mut report, format!("squash_merge 실패: {e}")),
    }
    report.status = MergeTrainStatus::Merged;
    if let Some(path) = &cfg.worktree_path {
        match runner.cleanup_worktree(path) {
            Ok(()) => report.steps.push(STEP_CLEANUP.to_string()),
            // 머지 자체는 완료 — 정리 실패는 상태를 뒤집지 않고 reason으로만 남긴다.
            Err(e) => {
                report.reason = Some(format!("cleanup_worktree 실패(머지는 완료): {e}"))
            }
        }
    }
    report
}

/// Sublead 머지 금지 물리 집행(docs/sublead-design.md 항목 8 — 머지는 최상위 리드 전용).
/// `caller_role`이 `sublead`(대소문자 무시)면 거부 메시지, 그 외는 None.
pub fn sublead_merge_train_violation(caller_role: Option<&str>) -> Option<String> {
    let role = caller_role.unwrap_or("").trim().to_lowercase();
    if role != "sublead" {
        return None;
    }
    Some(
        "sublead merge-train 거부: 머지는 최상위 리드 전용입니다 — READY_PR 핸드오프로 완료 보고하세요(docs/sublead-design.md 항목 8)"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// 호출 순서를 기록하고 시나리오 큐로 결정적 응답을 내는 모의 러너.
    struct MockRunner {
        calls: Vec<String>,
        ci_outcomes: VecDeque<CiRunOutcome>,
        merge_state: MergeStateStatus,
        update_branch_run: Option<u64>,
    }

    impl MockRunner {
        fn new(outcomes: Vec<CiRunOutcome>, merge_state: MergeStateStatus) -> Self {
            Self {
                calls: Vec::new(),
                ci_outcomes: outcomes.into(),
                merge_state,
                update_branch_run: Some(100),
            }
        }

        fn called(&self, name: &str) -> bool {
            self.calls.iter().any(|c| c.starts_with(name))
        }

        fn count(&self, name: &str) -> usize {
            self.calls.iter().filter(|c| c.starts_with(name)).count()
        }
    }

    impl MergeTrainRunner for MockRunner {
        fn update_branch(&mut self, pr: u64) -> Result<Option<u64>, String> {
            self.calls.push(format!("update_branch:{pr}"));
            Ok(self.update_branch_run)
        }

        fn add_label(&mut self, pr: u64, label: &str) -> Result<(), String> {
            self.calls.push(format!("add_label:{pr}:{label}"));
            Ok(())
        }

        fn wait_for_ci_run(&mut self, pr: u64, after_run_id: Option<u64>) -> Result<CiRunOutcome, String> {
            self.calls.push(format!("wait_for_ci_run:{pr}:{after_run_id:?}"));
            Ok(self
                .ci_outcomes
                .pop_front()
                .unwrap_or(CiRunOutcome::Passed { run_id: 200 }))
        }

        fn rerun_failed(&mut self, run_id: u64) -> Result<(), String> {
            self.calls.push(format!("rerun_failed:{run_id}"));
            Ok(())
        }

        fn check_merge_state(&mut self, pr: u64) -> Result<MergeStateStatus, String> {
            self.calls.push(format!("check_merge_state:{pr}"));
            Ok(self.merge_state.clone())
        }

        fn squash_merge(&mut self, pr: u64) -> Result<(), String> {
            self.calls.push(format!("squash_merge:{pr}"));
            Ok(())
        }

        fn cleanup_worktree(&mut self, path: &Path) -> Result<(), String> {
            self.calls.push(format!("cleanup_worktree:{}", path.display()));
            Ok(())
        }
    }

    fn cfg_with_worktree() -> MergeTrainConfig {
        let mut cfg = MergeTrainConfig::new(42, PathBuf::from("/repo"));
        cfg.worktree_path = Some(PathBuf::from("/repo-wt"));
        cfg
    }

    // 1) 정상 완주 — update_branch → add_label → CI Passed → Clean → squash_merge → cleanup.
    #[test]
    fn happy_path_full_sequence() {
        let mut runner = MockRunner::new(
            vec![CiRunOutcome::Passed { run_id: 201 }],
            MergeStateStatus::Clean,
        );
        let report = execute_merge_train(&cfg_with_worktree(), &mut runner);

        assert_eq!(report.status, MergeTrainStatus::Merged);
        assert_eq!(report.exit_code(), 0);
        assert_eq!(report.ci_run_id, Some(201));
        assert_eq!(report.reruns_used, 0);
        assert_eq!(
            runner.calls,
            vec![
                "update_branch:42",
                "add_label:42:ci-full",
                "wait_for_ci_run:42:Some(100)",
                "check_merge_state:42",
                "squash_merge:42",
                "cleanup_worktree:/repo-wt",
            ]
        );
    }

    // 2) 1차 CI 실패 → rerun_failed 1회 자동 재시도 → 2차 Passed → Merged.
    #[test]
    fn ci_failure_rerun_once_then_merged() {
        let mut runner = MockRunner::new(
            vec![
                CiRunOutcome::Failed { run_id: 201, summary: "lint fail".to_string() },
                CiRunOutcome::Passed { run_id: 201 },
            ],
            MergeStateStatus::Clean,
        );
        let report = execute_merge_train(&cfg_with_worktree(), &mut runner);

        assert_eq!(report.status, MergeTrainStatus::Merged);
        assert_eq!(report.reruns_used, 1);
        assert_eq!(runner.count("wait_for_ci_run"), 2);
        assert_eq!(runner.count("rerun_failed:201"), 1);
        assert_eq!(runner.count("squash_merge:42"), 1);
    }

    // 3) 1차·2차 모두 실패(예산 소진) → Failed, squash_merge 미호출.
    #[test]
    fn rerun_budget_exhausted_fails_without_merge() {
        let mut runner = MockRunner::new(
            vec![
                CiRunOutcome::Failed { run_id: 201, summary: "f1".to_string() },
                CiRunOutcome::Failed { run_id: 201, summary: "f2".to_string() },
            ],
            MergeStateStatus::Clean,
        );
        let report = execute_merge_train(&cfg_with_worktree(), &mut runner);

        assert_eq!(report.status, MergeTrainStatus::Failed);
        assert_eq!(report.exit_code(), 1);
        assert_eq!(report.reruns_used, 1);
        assert!(!runner.called("squash_merge"));
        assert!(!runner.called("check_merge_state"));
        assert!(!runner.called("cleanup_worktree"));
    }

    // 4) check_merge_state != Clean → Blocked, squash_merge 미호출.
    #[test]
    fn non_clean_merge_state_blocks() {
        for state in [
            MergeStateStatus::Behind,
            MergeStateStatus::Blocked("required review".to_string()),
            MergeStateStatus::Dirty,
        ] {
            let mut runner = MockRunner::new(
                vec![CiRunOutcome::Passed { run_id: 201 }],
                state.clone(),
            );
            let report = execute_merge_train(&cfg_with_worktree(), &mut runner);

            assert_eq!(report.status, MergeTrainStatus::Blocked, "state={state:?}");
            assert_eq!(report.exit_code(), 1);
            assert!(!runner.called("squash_merge"), "state={state:?}");
            assert!(report.reason.is_some());
        }
    }

    // 5) dry_run — 러너 호출 0회 + 예정 단계 목록 반환.
    #[test]
    fn dry_run_zero_calls_returns_plan() {
        let mut runner = MockRunner::new(vec![], MergeStateStatus::Clean);
        let mut cfg = cfg_with_worktree();
        cfg.dry_run = true;
        let report = execute_merge_train(&cfg, &mut runner);

        assert_eq!(report.status, MergeTrainStatus::DryRun);
        assert_eq!(report.exit_code(), 0);
        assert!(runner.calls.is_empty(), "dry-run은 러너 호출 0회: {:?}", runner.calls);
        assert_eq!(
            report.steps,
            vec![
                "update_branch",
                "add_label",
                "wait_for_ci_run",
                "rerun_failed",
                "check_merge_state",
                "squash_merge",
                "cleanup_worktree",
            ]
        );
    }

    // 6) sublead_merge_train_violation — sublead 거부, lead/None 허용.
    #[test]
    fn sublead_guard_denies_sublead_only() {
        assert!(sublead_merge_train_violation(Some("sublead")).is_some());
        assert!(sublead_merge_train_violation(Some("SUBLEAD")).is_some());
        assert!(sublead_merge_train_violation(Some(" sublead ")).is_some());
        assert!(sublead_merge_train_violation(Some("lead")).is_none());
        assert!(sublead_merge_train_violation(Some("coder")).is_none());
        assert!(sublead_merge_train_violation(None).is_none());
    }

    // 보강: TimedOut → Failed, squash_merge 미호출.
    #[test]
    fn ci_timeout_fails_without_merge() {
        let mut runner = MockRunner::new(vec![CiRunOutcome::TimedOut], MergeStateStatus::Clean);
        let report = execute_merge_train(&cfg_with_worktree(), &mut runner);

        assert_eq!(report.status, MergeTrainStatus::Failed);
        assert_eq!(report.exit_code(), 1);
        assert!(!runner.called("squash_merge"));
    }

    // 보강: 러너 오류(인프라)는 재시도 예산을 쓰지 않고 즉시 Failed.
    #[test]
    fn runner_error_fails_immediately() {
        struct ErrRunner;
        impl MergeTrainRunner for ErrRunner {
            fn update_branch(&mut self, _pr: u64) -> Result<Option<u64>, String> {
                Err("gh not found".to_string())
            }
            fn add_label(&mut self, _pr: u64, _label: &str) -> Result<(), String> { Ok(()) }
            fn wait_for_ci_run(&mut self, _pr: u64, _a: Option<u64>) -> Result<CiRunOutcome, String> {
                Ok(CiRunOutcome::Passed { run_id: 1 })
            }
            fn rerun_failed(&mut self, _id: u64) -> Result<(), String> { Ok(()) }
            fn check_merge_state(&mut self, _pr: u64) -> Result<MergeStateStatus, String> {
                Ok(MergeStateStatus::Clean)
            }
            fn squash_merge(&mut self, _pr: u64) -> Result<(), String> { Ok(()) }
            fn cleanup_worktree(&mut self, _p: &Path) -> Result<(), String> { Ok(()) }
        }

        let mut runner = ErrRunner;
        let report = execute_merge_train(&cfg_with_worktree(), &mut runner);
        assert_eq!(report.status, MergeTrainStatus::Failed);
        assert!(report.reason.unwrap().contains("update_branch 실패"));
    }
}
