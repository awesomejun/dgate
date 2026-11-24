//! Sublead 제안 엔진 (`dg suggest-sublead`, docs/sublead-design.md).
//!
//! decision.db(`forks`·`decision_events`·fork 메타데이터)에서 3축 신호를 읽어
//! LLM 호출 0회로 sublead 도입 여부·추천 수·영역 배치·예상 상한을 산출한다.
//! TS `src/decision/suggestSublead.ts`와 규칙·점수·출력 키가 대칭이다.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize)]
pub struct SubleadSuggestSignals {
    pub active_forks: i64,
    pub rework_or_backprop_count: i64,
    pub avg_verdict_latency_ms: i64,
    pub active_wrap_workers: i64,
    pub active_scopes: Vec<String>,
    pub multi_edit_or_swarm_count: i64,
    pub max_generation_or_attempt: i64,
    pub large_blast_count: i64,
    pub max_subleads_cap: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubleadSuggestResult {
    pub recommended: bool,
    pub load_score: i64,
    pub separation_score: i64,
    pub task_scope_score: i64,
    pub overall_score: i64,
    pub disjoint_groups: Vec<String>,
    pub suggested_subleads: i64,
    pub max_subleads_cap: i64,
    pub summary: String,
    pub signals: SubleadSuggestSignals,
}

fn clamp_cap(raw: Option<i64>) -> i64 {
    match raw {
        Some(v) => v.clamp(2, 4),
        None => 2,
    }
}

fn normalize_scope(raw: &str) -> String {
    raw.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn scopes_overlap(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

/// 활성 `repo_scope` 목록을 겹치지 않는 대표 영역 그룹으로 묶는다.
pub fn group_disjoint_scopes(raw_scopes: &[String]) -> Vec<String> {
    let unique: BTreeSet<String> = raw_scopes
        .iter()
        .map(|s| normalize_scope(s))
        .filter(|s| !s.is_empty())
        .collect();
    let mut sorted: Vec<String> = unique.into_iter().collect();
    sorted.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));

    let mut groups: Vec<String> = Vec::new();
    for scope in sorted {
        if !groups.iter().any(|g| scopes_overlap(g, &scope)) {
            groups.push(scope);
        }
    }
    groups
}

/// 3축 신호로부터 sublead 추천 점수와 문구를 계산한다(순수 함수 — LLM 호출 0).
pub fn evaluate_sublead_suggestion(signals: SubleadSuggestSignals) -> SubleadSuggestResult {
    // 축 1: 리드 세션 부하 (0..100)
    let mut load_score = 0i64;
    if signals.active_forks >= 4 {
        load_score += 40;
    } else if signals.active_forks >= 2 {
        load_score += 20;
    }
    if signals.rework_or_backprop_count >= 2 {
        load_score += 30;
    } else if signals.rework_or_backprop_count >= 1 {
        load_score += 15;
    }
    if signals.avg_verdict_latency_ms >= 300_000 {
        load_score += 15;
    } else if signals.avg_verdict_latency_ms >= 120_000 {
        load_score += 8;
    }
    if signals.active_wrap_workers >= 3 {
        load_score += 15;
    } else if signals.active_wrap_workers >= 2 {
        load_score += 8;
    }
    load_score = load_score.min(100);

    // 축 2: 영역 분리 가능성 (0..100)
    let disjoint_groups = group_disjoint_scopes(&signals.active_scopes);
    let separation_score = match disjoint_groups.len() {
        0 => 0,
        1 => 20,
        2 => 75,
        _ => 100,
    };

    // 축 3: task 범위 (0..100)
    let mut task_scope_score = 0i64;
    if signals.multi_edit_or_swarm_count >= 3 {
        task_scope_score += 40;
    } else if signals.multi_edit_or_swarm_count >= 2 {
        task_scope_score += 25;
    } else if signals.multi_edit_or_swarm_count >= 1 {
        task_scope_score += 10;
    }
    if signals.max_generation_or_attempt >= 3 {
        task_scope_score += 30;
    } else if signals.max_generation_or_attempt >= 2 {
        task_scope_score += 15;
    }
    if signals.large_blast_count >= 1 {
        task_scope_score += 30;
    }
    task_scope_score = task_scope_score.min(100);

    let overall_score = ((load_score + separation_score + task_scope_score) as f64 / 3.0).round() as i64;
    let max_subleads_cap = clamp_cap(signals.max_subleads_cap);
    let recommended = disjoint_groups.len() >= 2
        && (load_score >= 40 || task_scope_score >= 50)
        && overall_score >= 50;
    let suggested_subleads = if recommended {
        (disjoint_groups.len() as i64).max(2).min(max_subleads_cap)
    } else {
        0
    };

    let summary = if recommended {
        format!(
            "sublead {suggested_subleads}개 분리 권장 (상한 {max_subleads_cap}, 3축 점수: 부하 {load_score} · 분리 {separation_score} · 범위 {task_scope_score}) — 비겹침 영역: {}",
            disjoint_groups.join(", ")
        )
    } else {
        format!(
            "단일 리드 유지 권장 (3축 점수: 부하 {load_score} · 분리 {separation_score} · 범위 {task_scope_score}, 비겹침 영역 {}개)",
            disjoint_groups.len()
        )
    };

    SubleadSuggestResult {
        recommended,
        load_score,
        separation_score,
        task_scope_score,
        overall_score,
        disjoint_groups,
        suggested_subleads,
        max_subleads_cap,
        summary,
        signals,
    }
}

/// 사전(proactive) 분해 판정 — fork가 DB에 쌓이기 전, 착수 직전의 대상 경로/영역
/// 목록만으로 병렬 분리 여부를 판정한다(DB 접근 0회, 완전 순수).
///
/// 비겹침 그룹이 2개 이상이면 `recommended = true`이고 추천 수는
/// `min(max_subleads_cap, 그룹 수)`로 상한 클램프된다. 1개 이하이면
/// `recommended = false`(단일 트랙 유지 권장)다.
pub fn evaluate_proactive_scopes(
    scopes: &[String],
    max_subleads_cap: Option<i64>,
) -> SubleadSuggestResult {
    let disjoint_groups = group_disjoint_scopes(scopes);
    let separation_score = match disjoint_groups.len() {
        0 => 0,
        1 => 20,
        2 => 75,
        _ => 100,
    };
    let max_subleads_cap_i = clamp_cap(max_subleads_cap);
    let recommended = disjoint_groups.len() >= 2;
    let suggested_subleads = if recommended {
        (disjoint_groups.len() as i64).min(max_subleads_cap_i)
    } else {
        0
    };

    let summary = if recommended {
        format!(
            "사전 분해 판정: 비겹침 영역 {}개 → 병렬 워커/sublead {}개 분리 권장 (상한 {}) — 영역: {}",
            disjoint_groups.len(),
            suggested_subleads,
            max_subleads_cap_i,
            disjoint_groups.join(", ")
        )
    } else {
        format!(
            "사전 분해 판정: 비겹침 영역 {}개 — 단일 트랙 유지 권장",
            disjoint_groups.len()
        )
    };

    SubleadSuggestResult {
        recommended,
        load_score: 0,
        separation_score,
        task_scope_score: 0,
        overall_score: separation_score,
        disjoint_groups,
        suggested_subleads,
        max_subleads_cap: max_subleads_cap_i,
        summary,
        signals: SubleadSuggestSignals {
            active_scopes: scopes.to_vec(),
            max_subleads_cap,
            ..Default::default()
        },
    }
}

/// decision.db에서 3축 신호를 읽기전용 집계한다.
pub fn collect_sublead_signals_from_db(
    conn: &Connection,
    project_id: Option<&str>,
    active_workers_override: Option<i64>,
    max_subleads_cap: Option<i64>,
    now_ms: i64,
) -> Result<SubleadSuggestSignals, String> {
    let window_start = now_ms - 24 * 60 * 60 * 1000;
    let recent_wrap_start = now_ms - 30 * 60 * 1000;

    let mut signals = SubleadSuggestSignals {
        max_generation_or_attempt: 1,
        max_subleads_cap,
        ..Default::default()
    };

    let sql = if project_id.is_some() {
        "SELECT status, route, tool_class, created_at_ms, closed_at_ms, generation, attempt, metadata_json
         FROM forks WHERE created_at_ms >= ?1 AND project_id = ?2"
    } else {
        "SELECT status, route, tool_class, created_at_ms, closed_at_ms, generation, attempt, metadata_json
         FROM forks WHERE created_at_ms >= ?1"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut latency_sum = 0i64;
    let mut latency_count = 0i64;

    let mut process_row = |status: String,
                           route: String,
                           tool_class: String,
                           created_at_ms: i64,
                           closed_at_ms: Option<i64>,
                           generation: Option<i64>,
                           attempt: Option<i64>,
                           metadata_json: Option<String>| {
        let is_live = status == "open" || status == "rework";
        if is_live {
            signals.active_forks += 1;
        }
        if status == "rework" || status == "backprop_fail" || attempt.unwrap_or(1) > 1 {
            signals.rework_or_backprop_count += 1;
        }
        let dur = closed_at_ms.unwrap_or(now_ms) - created_at_ms;
        if dur >= 0 {
            latency_sum += dur;
            latency_count += 1;
        }
        if is_live && (route == "delegate_swarm" || tool_class == "file_edit") {
            signals.multi_edit_or_swarm_count += 1;
        }
        let gen_att = generation.unwrap_or(1).max(attempt.unwrap_or(1));
        if gen_att > signals.max_generation_or_attempt {
            signals.max_generation_or_attempt = gen_att;
        }
        let meta: Option<Value> = metadata_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok());
        if is_live {
            let scope = meta
                .as_ref()
                .and_then(|m| m.get("repo_scope").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    meta.as_ref()
                        .and_then(|m| m.get("title").and_then(Value::as_str))
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                });
            if let Some(s) = scope {
                signals.active_scopes.push(s.to_string());
            }
        }
        let blast_len = meta
            .as_ref()
            .and_then(|m| m.get("blast_radius").and_then(Value::as_str))
            .map(|s| s.chars().count())
            .unwrap_or(0);
        let door = meta
            .as_ref()
            .and_then(|m| m.get("door").and_then(Value::as_str))
            .unwrap_or("");
        if blast_len >= 80 || door == "one-way" {
            signals.large_blast_count += 1;
        }
    };

