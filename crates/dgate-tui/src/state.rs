//! dgate-tui 스냅숏 조립 계층 — 렌더·이벤트 루프 없이 100% 단위 테스트 가능한 로직.
//!
//! 목적: 라이브 워커 로스터(`live_sync`) + 게이트 텔레메트리(`telemetry`) +
//! `decision_events` 최근 로그를 불변 스냅숏으로 묶어 뷰에 넘긴다.
//!
//! 외부 연결:
//! - `dgate_core::live_sync::LiveSyncSnapshotter::tick_now` — 실제 `hc` 워커 로스터.
//! - `dgate_core::telemetry::read_telemetry_snapshot` — 읽기전용 라우트 사후확률.
//! - `dgate_core::db::open_db(read_only)` — `decision_events` 최근 로그.
//!
//! 주의:
//! - DB는 절대 생성·마이그레이션하지 않는다(`read_only: true` — 파일 없으면 대기 상태).
//! - `hc`·DB 오류는 모두 조용한 폴백 — 관제 화면이 죽지 않는다(§3.5 계약).
//! - 스코프 필터는 표시 단에서 `live_sync::matches_repo_scope`로만 적용한다
//!   (스냅숏터는 항상 전역 관측 — `a` 토글이 스냅숏터 재구성 없이 즉시 반영되게).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use dgate_core::db::{
    open_db_safe, resolve_db_path, resolve_project_identity, OpenDbOptions,
};
use dgate_core::engine::{DecisionBasis, RouteId, ROUTE_IDS};
use dgate_core::live_sync::{
    matches_repo_scope, LiveSyncSnapshotter, LiveWorkerInfo, LiveWorkerSlot, MergedLiveRoster,
};
use dgate_core::redact::redact_secrets;
use dgate_core::telemetry::{
    heuristic_prior_routes, read_telemetry_snapshot, TelemetryRoute,
};

/// 최근 로그 상한 — 하단 패널에 올리는 최대 이벤트 수.
pub const RECENT_LOG_LIMIT: usize = 10;
/// 리프레시 주기(ms) — live_sync 기본 동기화 주기와 동일.
pub const DEFAULT_POLL_MS: u64 = 2000;

// ---------------------------------------------------------------------------
// 스코프 — 단일 레포 | 전체 레포
// ---------------------------------------------------------------------------

/// 관측 스코프 — `--repo <dir>`/`--all`/`a` 토글이 다루는 유일한 축.
#[derive(Debug, Clone, PartialEq)]
pub enum Scope {
    /// 전체 레포 관측 (`--all` 또는 `a` 토글).
    All,
    /// 특정 레포 스코프 (워커 cwd 접두 매칭 — `matches_repo_scope` 계약).
    Repo(PathBuf),
}

impl Scope {
    /// CLI 옵션 → 초기 스코프. `--all`이 우선이고, `--repo` 미지정 시 현재 cwd.
    pub fn initial(repo_dir: Option<&str>, all: bool) -> Self {
        if all {
            return Scope::All;
        }
        let dir = repo_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
        Scope::Repo(dir)
    }

    /// `a` 토글 — Repo ↔ All (repo 기준 디렉터리는 그대로 유지).
    pub fn toggled(&self, repo_dir: &Path) -> Self {
        match self {
            Scope::All => Scope::Repo(repo_dir.to_path_buf()),
            Scope::Repo(_) => Scope::All,
        }
    }

