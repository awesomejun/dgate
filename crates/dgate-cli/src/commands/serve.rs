//! `dg serve` — 실시간 OS 프로세스(`ps`/`hc`/`herdr`) + SQLite 결정 게이트 SSE 웹 서버.
//!
//! 외부 크레이트 0개(Rust std `TcpListener` 단독), `127.0.0.1:<port>` 로컬호스트 전용 읽기전용 서버:
//! - `GET /` — 임베드된 실시간 Obsidian Signal 토폴로지 HTML
//! - `GET /api/snapshot` — 현재 스냅숏 JSON
//! - `GET /api/stream` — `text/event-stream` (SSE) 주기적 스냅숏 스트리밍

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::args::{optional_flag, ParsedArgs};
use crate::util::prelude::*;
use dgate_core::db::{open_db_safe, resolve_project_identity, OpenDbOptions};
use dgate_core::engine::{get_posterior, RouteId};
use dgate_core::live_sync::{
    matches_repo_scope, LiveSyncOptions, LiveSyncSnapshotter, LiveWorkerInfo, LiveWorkerSlot,
};
use dgate_core::stats::{fetch_fork_outcome_counts, ForkOutcomeCounts, SHARP_FLOOR};

const WEB_HTML: &str = include_str!("web_dashboard.html");

const ROUTES: [(&str, RouteId, &str); 4] = [
    ("file_select", RouteId::FileSelect, "어느 파일"),
    ("tool_select", RouteId::ToolSelect, "어느 도구"),
    ("retry_or_abort", RouteId::RetryOrAbort, "재시도 또는 중단"),
    ("delegate_swarm", RouteId::DelegateSwarm, "스웜 위임"),
];

fn parse_pid_from_address(addr: &str) -> Option<u64> {
    addr.strip_prefix("pid:")
        .and_then(|s| s.parse::<u64>().ok())
}

fn worker_to_json(
    w: &LiveWorkerInfo,
    owner_badge: Option<String>,
    cluster_size: Option<usize>,
) -> Value {
    let active = !matches!(w.status.as_deref(), Some("done" | "idle" | "error"));
    json!({
        "address": w.address,
        "pid": parse_pid_from_address(&w.address),
        "owner_address": w.owner_address,
        "owner_badge": owner_badge,
        "cluster_size": cluster_size,
        "empty_sublead": cluster_size == Some(0),
        "slot": w.slot.as_str(),
        "name": w.name,
        "cli": w.cli,
        "model": w.model,
        "effort": w.effort,
        "telemetry": w.telemetry_line(),
        "status": w.status,
        "active": active,
        "activity": w.activity,
        "cwd": w.cwd,
        "repo_tag": w.repo_tag,
        "turn": w.turn,
    })
}

fn format_hms_utc_offset(ms: i64) -> String {
    let secs = (ms / 1000).rem_euclid(86_400);
    // KST(+09:00) 기본 표시 — 간단 로컬 시계용
    let local = (secs + 9 * 3600) % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        local / 3600,
        (local % 3600) / 60,
        local % 60
    )
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn run_command_capture(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).ok()?;
        Some(String::from_utf8_lossy(&buf).to_string())
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let _ = child.wait();
                return reader.join().ok().flatten().map(|s| s.trim().to_string());
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return None,
        }
    }
}

fn parse_git_worktree_count(output: &str) -> usize {
    output
        .lines()
        .filter(|line| line.starts_with("worktree "))
        .count()
}

fn parse_recent_commits_output(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\u{1f}');
            let hash = parts.next()?.trim();
            let subject = parts.next()?.trim();
            let rel_time = parts.next()?.trim();
            if hash.is_empty() {
                return None;
            }
            Some(json!({
                "hash": hash,
                "subject": subject,
                "rel_time": rel_time,
            }))
        })
        .collect()
}

fn git_output(repo_dir: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let dir = repo_dir.to_str()?;
    let mut full_args = vec!["-C", dir];
    full_args.extend_from_slice(args);
    run_command_capture("git", &full_args, timeout).filter(|out| !out.is_empty())
}