    if let Some(pid) = project_id {
        let mut rows = stmt.query(rusqlite::params![window_start, pid]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            process_row(
                r.get(0).unwrap_or_default(),
                r.get(1).unwrap_or_default(),
                r.get(2).unwrap_or_default(),
                r.get(3).unwrap_or(0),
                r.get(4).ok(),
                r.get(5).ok(),
                r.get(6).ok(),
                r.get(7).ok(),
            );
        }
    } else {
        let mut rows = stmt.query(rusqlite::params![window_start]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            process_row(
                r.get(0).unwrap_or_default(),
                r.get(1).unwrap_or_default(),
                r.get(2).unwrap_or_default(),
                r.get(3).unwrap_or(0),
                r.get(4).ok(),
                r.get(5).ok(),
                r.get(6).ok(),
                r.get(7).ok(),
            );
        }
    }

    if latency_count > 0 {
        signals.avg_verdict_latency_ms = latency_sum / latency_count;
    }

    signals.active_wrap_workers = match active_workers_override {
        Some(v) => v,
        None => {
            if let Some(pid) = project_id {
                conn.query_row(
                    "SELECT COUNT(DISTINCT fork_id) FROM decision_events
                     WHERE source = 'wrap' AND ts_ms >= ?1 AND fork_id IS NOT NULL AND project_id = ?2",
                    rusqlite::params![recent_wrap_start, pid],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
            } else {
                conn.query_row(
                    "SELECT COUNT(DISTINCT fork_id) FROM decision_events
                     WHERE source = 'wrap' AND ts_ms >= ?1 AND fork_id IS NOT NULL",
                    rusqlite::params![recent_wrap_start],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
            }
        }
    };

    Ok(signals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_disjoint_scopes_merges_nested_paths_and_separates_siblings() {
        let scopes = vec![
            "crates/dgate-core".into(),
            "crates/dgate-core/src".into(),
            "src/ui".into(),
            "docs/".into(),
        ];
        assert_eq!(
            group_disjoint_scopes(&scopes),
            vec!["docs", "src/ui", "crates/dgate-core"]
        );
    }

    #[test]
    fn evaluate_sublead_suggestion_recommends_only_when_disjoint_and_loaded() {
        // 부하 높아도 단일 영역이면 분리 비권장
        let single_scope = evaluate_sublead_suggestion(SubleadSuggestSignals {
            active_forks: 5,
            rework_or_backprop_count: 3,
            active_scopes: vec!["src/auth".into(), "src/auth/login".into()],
            multi_edit_or_swarm_count: 3,
            max_generation_or_attempt: 3,
            ..Default::default()
        });
        assert!(!single_scope.recommended);
        assert_eq!(single_scope.suggested_subleads, 0);

        // 비겹침 3영역 + 부하 + 대형 작업 → 상한(3) 반영 추천
        let multi = evaluate_sublead_suggestion(SubleadSuggestSignals {
            active_forks: 4,
            rework_or_backprop_count: 2,
            avg_verdict_latency_ms: 350_000,
            active_wrap_workers: 3,
            active_scopes: vec!["crates/core".into(), "crates/gui".into(), "src/ui".into()],
            multi_edit_or_swarm_count: 3,
            max_generation_or_attempt: 2,
            large_blast_count: 1,
            max_subleads_cap: Some(3),
        });
        assert!(multi.recommended);
        assert_eq!(multi.suggested_subleads, 3);
        assert_eq!(multi.disjoint_groups.len(), 3);
    }

    #[test]
    fn evaluate_proactive_scopes_rejects_overlapping_only() {
        let r = evaluate_proactive_scopes(
            &["crates/a".to_string(), "crates/a/sub".to_string()],
            None,
        );
        assert!(!r.recommended);
        assert_eq!(r.suggested_subleads, 0);
        assert_eq!(r.disjoint_groups.len(), 1);
        assert!(r.summary.contains("단일 트랙 유지 권장"));
    }

    #[test]
    fn evaluate_proactive_scopes_recommends_two_disjoint() {
        let r = evaluate_proactive_scopes(
            &["crates/core".to_string(), "crates/tui".to_string()],
            None,
        );
        assert!(r.recommended);
        assert_eq!(r.suggested_subleads, 2);
        assert_eq!(r.disjoint_groups.len(), 2);
    }

    #[test]
    fn evaluate_proactive_scopes_clamps_to_max_cap() {
        let scopes: Vec<String> = (1..=5).map(|i| format!("crates/m{i}")).collect();
        let r = evaluate_proactive_scopes(&scopes, Some(3));
        assert!(r.recommended);
        assert_eq!(r.disjoint_groups.len(), 5);
        assert_eq!(r.suggested_subleads, 3);
        assert_eq!(r.max_subleads_cap, 3);
    }
}