    /// 헤더 표기 — `all` | `repo:<basename>`.
    pub fn label(&self) -> String {
        match self {
            Scope::All => "all".to_string(),
            Scope::Repo(dir) => {
                let base = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| dir.to_string_lossy().into_owned());
                format!("repo:{}", base)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 스냅숏 데이터 형태
// ---------------------------------------------------------------------------

/// 폴러 1틱이 만드는 불변 대시보드 스냅숏 — 뷰는 이 값만 읽는다.
#[derive(Debug, Clone)]
pub struct TuiSnapshot {
    /// `all` | `repo:<name>` — 헤더 스코프 표기.
    pub scope_label: String,
    /// HH:MM:SS 마지막 리프레시 라벨.
    pub updated_at_label: String,
    /// 스코프 필터 적용 후 워커 + 병합 roster 라벨.
    pub roster: MergedLiveRoster,
    /// 스코프 기준 라우트 사후확률(`--all`이면 레포별 표본 가중 집계).
    pub routes: Vec<TelemetryRoute>,
    /// DB 구독이 실제 연결됐는지(`live=false` → 휴리스틱 prior 폴백).
    pub db_live: bool,
    /// `open`/`waiting_human` fork 수.
    pub open_forks: i64,
    pub total_events: i64,
    pub total_forks: i64,
    /// 하단 복귀 카드용 실측 검증 요약(PASS/rework/fail/human).
    pub outcome_counts: dgate_core::stats::ForkOutcomeCounts,
    /// `decision_events` 최근 로그 — 최신순, 리댁션 적용 1줄 요약.
    pub recent_log: Vec<String>,
    /// DEMO 스냅숏 여부 — 헤더 배너·실측 타이머 표시 분기용.
    pub demo: bool,
}

impl TuiSnapshot {
    /// 표시 순서대로 펼친 워커 목록(←/→ 선택 인덱스 기준) —
    /// `view::ordered_card_views`와 동일 경로: 역할 분할 후 sub_workers만
    /// 클러스터링해 "각 클러스터(sublead → 소속 워커) → 미소속" 순으로 나열한다.
    /// sublead는 클러스터 헤더 카드로 목록에 포함된다.
    /// lead·verifier·advisor는 역할 바라서 선택 목록에 들지 않는다.
    pub fn display_workers(&self) -> Vec<&LiveWorkerInfo> {
        let parts = partition_sessions_by_role(&self.roster.workers);
        let clustered = cluster_workers_by_sublead(parts.sub_workers.iter().copied());
        let mut out: Vec<&LiveWorkerInfo> = Vec::new();
        for c in clustered
            .clusters
            .iter()
            .filter(|c| !c.workers.is_empty())
        {
            out.push(c.sublead);
            out.extend(c.workers.iter().copied());
        }
        out.extend(clustered.unowned.iter().copied());
        for c in clustered
            .clusters
            .iter()
            .filter(|c| c.workers.is_empty())
        {
            out.push(c.sublead);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 역할 분할 · sublead 클러스터 (dgate-gui state.rs와 동일 분할 규칙)
// ---------------------------------------------------------------------------

/// 워커 목록을 슬롯 기준 4역할로 분할(순수 함수 — 입력 순서 보존).
/// lead·verifier·advisor는 역할 상태 바로, 나머지(explore·coder·sublead)는
/// Workers 섹션으로 간다 — 역할 세션이 워커 그리드에 중복 배치되지 않게 한다.
#[derive(Debug, Clone, Default)]
pub struct RolePartitions<'a> {
    pub leads: Vec<&'a LiveWorkerInfo>,
    pub verifiers: Vec<&'a LiveWorkerInfo>,
    pub advisors: Vec<&'a LiveWorkerInfo>,
    pub sub_workers: Vec<&'a LiveWorkerInfo>,
}

pub fn partition_sessions_by_role<'a>(workers: &'a [LiveWorkerInfo]) -> RolePartitions<'a> {
    let mut parts = RolePartitions::default();
    for w in workers {
        match w.slot {
            LiveWorkerSlot::Lead => parts.leads.push(w),
            LiveWorkerSlot::Verifier => parts.verifiers.push(w),
            LiveWorkerSlot::Advisor => parts.advisors.push(w),
            _ => parts.sub_workers.push(w),
        }
    }
    parts
}

/// 소유 sublead 1개와 그 아래에 귀속된 워커 묶음.
#[derive(Debug, Clone)]
pub struct SubleadCluster<'a> {
    pub sublead: &'a LiveWorkerInfo,
    pub workers: Vec<&'a LiveWorkerInfo>,
}

/// Workers 파티션의 sublead별 클러스터 분할 결과 — `dgate-gui`와 동일 규칙:
/// - `clusters`: 입력 순서대로 정렬(소속 워커 0개여도 헤더 유지).
/// - `unowned`: sublead에 귀속되지 않은 나머지(종료된 sublead 소유분 포함).
///   sublead 세션 자체는 헤더 역할이므로 `unowned`에 중복 수록하지 않는다.
#[derive(Debug, Clone, Default)]
pub struct WorkerClusterPartitions<'a> {
    pub clusters: Vec<SubleadCluster<'a>>,
    pub unowned: Vec<&'a LiveWorkerInfo>,
}

/// 워커 목록을 소유 sublead별 클러스터 + 미소속 그룹으로 분할(입력 순서 보존).
/// 반환 참조의 생명주기를 원본 로스터에 묶기 위해 `&'a LiveWorkerInfo` 이터레이터를
/// 받는다 — 슬라이스는 `workers.iter()`로, 역할 분할의 `Vec<&_>`는 `iter().copied()`로 넘긴다.
pub fn cluster_workers_by_sublead<'a>(
    workers: impl IntoIterator<Item = &'a LiveWorkerInfo>,
) -> WorkerClusterPartitions<'a> {
    let workers: Vec<&'a LiveWorkerInfo> = workers.into_iter().collect();
    let mut clusters: Vec<SubleadCluster<'a>> = Vec::new();
    let mut index_by_addr: HashMap<&str, usize> = HashMap::new();
    for &w in workers.iter() {
        if w.slot == LiveWorkerSlot::Sublead {
            let idx = clusters.len();
            if !w.address.is_empty() {
                index_by_addr.entry(w.address.as_str()).or_insert(idx);
            }
            if w.address.starts_with("pid:") {
                if let Some(owner) = w
                    .owner_address
                    .as_deref()
                    .filter(|addr| !addr.is_empty())
                {
                    index_by_addr.entry(owner).or_insert(idx);
                }
            }
            clusters.push(SubleadCluster {
                sublead: w,
                workers: Vec::new(),
            });
        }
    }
    let mut unowned: Vec<&'a LiveWorkerInfo> = Vec::new();
    for &w in workers.iter() {
        if w.slot == LiveWorkerSlot::Sublead {
            continue;
        }
        if let Some(owner) = w
            .owner_address
            .as_deref()
            .filter(|addr| !addr.is_empty())
        {
            if let Some(&idx) = index_by_addr.get(owner) {
                clusters[idx].workers.push(w);
                continue;
            }
        }
        unowned.push(w);
    }
    WorkerClusterPartitions { clusters, unowned }
}

/// 클러스터 헤더 1행 라벨(`sublead-auth · 2` — sublead 세션명은 `sublead-*` 규약).
pub fn format_cluster_header_label(cluster: &SubleadCluster<'_>) -> String {
    format!("{} · {}", cluster.sublead.name, cluster.workers.len())
}