fn repo_display_name(repo_dir: &Path) -> String {
    let canonical = repo_dir
        .canonicalize()
        .unwrap_or_else(|_| repo_dir.to_path_buf());
    canonical
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo")
        .to_string()
}

#[derive(Debug, Clone, PartialEq)]
struct LocalPipelineSummary {
    run_id: String,
    phase: String,
    branch: String,
    attempt: u64,
    modified_ms: u128,
}

impl LocalPipelineSummary {
    fn to_json(&self) -> Value {
        json!({
            "run_id": self.run_id,
            "phase": self.phase,
            "branch": self.branch,
            "attempt": self.attempt,
        })
    }
}

fn parse_pipeline_state_document(text: &str) -> Option<(String, String, String, u64)> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let run_id = value.get("run_id").and_then(Value::as_str)?.trim();
    if run_id.is_empty() {
        return None;
    }
    let phase = value
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let branch = value
        .get("branch")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let attempt = value.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    Some((run_id.to_string(), phase, branch, attempt))
}

fn file_modified_ms(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn read_pipeline_summary(path: &Path) -> Option<LocalPipelineSummary> {
    let text = std::fs::read_to_string(path).ok()?;
    let (run_id, phase, branch, attempt) = parse_pipeline_state_document(&text)?;
    Some(LocalPipelineSummary {
        run_id,
        phase,
        branch,
        attempt,
        modified_ms: file_modified_ms(path),
    })
}

fn collect_pipeline_summaries(pipelines_dir: &Path) -> Vec<LocalPipelineSummary> {
    let mut summaries: Vec<LocalPipelineSummary> = std::fs::read_dir(pipelines_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|path| read_pipeline_summary(&path))
        .collect();
    summaries.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.run_id.cmp(&b.run_id))
    });
    summaries
}

fn collect_pipelines_json(pipelines_dir: &Path) -> Value {
    let summaries = collect_pipeline_summaries(pipelines_dir);
    let terminal = |phase: &str| matches!(phase, "ready_pr" | "escalated" | "failed");
    let total = summaries.len();
    let running = summaries
        .iter()
        .filter(|item| !terminal(item.phase.as_str()))
        .count();
    let ready_pr = summaries
        .iter()
        .filter(|item| item.phase == "ready_pr")
        .count();
    let escalated = summaries
        .iter()
        .filter(|item| item.phase == "escalated")
        .count();
    let recent: Vec<Value> = summaries
        .iter()
        .take(8)
        .map(LocalPipelineSummary::to_json)
        .collect();
    json!({
        "total": total,
        "running": running,
        "ready_pr": ready_pr,
        "escalated": escalated,
        "recent": recent,
    })
}

fn collect_local_repo(repo_dir: &Path) -> Value {
    let branch = git_output(
        repo_dir,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(2),
    );
    let head = git_output(
        repo_dir,
        &["log", "-1", "--format=%h %s"],
        Duration::from_secs(2),
    );
    let worktree_count = git_output(
        repo_dir,
        &["worktree", "list", "--porcelain"],
        Duration::from_secs(2),
    )
    .map(|out| parse_git_worktree_count(&out))
    .unwrap_or(0);
    let recent_commits = git_output(
        repo_dir,
        &["log", "-6", "--format=%h%x1f%s%x1f%cr"],
        Duration::from_secs(2),
    )
    .map(|out| parse_recent_commits_output(&out))
    .unwrap_or_default();
    let pipelines = collect_pipelines_json(&repo_dir.join(".herdr").join("pipelines"));

    json!({
        "name": repo_display_name(repo_dir),
        "branch": branch,
        "head": head,
        "worktree_count": worktree_count,
        "recent_commits": recent_commits,
        "pipelines": pipelines,
        "fetched_at": format_hms_utc_offset(now_ms()),
    })
}

struct LocalRepoCache {
    last_refresh: Option<Instant>,
    data: Value,
}

impl LocalRepoCache {
    fn new() -> Self {
        Self {
            last_refresh: None,
            data: json!({}),
        }
    }

