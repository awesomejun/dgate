//! 하이브리드 세션 수명 정책 엔진 (`dg suggest-session`, LLM 호출 0, 읽기전용).
//!
//! 실전 기준 3단계로 코더 세션의 에페머럴(1작업 1세션) vs Warm 재사용(프롬프트 캐시 활용)을
//! 결정론적으로 판정한다:
//! 1. **역할 불변식**: `verifier` · `advisor`는 확증 편향 차단을 위해 항상 `ephemeral`.
//! 2. **투입 전 3초 필터**: `door == "one-way"`, `estimated_files >= 6`, `!same_domain`,
//!    `queued_similar < 3` 중 하나라도 걸리면 `ephemeral`.
//! 3. **실행 중 자동 리셋선 & 손익분기**: 연속 실패 ≥ 2회, 컴팩션 발생, 작업 5건/턴 35회
//!    도달, 또는 DB 실측 1차 통과율(first-pass rate) < 0.70(표본 ≥ 3)이면 리셋/`ephemeral`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Warm 재사용 기본 상한 — 컨텍스트 부패(context rot)가 오기 전에 선제 리셋한다.
pub const DEFAULT_MAX_WARM_TASKS: usize = 5;
pub const DEFAULT_MAX_WARM_TURNS: usize = 35;
/// Warm 재사용 최소 대기 물량(동일 도메인 유사 작업 수).
pub const MIN_QUEUED_FOR_WARM: usize = 3;
/// 에페머럴 강제 파일 수 임계값.
pub const EPHEMERAL_FILE_THRESHOLD: usize = 6;
/// 1차 검증 통과율 손익분기 하한(표본 ≥ 3에서 미만이면 rework 비용이 캐시 이득을 초과).
pub const MIN_FIRST_PASS_RATE: f64 = 0.70;
pub const MIN_FIRST_PASS_SAMPLES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Ephemeral,
    WarmReuse,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionPolicyInput {
    /// 역할 (`coder` · `explore` · `verifier` · `advisor` · `lead` · `sublead`).
    pub role: String,
    /// Merge Danger door (`one-way` | `two-way`).
    pub door: Option<String>,
    /// 예상 수정 파일 수.
    pub estimated_files: usize,
    /// 직전 작업과 같은 디렉터리/도메인인지 여부.
    pub same_domain: bool,
    /// 동일 도메인에 대기 중인 유사 작업 수.
    pub queued_similar: usize,
    /// 최근 연속 실패/rework 횟수.
    pub consecutive_errors: usize,
    /// 현재 Warm 세션에 누적된 작업 수.
    pub session_tasks: usize,
    /// 현재 Warm 세션에 누적된 턴 수.
    pub session_turns: usize,
    /// 현재 Warm 세션에서 컴팩션(요약)이 1회 이상 발생했는지 여부.
    pub compacted: bool,
    /// DB 실측 1차 통과율(0.0..=1.0) 및 표본 수.
    pub first_pass_rate: Option<f64>,
    pub first_pass_samples: usize,
    /// 상한 오버라이드(미지정 시 기본값 사용).
    pub max_warm_tasks: Option<usize>,
    pub max_warm_turns: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionPolicyVerdict {
    pub mode: SessionMode,
    pub should_reset: bool,
    pub reset_reasons: Vec<String>,
    pub reasons: Vec<String>,
    pub max_warm_tasks: usize,
    pub max_warm_turns: usize,
    pub first_pass_rate: Option<f64>,
    pub first_pass_samples: usize,
    pub summary: String,
}

/// 순수 정책 판정 함수 (DB·네트워크·LLM 호출 0).
pub fn evaluate_session_policy(input: &SessionPolicyInput) -> SessionPolicyVerdict {
    let max_tasks = input.max_warm_tasks.unwrap_or(DEFAULT_MAX_WARM_TASKS);
    let max_turns = input.max_warm_turns.unwrap_or(DEFAULT_MAX_WARM_TURNS);
    let role_lc = input.role.trim().to_ascii_lowercase();

    let mut reasons: Vec<String> = Vec::new();
    let mut reset_reasons: Vec<String> = Vec::new();

    // 1) 역할 불변식 — 검증자·자문은 독립성 보장을 위해 항상 에페머럴.
    if matches!(
        role_lc.as_str(),
        "verifier" | "verify" | "advisor" | "carbon"
    ) {
        reasons.push(format!(
            "역할 `{}`은 독립성·확증 편향 차단을 위해 항상 에페머럴(새 세션) 유지",
            if role_lc.is_empty() { "verifier" } else { role_lc.as_str() }
        ));
        return SessionPolicyVerdict {
            mode: SessionMode::Ephemeral,
            should_reset: input.session_tasks > 0 || input.session_turns > 0,
            reset_reasons: if input.session_tasks > 0 || input.session_turns > 0 {
                vec!["독립 역할 세션 재사용 금지".to_string()]
            } else {
                Vec::new()
            },
            reasons,
            max_warm_tasks: max_tasks,
            max_warm_turns: max_turns,
            first_pass_rate: input.first_pass_rate,
            first_pass_samples: input.first_pass_samples,
            summary: "ephemeral — 검증/자문 역할은 항상 새 세션".to_string(),
        };
    }

    // 2) 실행 중 자동 리셋선 (유지 중이던 세션을 버리고 리셋해야 하는 조건)
    if input.consecutive_errors >= 2 {
        let msg = format!("연속 실패/rework {}회(≥2) — 컨텍스트 오염으로 리셋", input.consecutive_errors);
        reset_reasons.push(msg.clone());
        reasons.push(msg);
    }
    if input.compacted {
        let msg = "컴팩션 발생 — 프롬프트 캐시 prefix 깨짐, 유지 실익 소멸로 리셋".to_string();
        reset_reasons.push(msg.clone());
        reasons.push(msg);
    }
    if input.session_tasks >= max_tasks {
        let msg = format!(
            "누적 작업 {}건(상한 {}건) 도달 — 부패 방지 선제 리셋",
            input.session_tasks, max_tasks
        );
        reset_reasons.push(msg.clone());
        reasons.push(msg);
    }
    if input.session_turns >= max_turns {
        let msg = format!(
            "누적 턴 {}회(상한 {}회) 도달 — 부패 방지 선제 리셋",
            input.session_turns, max_turns
        );
        reset_reasons.push(msg.clone());
        reasons.push(msg);
    }

    // 3) 투입 전 3초 정적 필터
    if input
        .door
        .as_deref()
        .map(|d| d.trim().eq_ignore_ascii_case("one-way"))
        .unwrap_or(false)
    {
        reasons.push("door=one-way(되돌리기 어려운 변경) → 에페머럴 격리".to_string());
    }
    if input.estimated_files >= EPHEMERAL_FILE_THRESHOLD {
        reasons.push(format!(
            "예상 수정 파일 {}개(≥{}) → 대형 작업 에페머럴",
            input.estimated_files, EPHEMERAL_FILE_THRESHOLD
        ));
    }
    if !input.same_domain {
        reasons.push("직전 작업과 다른 도메인/디렉터리 → 캐시 적중 이득 없음".to_string());
    }
    if input.queued_similar < MIN_QUEUED_FOR_WARM {
        reasons.push(format!(
            "동일 도메인 대기 작업 {}건(<{}) → 상주 유지 실익 부족",
            input.queued_similar, MIN_QUEUED_FOR_WARM
        ));
    }

    // 4) 실측 손익분기 가드 (1차 통과율)
    if let Some(rate) = input.first_pass_rate {
        if input.first_pass_samples >= MIN_FIRST_PASS_SAMPLES && rate < MIN_FIRST_PASS_RATE {
            let msg = format!(
                "실측 1차 통과율 {:.0}%({}표본 < {:.0}%) — rework 비용이 캐시 이득 초과",
                rate * 100.0,
                input.first_pass_samples,
                MIN_FIRST_PASS_RATE * 100.0
            );
            reset_reasons.push(msg.clone());
            reasons.push(msg);
        }
    }

    let should_reset = !reset_reasons.is_empty();
    let mode = if reasons.is_empty() {
        SessionMode::WarmReuse
    } else {
        SessionMode::Ephemeral
    };

    let summary = match mode {
        SessionMode::WarmReuse => format!(
            "warm_reuse — 동일 도메인 소형 연속 작업({}건 대기, 상한 {}작업/{}턴)",
            input.queued_similar, max_tasks, max_turns
        ),
        SessionMode::Ephemeral => {
            let head = reasons.first().map(String::as_str).unwrap_or("에페머럴 권장");
            if should_reset {
                format!("ephemeral (RESET) — {head}")
            } else {
                format!("ephemeral — {head}")
            }
        }
    };

    SessionPolicyVerdict {
        mode,
        should_reset,
        reset_reasons,
        reasons,
        max_warm_tasks: max_tasks,
        max_warm_turns: max_turns,
        first_pass_rate: input.first_pass_rate,
        first_pass_samples: input.first_pass_samples,
        summary,
    }
}

/// `decision.db`에서 최근 종료된 코딩/스웜 fork 20건의 1차 통과율과 최근 연속 실패 수를 읽는다(읽기전용).
pub fn collect_session_metrics_from_db(
    conn: &Connection,
    project_id: Option<&str>,
) -> (Option<f64>, usize, usize) {
    let sql_scoped = "SELECT status, COALESCE(rework_count, 0) FROM forks \
                      WHERE project_id = ?1 AND status IN ('ok', 'fail', 'abandoned', 'waiting_human') \
                      ORDER BY created_at DESC LIMIT 20";
    let sql_all = "SELECT status, COALESCE(rework_count, 0) FROM forks \
                   WHERE status IN ('ok', 'fail', 'abandoned', 'waiting_human') \
                   ORDER BY created_at DESC LIMIT 20";

    let rows: Vec<(String, i64)> = if let Some(pid) = project_id {
        conn.prepare(sql_scoped)
            .and_then(|mut s| {
                s.query_map([pid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                    .map(|it| it.filter_map(Result::ok).collect())
            })
            .unwrap_or_default()
    } else {
        conn.prepare(sql_all)
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                    .map(|it| it.filter_map(Result::ok).collect())
            })
            .unwrap_or_default()
    };

    if rows.is_empty() {
        return (None, 0, 0);
    }

    let total = rows.len();
    let first_pass = rows
        .iter()
        .filter(|(st, rw)| st == "ok" && *rw == 0)
        .count();
    let mut consecutive_errors = 0usize;
    for (st, rw) in &rows {
        if st == "ok" && *rw == 0 {
            break;
        }
        consecutive_errors += 1;
    }
    (Some(first_pass as f64 / total as f64), total, consecutive_errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warm_candidate() -> SessionPolicyInput {
        SessionPolicyInput {
            role: "coder".to_string(),
            door: Some("two-way".to_string()),
            estimated_files: 2,
            same_domain: true,
            queued_similar: 4,
            consecutive_errors: 0,
            session_tasks: 1,
            session_turns: 8,
            compacted: false,
            first_pass_rate: Some(0.85),
            first_pass_samples: 10,
            max_warm_tasks: None,
            max_warm_turns: None,
        }
    }

    #[test]
    fn small_same_domain_batch_selects_warm_reuse() {
        let v = evaluate_session_policy(&warm_candidate());
        assert_eq!(v.mode, SessionMode::WarmReuse);
        assert!(!v.should_reset);
        assert!(v.reasons.is_empty());
    }

    #[test]
    fn verifier_and_advisor_are_always_ephemeral() {
        for role in ["verifier", "advisor", "carbon"] {
            let mut input = warm_candidate();
            input.role = role.to_string();
            let v = evaluate_session_policy(&input);
            assert_eq!(v.mode, SessionMode::Ephemeral, "role={role}");
            assert!(v.should_reset);
        }
    }

    #[test]
    fn static_pre_filter_forces_ephemeral_on_large_or_one_way_or_small_queue() {
        let mut one_way = warm_candidate();
        one_way.door = Some("one-way".to_string());
        assert_eq!(evaluate_session_policy(&one_way).mode, SessionMode::Ephemeral);

        let mut large = warm_candidate();
        large.estimated_files = 6;
        assert_eq!(evaluate_session_policy(&large).mode, SessionMode::Ephemeral);

        let mut diff_domain = warm_candidate();
        diff_domain.same_domain = false;
        assert_eq!(evaluate_session_policy(&diff_domain).mode, SessionMode::Ephemeral);

        let mut small_q = warm_candidate();
        small_q.queued_similar = 2;
        assert_eq!(evaluate_session_policy(&small_q).mode, SessionMode::Ephemeral);
    }

    #[test]
    fn dynamic_reset_triggers_on_errors_compaction_caps_and_low_first_pass() {
        let mut errs = warm_candidate();
        errs.consecutive_errors = 2;
        let v = evaluate_session_policy(&errs);
        assert_eq!(v.mode, SessionMode::Ephemeral);
        assert!(v.should_reset);

        let mut comp = warm_candidate();
        comp.compacted = true;
        let v = evaluate_session_policy(&comp);
        assert_eq!(v.mode, SessionMode::Ephemeral);
        assert!(v.should_reset);

        let mut cap = warm_candidate();
        cap.session_tasks = DEFAULT_MAX_WARM_TASKS;
        let v = evaluate_session_policy(&cap);
        assert_eq!(v.mode, SessionMode::Ephemeral);
        assert!(v.should_reset);

        let mut low_fp = warm_candidate();
        low_fp.first_pass_rate = Some(0.50);
        low_fp.first_pass_samples = 6;
        let v = evaluate_session_policy(&low_fp);
        assert_eq!(v.mode, SessionMode::Ephemeral);
        assert!(v.should_reset);
    }
}