/// `liveWorkerSync.ts` `formatSubleadOwnerBadge` 미러 —
/// sublead 카드명(`[repo] sublead · auth`·`sublead-auth` 등)을 짧은 소유 배지(`↳ sublead-auth`)로 정규화.
pub fn format_sublead_owner_badge(sublead_name: &str) -> String {
    // `[repo] ` 접두 제거
    let no_bracket = if let Some(rest) = sublead_name.trim_start().strip_prefix('[') {
        rest.split_once(']').map(|(_, tail)| tail).unwrap_or(sublead_name)
    } else {
        sublead_name
    };
    let mut clean = no_bracket.trim();
    // `sublead · ` 접두 제거 (`·` 중간점 포함 표기들)
    for prefix in ["sublead · ", "sublead·", "sublead ·", "sublead "] {
        if let Some(rest) = clean
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
            .then(|| &clean[prefix.len()..])
        {
            clean = rest;
            break;
        }
    }
    let clean = clean.trim();
    if clean.is_empty() {
        return "↳ sublead".to_string();
    }
    let lower = clean.to_ascii_lowercase();
    if lower.starts_with("sublead-")
        || lower.starts_with("sublead_")
        || lower.starts_with("sub-")
        || lower.starts_with("sub_")
        || lower == "sublead"
    {
        format!("↳ {}", clean)
    } else {
        format!("↳ sublead-{}", clean)
    }
}

/// 워커 카드 열 수 — `dgate-gui` 분할 규칙과 동일:
/// 0→1(빈 상태 박스) · 1→1 · 2→2 · 3→3 · 4+→4열로 2행 랩.
pub fn visible_worker_columns(worker_count: usize) -> usize {
    match worker_count {
        0 => 1,
        1 => 1,
        2 => 2,
        3 => 3,
        _ => 4,
    }
}

/// 세션의 실제 실행 여부 — status가 `done`/`idle`이면 침착 대기로 간주.
pub fn worker_actively_running(w: &LiveWorkerInfo) -> bool {
    !matches!(w.status.as_deref(), Some("done") | Some("idle"))
}

/// 초 단위 경과 → "MM:SS" 0채움(3600초 이상은 "HH:MM:SS").
pub fn format_elapsed_mmss(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

// ---------------------------------------------------------------------------
// 로컬 시각 라벨 (dgate-gui와 동일 규약 — 타임존 라이브러리 없이 localtime 사용)
// ---------------------------------------------------------------------------

/// 로컬 타임존 기준 HH:MM:SS 라벨.
pub fn format_local_time_label(now_ms: i64) -> String {
    let secs = now_ms.div_euclid(1000);
    let (h, m, s) = local_hms(secs);
    format!("{h:02}:{m:02}:{s:02}")
}

/// 로컬 타임존 시/분/초 — Unix: `localtime_r`(스레드 안전).
#[cfg(unix)]
fn local_hms(secs: i64) -> (u32, u32, u32) {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t: libc::time_t = secs as libc::time_t;
    unsafe {
        libc::localtime_r(&t, &mut tm);
    }
    (tm.tm_hour as u32, tm.tm_min as u32, tm.tm_sec as u32)
}

/// MSVCRT `struct tm` 레이아웃 — `_localtime64_s`가 i32 필드 9개를 채운다.
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct WinTm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
}

#[cfg(windows)]
extern "C" {
    fn _localtime64_s(tm: *mut WinTm, time: *const i64) -> i32;
}

/// Windows: MSVCRT `_localtime64_s`(반환 0 = 성공). 실패 시 UTC 폴백.
#[cfg(windows)]
fn local_hms(secs: i64) -> (u32, u32, u32) {
    let mut tm = WinTm::default();
    let t: i64 = secs;
    if unsafe { _localtime64_s(&mut tm, &t) } != 0 {
        return utc_hms(secs);
    }
    (tm.tm_hour as u32, tm.tm_min as u32, tm.tm_sec as u32)
}

/// 그 외 플랫폼: 로컬 타임존 API가 없으므로 UTC로 계산한다.
#[cfg(not(any(unix, windows)))]
fn local_hms(secs: i64) -> (u32, u32, u32) {
    utc_hms(secs)
}

/// UTC 기준 시/분/초.
#[cfg(not(unix))]
fn utc_hms(secs: i64) -> (u32, u32, u32) {
    let day_secs = secs.rem_euclid(86_400);
    (
        (day_secs / 3_600) as u32,
        ((day_secs % 3_600) / 60) as u32,
        (day_secs % 60) as u32,
    )
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 최근 decision_events 로그 — 읽기전용 조회
// ---------------------------------------------------------------------------

/// `decision_events` 최신 `limit`건을 읽기전용으로 조회해 1줄 요약으로 만든다.
/// `project_id`가 있으면 그 레포만 필터, `None`이면 전역.
/// 모든 오류(DB 부재·테이블 부재·잠금)는 빈 벡터 폴백 — 절대 패닉하지 않는다.
pub fn fetch_recent_events(
    db_path: Option<&str>,
    project_id: Option<&str>,
    limit: usize,
) -> Vec<String> {
    let resolved = resolve_db_path(db_path);
    let db_str = resolved.to_string_lossy().into_owned();
    let Some(conn) = open_db_safe(
        Some(db_str.as_str()),
        OpenDbOptions {
            read_only: true,
            busy_timeout_ms: Some(1000),
        },
    ) else {
        return Vec::new();
    };
    let out = query_recent_events(&conn, project_id, limit);
    let _ = conn.close();
    out
}

fn query_recent_events(
    conn: &rusqlite::Connection,
    project_id: Option<&str>,
    limit: usize,
) -> Vec<String> {
    let sql = if project_id.is_some() {
        "SELECT created_at_ms, source, route, tool_name, ok \
         FROM decision_events WHERE project_id = ?1 \
         ORDER BY created_at_ms DESC, event_id DESC LIMIT ?2"
    } else {
        "SELECT created_at_ms, source, route, tool_name, ok \
         FROM decision_events ORDER BY created_at_ms DESC, event_id DESC LIMIT ?1"
    };
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows: Vec<(i64, String, String, String, i64)> = match project_id {
        Some(pid) => stmt
            .query_map(rusqlite::params![pid, limit as i64], event_row)
            .map(|r| r.flatten().collect()),
        None => stmt
            .query_map([limit as i64], event_row)
            .map(|r| r.flatten().collect()),
    }
    .unwrap_or_default();
    rows.iter()
        .map(|(created_ms, source, route, tool_name, ok)| {
            let status = if *ok != 0 { "ok" } else { "fail" };
            let line = format!(
                "{} · [{}] {} · {} — {}",
                format_local_time_label(*created_ms),
                source,
                route,
                tool_name,
                status
            );
            // 리댁션은 표시 문자열에 항상 적용 — 스니펫·도구 인자의 시크릿 누출 방지.
            redact_secrets(&line)
        })
        .collect()
}

fn event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, String, String, String, i64)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