    fn snapshot(&mut self, repo_dir: &Path) -> Value {
        let stale = self
            .last_refresh
            .map(|at| at.elapsed() >= Duration::from_secs(5))
            .unwrap_or(true);
        if stale {
            self.data = collect_local_repo(repo_dir);
            self.last_refresh = Some(Instant::now());
        }
        self.data.clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct DiskUsage {
    used_kb: u64,
    total_kb: u64,
    free_kb: u64,
    pct: f64,
}

fn parse_df_k_output(output: &str) -> Option<DiskUsage> {
    let mut fallback = None;
    for line in output.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        let (Ok(total_kb), Ok(used_kb), Ok(free_kb)) = (
            cols[1].parse::<u64>(),
            cols[2].parse::<u64>(),
            cols[3].parse::<u64>(),
        ) else {
            continue;
        };
        let pct = cols[4]
            .trim_end_matches('%')
            .parse::<f64>()
            .unwrap_or_else(|_| {
                if total_kb == 0 {
                    0.0
                } else {
                    used_kb as f64 * 100.0 / total_kb as f64
                }
            });
        let usage = DiskUsage {
            used_kb,
            total_kb,
            free_kb,
            pct,
        };
        if cols.last() == Some(&"/") {
            return Some(usage);
        }
        if fallback.is_none() {
            fallback = Some(usage);
        }
    }
    fallback
}

fn kb_to_gb(kb: u64) -> f64 {
    kb as f64 / 1024.0 / 1024.0
}

fn collect_disk_usage() -> Value {
    let usage = run_command_capture("df", &["-k", "/"], Duration::from_secs(2))
        .as_deref()
        .and_then(parse_df_k_output);
    match usage {
        Some(d) => json!({
            "ok": true,
            "used_gb": round1(kb_to_gb(d.used_kb)),
            "total_gb": round1(kb_to_gb(d.total_kb)),
            "free_gb": round1(kb_to_gb(d.free_kb)),
            "pct": round1(d.pct),
        }),
        None => json!({ "ok": false, "used_gb": 0, "total_gb": 0, "free_gb": 0, "pct": 0 }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RamUsage {
    used_bytes: u64,
    total_bytes: u64,
}

fn bytes_to_gb(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0 / 1024.0
}

fn bytes_to_mb(bytes: u64) -> u64 {
    bytes / 1024 / 1024
}

fn parse_macos_vm_stat(output: &str, total_bytes: u64) -> Option<RamUsage> {
    let mut page_size = 4096u64;
    let mut active = 0u64;
    let mut wired = 0u64;
    let mut compressed = 0u64;
    for line in output.lines() {
        if line.contains("page size of") {
            page_size = line
                .split_whitespace()
                .filter_map(|tok| tok.parse::<u64>().ok())
                .next()
                .unwrap_or(4096);
            continue;
        }
        let Some((name, raw_pages)) = line.split_once(':') else {
            continue;
        };
        let pages = raw_pages
            .trim()
            .trim_end_matches('.')
            .parse::<u64>()
            .unwrap_or(0);
        match name.trim() {
            "Pages active" => active = pages,
            "Pages wired down" => wired = pages,
            "Pages occupied by compressor" => compressed = pages,
            _ => {}
        }
    }
    if total_bytes == 0 {
        return None;
    }
    Some(RamUsage {
        used_bytes: active.saturating_add(wired).saturating_add(compressed) * page_size,
        total_bytes,
    })
}

fn parse_linux_meminfo(output: &str) -> Option<RamUsage> {
    let mut total_kb = None;
    let mut available_kb = None;
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some("MemTotal:"), Some(v)) => total_kb = v.parse::<u64>().ok(),
            (Some("MemAvailable:"), Some(v)) => available_kb = v.parse::<u64>().ok(),
            _ => {}
        }
    }
    let total = total_kb? * 1024;
    let available = available_kb? * 1024;
    Some(RamUsage {
        used_bytes: total.saturating_sub(available),
        total_bytes: total,
    })
}

fn collect_ram_usage() -> Value {
    let usage = if cfg!(target_os = "macos") {
        let total = run_command_capture("sysctl", &["-n", "hw.memsize"], Duration::from_secs(2))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        run_command_capture("vm_stat", &[], Duration::from_secs(2))
            .as_deref()
            .and_then(|out| parse_macos_vm_stat(out, total))
    } else {
        std::fs::read_to_string("/proc/meminfo")
            .ok()
            .as_deref()
            .and_then(parse_linux_meminfo)
    };

    match usage {
        Some(ram) if ram.total_bytes > 0 => json!({
            "ok": true,
            "used_mb": bytes_to_mb(ram.used_bytes),
            "total_gb": round1(bytes_to_gb(ram.total_bytes)),
            "pct": round1(ram.used_bytes as f64 * 100.0 / ram.total_bytes as f64),
        }),
        _ => json!({ "ok": false, "used_mb": 0, "total_gb": 0, "pct": 0 }),
    }
}

fn collect_system_telemetry() -> Value {
    json!({
        "fetched_at": format_hms_utc_offset(now_ms()),
        "disk": collect_disk_usage(),
        "ram": collect_ram_usage(),
    })
}

struct SystemTelemetryCache {
    last_refresh: Option<Instant>,
    data: Value,
}

impl SystemTelemetryCache {
    fn new() -> Self {
        Self {
            last_refresh: None,
            data: json!({ "disk": {}, "ram": {} }),
        }
    }

    fn snapshot(&mut self) -> Value {
        let stale = self
            .last_refresh
            .map(|at| at.elapsed() >= Duration::from_secs(5))
            .unwrap_or(true);
        if stale {
            self.data = collect_system_telemetry();
            self.last_refresh = Some(Instant::now());
        }
        self.data.clone()
    }
}

fn build_web_snapshot(
    db_path: Option<&str>,
    repo_filter: Option<&PathBuf>,
    snapshotter: &mut LiveSyncSnapshotter,
    repo_dir: &Path,
    local_repo_cache: &mut LocalRepoCache,
    system_cache: &mut SystemTelemetryCache,
) -> Value {
    let mut merged = snapshotter.tick_now();
    let host_process_count = merged.workers.len();
    if let Some(dir) = repo_filter {
        let dir_s = dir.to_string_lossy().into_owned();
        merged
            .workers
            .retain(|w| matches_repo_scope(w.cwd.as_deref(), Some(dir_s.as_str())));
    }

    let mut repos: BTreeSet<String> = BTreeSet::new();
    let mut providers: BTreeMap<String, usize> = BTreeMap::new();
    for w in &merged.workers {
        if !w.repo_tag.trim().is_empty() && w.repo_tag != "unknown" {
            repos.insert(w.repo_tag.clone());
        }
        let cli = w.cli.trim();
        if !cli.is_empty() {
            *providers.entry(cli.to_string()).or_insert(0) += 1;
        }
    }

    let mut lead: Option<Value> = None;
    let mut verifiers: Vec<Value> = Vec::new();
    let mut advisors: Vec<Value> = Vec::new();
    let mut sub_workers: Vec<&LiveWorkerInfo> = Vec::new();

    for w in &merged.workers {
        match w.slot {
            LiveWorkerSlot::Lead => {
                if lead.is_none() {
                    lead = Some(worker_to_json(w, None, None));
                }
            }
            LiveWorkerSlot::Verifier => verifiers.push(worker_to_json(w, None, None)),
            LiveWorkerSlot::Advisor => advisors.push(worker_to_json(w, None, None)),
            _ => sub_workers.push(w),
        }
    }

    // Sublead 클러스터 그룹핑 + 활성 클러스터 우선 정렬 (TUI 동일 규칙)
    let mut sublead_idx: HashMap<String, usize> = HashMap::new();
    let mut clusters: Vec<(&LiveWorkerInfo, Vec<&LiveWorkerInfo>)> = Vec::new();
    for &w in &sub_workers {
        if w.slot == LiveWorkerSlot::Sublead {
            let idx = clusters.len();
            if !w.address.is_empty() {
                sublead_idx.entry(w.address.clone()).or_insert(idx);
            }
            if w.address.starts_with("pid:") {
                if let Some(owner) = w.owner_address.as_deref().filter(|s| !s.is_empty()) {
                    sublead_idx.entry(owner.to_string()).or_insert(idx);
                }
            }
            clusters.push((w, Vec::new()));
        }
    }
    let mut unowned: Vec<&LiveWorkerInfo> = Vec::new();
    for &w in &sub_workers {
        if w.slot == LiveWorkerSlot::Sublead {
            continue;
        }
        if let Some(owner) = w.owner_address.as_deref().filter(|s| !s.is_empty()) {
            if let Some(&idx) = sublead_idx.get(owner) {
                clusters[idx].1.push(w);
                continue;
            }
        }
        unowned.push(w);
    }

    let mut ordered_workers: Vec<Value> = Vec::new();
    for (sub, children) in clusters.iter().filter(|(_, c)| !c.is_empty()) {
        let badge = format!("↳ {}", sub.name);
        ordered_workers.push(worker_to_json(sub, None, Some(children.len())));
        for child in children {
            ordered_workers.push(worker_to_json(child, Some(badge.clone()), None));
        }
    }
    for w in unowned {
        ordered_workers.push(worker_to_json(w, None, None));
    }
    for (sub, _) in clusters.iter().filter(|(_, c)| c.is_empty()) {
        ordered_workers.push(worker_to_json(sub, None, Some(0)));
    }

    let lead_active = lead
        .as_ref()
        .and_then(|v| v.get("active"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let verifier_active = verifiers
        .iter()
        .any(|v| v.get("active").and_then(Value::as_bool).unwrap_or(false));
    let active_worker_count = ordered_workers
        .iter()
        .filter(|w| w.get("active").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let mapped_count = merged
        .workers
        .iter()
        .filter(|w| !matches!(w.status.as_deref(), Some("done" | "idle" | "error")))
        .count();
    let effort_level = lead
        .as_ref()
        .and_then(|v| v.get("effort"))
        .and_then(Value::as_str)
        .or_else(|| {
            ordered_workers.iter().find_map(|w| {
                if w.get("active").and_then(Value::as_bool).unwrap_or(false) {
                    w.get("effort").and_then(Value::as_str)
                } else {
                    None
                }
            })
        })
        .unwrap_or("unknown")
        .to_string();

    // DB 통계 (읽기전용, fail-open)
    let project_id = repo_filter.map(|d| resolve_project_identity(d).project_id);
    let mut db_live = false;
    let mut total_forks = 0i64;
    let mut open_forks = 0i64;
    let mut outcomes = ForkOutcomeCounts::default();
    let mut routes: Vec<Value> = Vec::new();
    let mut recent_events: Vec<String> = Vec::new();

    if let Some(conn) = open_db_safe(
        db_path,
        OpenDbOptions {
            read_only: true,
            busy_timeout_ms: Some(1500),
        },
    ) {
        db_live = true;
        outcomes = fetch_fork_outcome_counts(&conn, project_id.as_deref());
        total_forks = conn
            .query_row("SELECT COUNT(*) FROM forks", [], |r| r.get(0))
            .unwrap_or(0);
        open_forks = conn
            .query_row(
                "SELECT COUNT(*) FROM forks WHERE status IN ('open', 'waiting_human')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let pid_key = project_id.as_deref().unwrap_or("");
        for (id, route_enum, label) in ROUTES {
            let post = get_posterior(&conn, pid_key, route_enum, "").ok();
            let (p, samples, basis) = match post {
                Some(pr) => (pr.p, pr.samples, pr.basis.as_str().to_string()),
                None => (0.80, 0, "prior".to_string()),
            };
            let decision = if p < SHARP_FLOOR { "split" } else { "sharp" };
            routes.push(json!({
                "id": id,
                "name": label,
                "p": p,
                "samples": samples,
                "basis": basis,
                "forced_split": false,
                "decision": decision,
            }));
        }
        if let Ok(mut stmt) = conn.prepare(
            "SELECT created_at, source, route, tool, ok FROM decision_events ORDER BY id DESC LIMIT 16",
        ) {
            if let Ok(rows) = stmt.query_map([], |r| {
                let ts: i64 = r.get(0)?;
                let src: String = r.get(1)?;
                let rt: String = r.get(2)?;
                let tool: String = r.get(3)?;
                let ok: i64 = r.get(4)?;
                Ok(format!(
                    "{} · [{}] {} · {} — {}",
                    format_hms_utc_offset(ts),
                    src,
                    rt,
                    tool,
                    if ok == 1 { "ok" } else { "fail" }
                ))
            }) {
                recent_events = rows.filter_map(Result::ok).collect();
            }
        }
    } else {
        for (id, _, label) in ROUTES {
            routes.push(json!({
                "id": id,
                "name": label,
                "p": 0.80,
                "samples": 0,
                "basis": "prior",
                "forced_split": false,
                "decision": "sharp",
            }));
        }
    }

    let scope = match repo_filter {
        Some(p) => p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|n| format!("repo:{n}"))
            .unwrap_or_else(|| "repo".to_string()),
        None => "all".to_string(),
    };

    let failure_pressure = outcomes.rework + outcomes.fail > 0;
    let local_repo_data = local_repo_cache.snapshot(repo_dir);
    let system_data = system_cache.snapshot();
    let active_gates = vec![
        json!({
            "id": "g1-hook-guard",
            "gate": "G1",
            "label": "dg hook --guard",
            "active": lead_active,
            "detail": "코더 투입 전 브리프·범위·완료 기준 점검",
        }),
        json!({
            "id": "g2-wrap-watchdog",
            "gate": "G2",
            "label": "dg wrap watchdog",
            "active": active_worker_count > 0,
            "detail": "하위 워커 스톨·무응답 감시",
        }),
        json!({
            "id": "g1-checkpoint",
            "gate": "G1",
            "label": "dg checkpoint",
            "active": lead_active,
            "detail": "결정 분기 전 작업 상태 체크포인트",
        }),
        json!({
            "id": "g2-backprop",
            "gate": "G2",
            "label": "dg backprop",
            "active": failure_pressure,
            "detail": "연속 오류 신호를 상위 계획으로 역전파",
        }),
        json!({
            "id": "g3-herdr-agent",
            "gate": "G3",
            "label": "herdr agent",
            "active": verifier_active || outcomes.waiting_human > 0,
            "detail": "완료 관문 독립 판정·READY_PR 승격",
        }),
    ];

    json!({
        "timestamp": format_hms_utc_offset(now_ms()),
        "scope": scope,
        "db_live": db_live,
        "total_forks": total_forks,
        "open_forks": open_forks,
        "outcomes": {
            "pass": outcomes.pass,
            "rework": outcomes.rework,
            "fail": outcomes.fail,
            "waiting_human": outcomes.waiting_human,
        },
        "routes": routes,
        "providers": providers,
        "repos": repos.into_iter().collect::<Vec<_>>(),
        "effort_level": effort_level,
        "active_gates": active_gates,
        "lead": lead,
        "verifiers": verifiers,
        "advisors": advisors,
        "workers": ordered_workers,
        "recent_events": recent_events,
        "local_repo": local_repo_data,
        "system": system_data,
        "host_process_count": host_process_count,
        "mapped_count": mapped_count,
    })
}

fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if method != "GET" {
        return None;
    }
    let target = parts.next()?;
    let mut split = target.splitn(2, '?');
    Some(split.next()?.to_string())
}

fn write_json_response(stream: &mut TcpStream, status: &str, body: String) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle_client(mut stream: TcpStream, shared_json: Arc<Mutex<String>>, poll_ms: u64) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let Some(path) = read_request_target(&mut stream) else {
        let _ = stream.write_all(
            b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };

    match path.as_str() {
        "/" | "/index.html" => {
            let body = WEB_HTML.as_bytes();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(body);
        }
        "/api/snapshot" => {
            let body = shared_json
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| "{}".to_string());
            write_json_response(&mut stream, "200 OK", body);
        }
        "/api/stream" => {
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
            if stream.write_all(header.as_bytes()).is_err() {
                return;
            }
            let _ = stream.set_read_timeout(None);
            loop {
                let payload = shared_json
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_else(|_| "{}".to_string());
                let frame = format!("event: snapshot\ndata: {payload}\n\n");
                if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(poll_ms));
            }
        }
        _ => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found");
        }
    }
}