// ---------------------------------------------------------------------------
// 스코프별 라우트 수집 — 레포 단일 | 전체 표본 가중 집계
// ---------------------------------------------------------------------------

/// 워커 cwd → 소속 레포 루트. `.herdr/worktrees/<wt>` 마커가 있으면 그 앞까지,
/// 아니면 cwd 자체 (`dgate-gui`의 repo_root_from_cwd와 동일 규약).
fn repo_root_from_cwd(cwd: Option<&str>) -> Option<PathBuf> {
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty())?;
    let norm = cwd.replace('\\', "/");
    if let Some(idx) = norm.find("/.herdr/worktrees/").filter(|i| *i > 0) {
        return Some(PathBuf::from(&norm[..idx]));
    }
    Some(PathBuf::from(cwd))
}

/// 워커 cwd들에서 중복 없는 레포 루트 목록(첫 등장 순서 보존).
fn unique_repo_roots(workers: &[LiveWorkerInfo]) -> Vec<PathBuf> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out = Vec::new();
    for w in workers {
        if let Some(root) = repo_root_from_cwd(w.cwd.as_deref()) {
            if seen.insert(root.clone()) {
                out.push(root);
            }
        }
    }
    out
}

/// 라우트들의 표본수 가중 평균 집계 — `dgate-gui` aggregate_global_routes와 동일 규칙:
/// 표본 0이면 휴리스틱 prior 폴백, basis는 하나라도 measured면 measured,
/// forced_split은 하나라도 강제면 강제. 절대 0으로 나누지 않는다.
fn aggregate_routes(per_repo: &[Vec<TelemetryRoute>]) -> Vec<TelemetryRoute> {
    let priors = heuristic_prior_routes();
    ROUTE_IDS
        .iter()
        .map(|&id| {
            let matches: Vec<&TelemetryRoute> = per_repo
                .iter()
                .flat_map(|routes| routes.iter().filter(|r| r.id == id))
                .collect();
            let total: i64 = matches.iter().map(|r| r.samples.max(0)).sum();
            if total <= 0 {
                return priors
                    .iter()
                    .find(|r| r.id == id)
                    .cloned()
                    .unwrap_or(TelemetryRoute {
                        id,
                        name: "",
                        p: 0.8,
                        basis: DecisionBasis::Prior,
                        samples: 0,
                        consecutive_errors: 0,
                        forced_split: false,
                    });
            }
            let p = matches
                .iter()
                .map(|r| r.p * r.samples.max(0) as f64)
                .sum::<f64>()
                / total as f64;
            TelemetryRoute {
                id,
                name: matches[0].name,
                p,
                basis: if matches.iter().any(|r| r.basis == DecisionBasis::Measured) {
                    DecisionBasis::Measured
                } else {
                    DecisionBasis::Prior
                },
                samples: total,
                consecutive_errors: matches.iter().map(|r| r.consecutive_errors).max().unwrap_or(0),
                forced_split: matches.iter().any(|r| r.forced_split),
            }
        })
        .collect()
}

/// 스코프 기준 게이트 통계 — Repo면 해당 레포 스냅숏, All이면 레포별 집계.
/// fork/이벤트 카운터는 전역 값(프로젝트 필터 없는 COUNT)이라 어느 스코프에서도
/// 한 번만 읽는다.
fn gate_stats(
    db_path: Option<&str>,
    scope: &Scope,
    workers: &[LiveWorkerInfo],
) -> (Vec<TelemetryRoute>, bool, i64, i64, i64) {
    match scope {
        Scope::Repo(dir) => {
            let snap = read_telemetry_snapshot(db_path, Some(dir));
            (
                snap.routes,
                snap.live,
                snap.open_forks,
                snap.total_events,
                snap.total_forks,
            )
        }
        Scope::All => {
            let base = read_telemetry_snapshot(db_path, None);
            let roots = unique_repo_roots(workers);
            let routes = if roots.is_empty() {
                base.routes.clone()
            } else {
                let per_repo: Vec<Vec<TelemetryRoute>> = roots
                    .iter()
                    .map(|r| read_telemetry_snapshot(db_path, Some(r)).routes)
                    .collect();
                aggregate_routes(&per_repo)
            };
            (
                routes,
                base.live,
                base.open_forks,
                base.total_events,
                base.total_forks,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// 폴러 1틱 — live 로스터 + 읽기전용 DB 조립
// ---------------------------------------------------------------------------

/// 폴러 1틱이 만드는 불변 스냅숏. 어떤 오류(hc 부재·DB 부재·잠금)에도
/// 죽지 않고 대기 상태 스냅숏을 반환한다.
/// - `scope`가 Repo면 워커를 cwd 접두로 필터(`matches_repo_scope` SSOT 계약).
/// - 게이트·로그는 스코프 project_id 기준, fork 카운터는 전역.
pub fn poll_once(
    db_path: Option<&str>,
    scope: &Scope,
    snapshotter: &mut LiveSyncSnapshotter,
) -> TuiSnapshot {
    let merged = snapshotter.tick_now();
    let mut roster = merged;
    if let Scope::Repo(dir) = scope {
        let dir_str = dir.to_string_lossy().into_owned();
        roster
            .workers
            .retain(|w| matches_repo_scope(w.cwd.as_deref(), Some(dir_str.as_str())));
    }
    roster.active_worker_count = roster.workers.len();
    let (routes, db_live, open_forks, total_events, total_forks) =
        gate_stats(db_path, scope, &roster.workers);
    // 최근 로그의 프로젝트 필터 — Repo 스코프는 그 루트의 project_id로 한정.
    let project_id = match scope {
        Scope::Repo(dir) => Some(resolve_project_identity(dir).project_id),
        Scope::All => None,
    };
    let recent_log = fetch_recent_events(db_path, project_id.as_deref(), RECENT_LOG_LIMIT);
    let outcome_counts = open_db_safe(
        db_path,
        OpenDbOptions {
            read_only: true,
            busy_timeout_ms: Some(1500),
        },
    )
    .map(|conn| dgate_core::stats::fetch_fork_outcome_counts(&conn, project_id.as_deref()))
    .unwrap_or_default();
    TuiSnapshot {
        scope_label: scope.label(),
        updated_at_label: format_local_time_label(now_ms()),
        roster,
        routes,
        db_live,
        open_forks,
        total_events,
        total_forks,
        outcome_counts,
        recent_log,
        demo: false,
    }
}

// ---------------------------------------------------------------------------
// 워커 경과 타이머 — 최초 관측 시각 추적기 (뷰 상태가 들고 다님)
// ---------------------------------------------------------------------------

/// 워커 주소별 최초 관측 시각 + done 전환 동결값 — 가짜 타이머 금지 규약:
/// 모르는 주소는 None 반환, done 카드는 완료 순간에 멈춘다.
#[derive(Debug, Default)]
pub struct WorkerClock {
    started_at: HashMap<String, Instant>,
    done_elapsed: HashMap<String, u64>,
}

impl WorkerClock {
    /// 새 스냅숏 반영 — 신규 주소만 찍고(기존 기준점 유지), done 전환 시
    /// 경과를 동결하며, 로스터에서 사라진 주소는 정리한다.
    pub fn observe(&mut self, workers: &[LiveWorkerInfo]) {
        let live: HashSet<&str> = workers.iter().map(|w| w.address.as_str()).collect();
        for w in workers {
            self.started_at
                .entry(w.address.clone())
                .or_insert_with(Instant::now);
            if w.status.as_deref() == Some("done") && !self.done_elapsed.contains_key(&w.address)
            {
                if let Some(&started) = self.started_at.get(&w.address) {
                    self.done_elapsed
                        .insert(w.address.clone(), started.elapsed().as_secs());
                }
            }
        }
        self.started_at.retain(|addr, _| live.contains(addr.as_str()));
        self.done_elapsed
            .retain(|addr, _| live.contains(addr.as_str()));
    }

    /// 워커 경과 초 — DEMO는 결정론적 표본값, LIVE는 최초 관측 기준 실측
    /// (done 동결 우선). 모르는 주소는 None.
    pub fn elapsed_secs(&self, address: &str, demo_idx: Option<usize>) -> Option<u64> {
        if let Some(idx) = demo_idx {
            const DEMO_ELAPSED: [u64; 4] = [42, 78, 29, 105];
            return Some(DEMO_ELAPSED[idx % DEMO_ELAPSED.len()]);
        }
        if let Some(&frozen) = self.done_elapsed.get(address) {
            return Some(frozen);
        }
        self.started_at.get(address).map(|t| t.elapsed().as_secs())
    }
}

// ---------------------------------------------------------------------------
// DEMO 스냅숏 — DB·hc 없이 토폴로지 미리보기 (sublead 클러스터 포함)
// ---------------------------------------------------------------------------

fn demo_worker(
    slot: LiveWorkerSlot,
    name: &str,
    activity: &str,
    short_model: &str,
    owner: Option<&str>,
) -> LiveWorkerInfo {
    LiveWorkerInfo {
        slot,
        badge: format!("{} (실행 중)", short_model),
        short_model: short_model.to_string(),
        model_name: short_model.to_string(),
        address: format!("demo-{}", name),
        owner_address: owner.map(str::to_string),
        name: name.to_string(),
        cwd: Some("/demo/demo-app".to_string()),
        repo_tag: "demo-app".to_string(),
        activity: activity.to_string(),
        status: Some("working".to_string()),
        turn: Some(14),
        cli: short_model.split(':').next().unwrap_or(short_model).to_string(),
        model: short_model.split_once(':').map(|(_, m)| m.to_string()),
        effort: None,
        subagent_warning: None,
        recent_io: Vec::new(),
        recent_output: Vec::new(),
    }
}

fn demo_route(id: RouteId, name: &'static str, p: f64, samples: i64, forced: bool) -> TelemetryRoute {
    TelemetryRoute {
        id,
        name,
        p,
        basis: DecisionBasis::Measured,
        samples,
        consecutive_errors: if forced { 2 } else { 0 },
        forced_split: forced,
    }
}

/// 내장 DEMO 토폴로지 — live DB/hc 없이 3단 레이아웃을 그대로 미리본다.
/// sublead 1개 + 소속 워커 2 + 미소속 워커로 클러스터 렌더 경로도 덮는다.
/// 순수 함수(외부 I/O 없음)이므로 DEMO 모드에서 폴러를 대체해도 부작용이 없다.
pub fn demo_snapshot() -> TuiSnapshot {
    let sublead = demo_worker(
        LiveWorkerSlot::Sublead,
        "sublead-auth",
        "auth 영역 스코프 조율 중",
        "pi:gpt-5.6-luna",
        None,
    );
    let workers = vec![
        demo_worker(
            LiveWorkerSlot::Lead,
            "w-lead-1",
            "작업 분해 · Decision Gate 사전 확정 검토 중",
            "pi:glm-5.3",
            None,
        ),
        sublead.clone(),
        demo_worker(
            LiveWorkerSlot::Coder,
            "w-coder-1",
            "session token 갱신 경로 수정 중",
            "pi:glm-5.3",
            Some(sublead.address.as_str()),
        ),
        demo_worker(
            LiveWorkerSlot::Coder,
            "w-coder-2",
            "auth 미들웨어 테스트 추가 중",
            "devin:sonnet-4.5",
            Some(sublead.address.as_str()),
        ),
        demo_worker(
            LiveWorkerSlot::Explore,
            "w-explore-1",
            "src/ui 레이아웃 구조 탐색 중",
            "pi:gpt-5.6-luna",
            None,
        ),
        demo_worker(
            LiveWorkerSlot::Verifier,
            "w-verify-1",
            "cargo test -p demo-app 결과 교차 검토 중",
            "pi:gpt-6-astra",
            None,
        ),
        demo_worker(
            LiveWorkerSlot::Advisor,
            "w-advisor-1",
            "완료 전 최종 점검 자문 준비 중",
            "zai:glm-5.3-flash",
            None,
        ),
    ];
    let labels = dgate_core::live_sync::RosterDisplayLabels {
        profile_name: "demo".to_string(),
        roster_source: "builtin-demo".to_string(),
        lead: "pi:glm-5.3".to_string(),
        explore: "pi:gpt-5.6-luna".to_string(),
        coder: "pi:glm-5.3".to_string(),
        verifier: "pi:gpt-6-astra".to_string(),
        advisor: "zai:glm-5.3-flash".to_string(),
    };
    TuiSnapshot {
        scope_label: "repo:demo-app".to_string(),
        updated_at_label: "10:42:18".to_string(),
        roster: MergedLiveRoster {
            labels,
            lead_model_name: "pi:glm-5.3".to_string(),
            lead_model_flag: "--model glm-5.3".to_string(),
            verifier_model_name: "pi:gpt-6-astra".to_string(),
            verifier_model_flag: "--model gpt-6-astra".to_string(),
            active_worker_count: workers.len(),
            workers,
        },
        routes: vec![
            demo_route(RouteId::FileSelect, "어느 파일", 0.86, 128, false),
            demo_route(RouteId::ToolSelect, "어느 도구", 0.74, 96, false),
            demo_route(RouteId::RetryOrAbort, "재시도 또는 중단", 0.31, 22, true),
            demo_route(RouteId::DelegateSwarm, "스웜 위임", 0.82, 47, false),
        ],
        db_live: true,
        open_forks: 2,
        total_events: 48,
        total_forks: 16,
        outcome_counts: dgate_core::stats::ForkOutcomeCounts::default(),
        recent_log: vec![
            "10:42:18 · [wrap] delegate_swarm · w-explore-1 — ok".to_string(),
            "10:41:52 · [wrap] tool_select · cargo test — ok".to_string(),
            "10:41:30 · [neon_backprop] retry_or_abort · verdict — ok".to_string(),
            "10:39:44 · [agy_stream] file_select · 작업 분해 — ok".to_string(),
        ],
        demo: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dgate_core::live_sync::{MergedLiveRoster, RosterDisplayLabels};
    use dgate_core::db::open_db;
    use dgate_core::engine::{EventSource, IssueForkInput, RecordInput};
    use dgate_core::engine::{issue_fork, record_tool_outcome};

    fn mk_worker(addr: &str, name: &str, slot: LiveWorkerSlot, owner: Option<&str>) -> LiveWorkerInfo {
        LiveWorkerInfo {
            slot,
            badge: "dev (실행 중)".to_string(),
            short_model: "dev".to_string(),
            model_name: "dev".to_string(),
            address: addr.to_string(),
            owner_address: owner.map(str::to_string),
            name: name.to_string(),
            cwd: Some("/repo/app".to_string()),
            repo_tag: "app".to_string(),
            activity: "작업 중".to_string(),
            status: Some("working".to_string()),
            turn: None,
            cli: "dev".to_string(),
            model: None,
            effort: None,
            subagent_warning: None,
            recent_io: Vec::new(),
            recent_output: Vec::new(),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dgate-tui-test-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scope_initial_and_toggle() {
        assert_eq!(Scope::initial(None, true), Scope::All);
        assert!(matches!(Scope::initial(None, false), Scope::Repo(_)));
        assert_eq!(
            Scope::initial(Some("/tmp/x"), false),
            Scope::Repo(PathBuf::from("/tmp/x"))
        );
        let s = Scope::initial(Some("/tmp/x"), true);
        assert_eq!(s.toggled(Path::new("/tmp/x")), Scope::Repo(PathBuf::from("/tmp/x")));
        assert_eq!(Scope::Repo(PathBuf::from("/tmp/x")).toggled(Path::new("/tmp/x")), Scope::All);
        assert_eq!(Scope::All.label(), "all");
        assert_eq!(Scope::Repo(PathBuf::from("/tmp/x")).label(), "repo:x");
    }

    #[test]
    fn cluster_workers_by_sublead_matches_gui_rules() {
        let sub = mk_worker("tSubA", "sublead-auth", LiveWorkerSlot::Sublead, None);
        let workers = vec![
            mk_worker("pid:1", "w-free", LiveWorkerSlot::Coder, None),
            sub.clone(),
            mk_worker("pid:2", "w-a", LiveWorkerSlot::Coder, Some("tSubA")),
            mk_worker("pid:3", "w-b", LiveWorkerSlot::Explore, Some("tSubA")),
            mk_worker("tSubEmpty", "sublead-idle", LiveWorkerSlot::Sublead, None),
        ];
        let parts = cluster_workers_by_sublead(workers.iter());
        assert_eq!(parts.clusters.len(), 2);
        assert_eq!(parts.clusters[0].workers.len(), 2);
        assert!(parts.clusters[1].workers.is_empty());
        assert_eq!(format_cluster_header_label(&parts.clusters[0]), "sublead-auth · 2");
        assert_eq!(format_cluster_header_label(&parts.clusters[1]), "sublead-idle · 0");
        // sublead 자체는 unowned에 없고, 미소속 1개만 남는다.
        assert_eq!(parts.unowned.len(), 1);
        assert_eq!(parts.unowned[0].name, "w-free");
    }

    #[test]
    fn cluster_workers_indexes_pid_sublead_by_hosting_terminal_owner() {
        let sub = mk_worker(
            "pid:111",
            "sublead-auth",
            LiveWorkerSlot::Sublead,
            Some("tSub"),
        );
        let workers = [
            sub,
            mk_worker("tChild", "coder-hc", LiveWorkerSlot::Coder, Some("tSub")),
            mk_worker("pid:222", "coder-wrap", LiveWorkerSlot::Coder, Some("tSub")),
        ];
        let parts = cluster_workers_by_sublead(workers.iter());
        assert_eq!(parts.clusters.len(), 1);
        assert_eq!(
            parts.clusters[0]
                .workers
                .iter()
                .map(|w| w.address.as_str())
                .collect::<Vec<_>>(),
            vec!["tChild", "pid:222"],
            "children referencing the hosting hc terminal must join the pid:N sublead cluster"
        );
        assert!(parts.unowned.is_empty());
    }

    #[test]
    fn display_workers_puts_active_clusters_before_unowned_and_empty_subleads_last() {
        let mut snap = demo_snapshot();
        let workers = vec![
            mk_worker("tEmpty1", "sublead-empty-1", LiveWorkerSlot::Sublead, None),
            mk_worker("pid:111", "sublead-active", LiveWorkerSlot::Sublead, Some("tActive")),
            mk_worker("tEmpty2", "sublead-empty-2", LiveWorkerSlot::Sublead, None),
            mk_worker("pid:222", "coder-active", LiveWorkerSlot::Coder, Some("tActive")),
            mk_worker("pid:333", "coder-free", LiveWorkerSlot::Coder, None),
            mk_worker("tEmpty3", "sublead-empty-3", LiveWorkerSlot::Sublead, None),
        ];
        snap.roster.active_worker_count = workers.len();
        snap.roster.workers = workers;
        let order: Vec<&str> = snap.display_workers().iter().map(|w| w.name.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "sublead-active",
                "coder-active",
                "coder-free",
                "sublead-empty-1",
                "sublead-empty-2",
                "sublead-empty-3"
            ],
            "non-empty clusters first, then unowned workers, then empty sublead headers"
        );
    }

    #[test]
    fn dead_sublead_workers_fall_back_to_unowned() {
        let workers = vec![
            mk_worker("tSubAlive", "sublead-alive", LiveWorkerSlot::Sublead, None),
            mk_worker("pid:9", "w-orphan", LiveWorkerSlot::Coder, Some("tSubDead")),
        ];
        let parts = cluster_workers_by_sublead(workers.iter());
        assert_eq!(parts.clusters.len(), 1);
        assert_eq!(parts.unowned.len(), 1);
        assert_eq!(parts.unowned[0].name, "w-orphan");
    }

    #[test]
    fn worker_columns_match_gui_split_rule() {
        assert_eq!(visible_worker_columns(0), 1);
        assert_eq!(visible_worker_columns(1), 1);
        assert_eq!(visible_worker_columns(2), 2);
        assert_eq!(visible_worker_columns(3), 3);
        assert_eq!(visible_worker_columns(4), 4);
        assert_eq!(visible_worker_columns(9), 4);
    }

    #[test]
    fn aggregate_routes_weighted_average_and_flags() {
        let a = vec![demo_route(RouteId::FileSelect, "어느 파일", 0.9, 10, false)];
        let b = vec![TelemetryRoute {
            id: RouteId::FileSelect,
            name: "어느 파일",
            p: 0.5,
            basis: DecisionBasis::Prior,
            samples: 30,
            consecutive_errors: 3,
            forced_split: true,
        }];
        let agg = aggregate_routes(&[a, b]);
        let fs = agg.iter().find(|r| r.id == RouteId::FileSelect).unwrap();
        assert_eq!(fs.samples, 40);
        assert!((fs.p - (0.9 * 10.0 + 0.5 * 30.0) / 40.0).abs() < 1e-9);
        assert!(fs.forced_split);
        assert_eq!(fs.basis, DecisionBasis::Measured);
        // 표본 없는 라우트는 prior 폴백.
        let ts = agg.iter().find(|r| r.id == RouteId::ToolSelect).unwrap();
        assert_eq!(ts.samples, 0);
        assert_eq!(ts.basis, DecisionBasis::Prior);
        assert!(ts.p > 0.0);
    }

    #[test]
    fn fetch_recent_events_filters_by_project_and_redacts() {
        let dir = temp_dir("events");
        let db_path = dir.join("decision.db");
        let db_str = db_path.to_string_lossy().into_owned();
        let pid_a = resolve_project_identity(&dir).project_id;
        {
            let conn = open_db(Some(db_str.as_str()), OpenDbOptions::default()).unwrap();
            for i in 0..3 {
                record_tool_outcome(
                    &conn,
                    &RecordInput {
                        project_id: &pid_a,
                        project_label: "T",
                        route: RouteId::FileSelect,
                        tool_class: "file_read",
                        tool_name: "read",
                        ok: i != 2,
                        source: Some(EventSource::Cli),
                        now_ms: Some(1000 + i),
                        ..Default::default()
                    },
                )
                .unwrap();
            }
            // 다른 프로젝트 이벤트 — 필터되면 보이지 않아야 한다.
            record_tool_outcome(
                &conn,
                &RecordInput {
                    project_id: "other-project",
                    project_label: "X",
                    route: RouteId::ToolSelect,
                    tool_class: "shell_exec",
                    tool_name: "ls",
                    ok: true,
                    source: Some(EventSource::Cli),
                    now_ms: Some(2000),
                    ..Default::default()
                },
            )
            .unwrap();
            let _ = issue_fork(
                &conn,
                &IssueForkInput {
                    project_id: &pid_a,
                    project_label: "T",
                    route: RouteId::ToolSelect,
                    tool_class: "shell_exec",
                    decision: "split",
                    p_at_gate: 0.5,
                    basis_at_gate: DecisionBasis::Prior,
                    forced_split: false,
                    conversation_id: None,
                    ttl_ms: None,
                    title: None,
                    metadata: None,
                    now_ms: Some(3000),
                },
            )
            .unwrap();
        }
        // 프로젝트 필터 — other-project의 tool_select 이벤트가 섞이지 않는다.
        let lines = fetch_recent_events(Some(db_str.as_str()), Some(&pid_a), 10);
        assert_eq!(lines.len(), 3, "프로젝트 이벤트만 3건: {:?}", lines);
        assert!(lines.iter().all(|l| l.contains("file_select")));
        // 전역 조회 — 4건 모두.
        let all = fetch_recent_events(Some(db_str.as_str()), None, 10);
        assert_eq!(all.len(), 4);
        assert!(all[0].contains("tool_select"), "최신 이벤트가 먼저: {:?}", all);
        // 없는 DB는 조용히 빈 벡터.
        let missing = fetch_recent_events(Some("/nonexistent/nope.db"), None, 10);
        assert!(missing.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn demo_snapshot_has_sublead_cluster_and_routes() {
        let snap = demo_snapshot();
        assert!(snap.demo);
        // 표시 경로와 동일하게 역할 분할 후 sub_workers만 클러스터링한다.
        let parts = partition_sessions_by_role(&snap.roster.workers);
        let parts = cluster_workers_by_sublead(parts.sub_workers.iter().copied());
        assert_eq!(parts.clusters.len(), 1);
        assert_eq!(parts.clusters[0].workers.len(), 2);
        assert_eq!(parts.unowned.len(), 1, "미소속 sub_worker는 explore 1개");
        assert_eq!(snap.routes.len(), 4);
        assert!(snap.routes.iter().any(|r| r.forced_split));
        // display_workers는 클러스터(sublead → 소속) → 미소속 순.
        let order: Vec<&str> = snap.display_workers().iter().map(|w| w.name.as_str()).collect();
        assert_eq!(
            order,
            vec!["sublead-auth", "w-coder-1", "w-coder-2", "w-explore-1"]
        );
    }

    #[test]
    fn worker_clock_freezes_done_and_drops_gone() {
        let mut clock = WorkerClock::default();
        let w = mk_worker("a1", "w-1", LiveWorkerSlot::Coder, None);
        clock.observe(&[w.clone()]);
        assert!(clock.elapsed_secs("a1", None).is_some());
        let mut done = w.clone();
        done.status = Some("done".to_string());
        clock.observe(&[done]);
        let frozen = clock.elapsed_secs("a1", None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(clock.elapsed_secs("a1", None), Some(frozen), "done 후 동결");
        clock.observe(&[]);
        assert_eq!(clock.elapsed_secs("a1", None), None, "사라진 주소는 정리");
        // 데모 경과는 결정론적.
        assert_eq!(clock.elapsed_secs("zzz", Some(0)), Some(42));
        assert_eq!(clock.elapsed_secs("zzz", Some(4)), Some(42));
    }

    #[test]
    fn display_workers_order_clusters_then_unowned() {
        let sub = mk_worker("s1", "sublead-x", LiveWorkerSlot::Sublead, None);
        let mut snap = demo_snapshot();
        snap.roster = MergedLiveRoster {
            labels: RosterDisplayLabels {
                profile_name: "t".to_string(),
                roster_source: "t".to_string(),
                lead: "l".to_string(),
                explore: "e".to_string(),
                coder: "c".to_string(),
                verifier: "v".to_string(),
                advisor: "a".to_string(),
            },
            lead_model_name: "l".to_string(),
            lead_model_flag: "l".to_string(),
            verifier_model_name: "v".to_string(),
            verifier_model_flag: "v".to_string(),
            active_worker_count: 3,
            workers: vec![
                mk_worker("u1", "w-free", LiveWorkerSlot::Coder, None),
                sub,
                mk_worker("o1", "w-owned", LiveWorkerSlot::Coder, Some("s1")),
            ],
        };
        let order: Vec<&str> = snap.display_workers().iter().map(|w| w.name.as_str()).collect();
        assert_eq!(
            order,
            vec!["sublead-x", "w-owned", "w-free"],
            "클러스터 헤더(sublead) → 소속 → 미소속 순"
        );
    }

    #[test]
    fn elapsed_format_rules() {
        assert_eq!(format_elapsed_mmss(0), "00:00");
        assert_eq!(format_elapsed_mmss(65), "01:05");
        assert_eq!(format_elapsed_mmss(3661), "01:01:01");
        assert_eq!(format_elapsed_mmss(42), "00:42");
    }

    #[test]
    fn sharp_floor_is_imported_not_redeclared() {
        // SHARP_FLOOR는 dgate-core stats의 단일 정의를 그대로 쓴다.
        assert_eq!(dgate_core::stats::SHARP_FLOOR, 0.70);
    }
}