pub fn cmd_serve(args: &ParsedArgs, _json: bool) -> CmdResult {
    let port: u16 = match optional_flag(args, "port") {
        None => 4747,
        Some(raw) => raw.trim().parse::<u16>().map_err(|_| {
            DgError::Usage(crate::args::UsageError(format!(
                "invalid --port \"{raw}\" (expected 1..65535)"
            )))
        })?,
    };
    let poll_ms: u64 = match optional_flag(args, "poll-ms") {
        None => 1500,
        Some(raw) => raw.trim().parse::<u64>().map_err(|_| {
            DgError::Usage(crate::args::UsageError(format!(
                "invalid --poll-ms \"{raw}\" (expected integer ms)"
            )))
        })?,
    }
    .clamp(500, 10_000);

    let repo_filter = optional_flag(args, "repo").map(PathBuf::from);
    let repo_dir = repo_filter
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let db_path = db_flag(args);

    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .map_err(|e| DgError::Fatal(format!("localhost {addr} 바인드 실패: {e}")))?;

    let mut opts = LiveSyncOptions::new(repo_dir.clone());
    opts.repo_filter_dir = repo_filter.clone();
    let mut snapshotter = LiveSyncSnapshotter::new(opts);
    let mut system_cache = SystemTelemetryCache::new();
    let mut local_repo_cache = LocalRepoCache::new();

    let initial = build_web_snapshot(
        db_path.as_deref(),
        repo_filter.as_ref(),
        &mut snapshotter,
        &repo_dir,
        &mut local_repo_cache,
        &mut system_cache,
    );
    let shared_json = Arc::new(Mutex::new(
        serde_json::to_string(&initial).unwrap_or_else(|_| "{}".to_string()),
    ));

    // 백그라운드 폴러 스레드 — N개의 SSE 클라이언트가 붙어도 ps/hc 스캔은 1회만 수행
    let bg_json = Arc::clone(&shared_json);
    let bg_db = db_path.clone();
    let bg_repo = repo_filter.clone();
    let bg_repo_dir = repo_dir.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(poll_ms));
        let snap = build_web_snapshot(
            bg_db.as_deref(),
            bg_repo.as_ref(),
            &mut snapshotter,
            &bg_repo_dir,
            &mut local_repo_cache,
            &mut system_cache,
        );
        if let Ok(text) = serde_json::to_string(&snap) {
            if let Ok(mut guard) = bg_json.lock() {
                *guard = text;
            }
        }
    });

    println!("[dg serve] live SSE dashboard → http://{addr} (poll {poll_ms}ms, Ctrl+C 종료)");
    for incoming in listener.incoming().flatten() {
        let s = Arc::clone(&shared_json);
        std::thread::spawn(move || handle_client(incoming, s, poll_ms));
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pid_extracts_numeric_wrap_pid() {
        assert_eq!(parse_pid_from_address("pid:35307"), Some(35307));
        assert_eq!(parse_pid_from_address("t3m1"), None);
        assert_eq!(parse_pid_from_address("herdr:seat-01"), None);
    }

    #[test]
    fn embedded_web_html_contains_sse_endpoint() {
        assert!(WEB_HTML.contains("/api/stream"));
        assert!(WEB_HTML.contains("/api/snapshot"));
        assert!(WEB_HTML.contains("EventSource"));
    }

    #[test]
    fn embedded_web_html_contains_reference_grade_topology_contract() {
        for needle in [
            "#090c12",
            "min-height: calc(100vh - 96px)",
            "grid-template-columns: repeat(4, minmax(0, 1fr));",
            "dg hook --guard",
            "dg wrap watchdog",
            "dg checkpoint",
            "dg backprop",
            "herdr agent",
            "단일 리드",
            "읽기 전용",
            "하위 에이전트 · OS 프로세스 (ps / hc / herdr)",
            "Decision → Worker → Verify → Merge",
            "라우팅 상세",
            "감사 로그",
            "구성 요소 탐색",
            "판단 펄스",
            "animateMotion",
        ] {
            assert!(
                WEB_HTML.contains(needle),
                "missing dashboard contract: {needle}"
            );
        }
    }

    #[test]
    fn embedded_web_html_contains_local_factory_contract() {
        for needle in [
            "LOCAL TRIGGERS",
            "DGATE / LIVE RUNTIME",
            "LOCAL RESULTS",
            "Dispatch",
            "Brief Gate",
            "Rework / Esc",
            "OS / Herdr",
            "Worktree Commit",
            "Verdict PASS",
            "Checkpoint / Merge",
            "DB Telemetry",
            "로컬 상태",
            "로컬 흐름 시뮬레이션",
            "로컬 파이프라인",
            "최근 로컬 커밋",
            "fiv.co.kr/diagram/",
        ] {
            assert!(
                WEB_HTML.contains(needle),
                "missing local factory contract: {needle}"
            );
        }
        assert!(!WEB_HTML.to_lowercase().contains(concat!("git", "hub")));
    }

    #[test]
    fn parse_df_k_output_reads_root_disk_usage() {
        let fixture = "Filesystem   1024-blocks      Used  Available Capacity iused ifree %iused  Mounted on\n/dev/disk3s1    971563008 245760000 725803000    26%  1000  2000     1%   /\n";
        let usage = parse_df_k_output(fixture).expect("df fixture should parse");
        assert_eq!(usage.total_kb, 971_563_008);
        assert_eq!(usage.used_kb, 245_760_000);
        assert_eq!(usage.free_kb, 725_803_000);
        assert_eq!(usage.pct, 26.0);
    }

    #[test]
    fn parse_git_worktree_count_reads_porcelain_entries() {
        let fixture = "worktree /tmp/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /tmp/repo-wt\nHEAD def456\nbranch refs/heads/feat/x\n";
        assert_eq!(parse_git_worktree_count(fixture), 2);
        assert_eq!(parse_git_worktree_count("branch refs/heads/main\n"), 0);
    }

    #[test]
    fn parse_recent_commits_output_reads_hash_subject_and_relative_time() {
        let fixture = "abc1234\u{1f}implement local repo card\u{1f}2 hours ago\ndef5678\u{1f}fix pipeline parser\u{1f}3 days ago\n";
        let commits = parse_recent_commits_output(fixture);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0]["hash"], "abc1234");
        assert_eq!(commits[0]["subject"], "implement local repo card");
        assert_eq!(commits[0]["rel_time"], "2 hours ago");
    }

    #[test]
    fn pipeline_summary_parser_reads_local_state_files() {
        let dir = tempfile::tempdir().expect("temp pipeline dir");
        std::fs::write(
            dir.path().join("run-a.json"),
            r#"{"schema_version":1,"run_id":"run-a","fork_id":"fk_a","brief_path":"brief.md","branch":"feat/a","phase":"coder_running","attempt":1,"max_reworks":2,"coder_model":"m1","verifier_model":"m2","history":[]}"#,
        )
        .expect("write running pipeline");
        std::fs::write(
            dir.path().join("run-b.json"),
            r#"{"schema_version":1,"run_id":"run-b","fork_id":"fk_b","brief_path":"brief.md","branch":"feat/b","phase":"ready_pr","attempt":0,"max_reworks":2,"coder_model":"m1","verifier_model":"m2","history":[]}"#,
        )
        .expect("write ready pipeline");
        std::fs::write(dir.path().join("ignored.txt"), "{}").expect("write non-json");

        let summaries = collect_pipeline_summaries(dir.path());
        assert_eq!(summaries.len(), 2);
        assert!(summaries.iter().any(|item| item.run_id == "run-a"
            && item.phase == "coder_running"
            && item.branch == "feat/a"
            && item.attempt == 1));
        let aggregate = collect_pipelines_json(dir.path());
        assert_eq!(aggregate["total"], 2);
        assert_eq!(aggregate["running"], 1);
        assert_eq!(aggregate["ready_pr"], 1);
        assert_eq!(aggregate["escalated"], 0);
        assert_eq!(aggregate["recent"].as_array().map(Vec::len), Some(2));
    }
}
