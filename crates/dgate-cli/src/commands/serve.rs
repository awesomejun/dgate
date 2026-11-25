//! `dg serve` — 실시간 OS 프로세스(`ps`/`hc`/`herdr`) + SQLite 결정 게이트 SSE 웹 서버.
//!
//! 외부 크레이트 0개(Rust std `TcpListener` 단독), `127.0.0.1:<port>` 로컬호스트 전용 읽기전용 서버:
//! - `GET /` — 임베드된 실시간 Obsidian Signal 토폴로지 HTML
//! - `GET /api/snapshot` — 현재 스냅숏 JSON
//! - `GET /api/stream` — `text/event-stream` (SSE) 주기적 스냅숏 스트리밍

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    addr.strip_prefix("pid:").and_then(|s| s.parse::<u64>().ok())
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

fn build_web_snapshot(
    db_path: Option<&str>,
    repo_filter: Option<&PathBuf>,
    snapshotter: &mut LiveSyncSnapshotter,
) -> Value {
    let mut merged = snapshotter.tick_now();
    if let Some(dir) = repo_filter {
        let dir_s = dir.to_string_lossy().into_owned();
        merged
            .workers
            .retain(|w| matches_repo_scope(w.cwd.as_deref(), Some(dir_s.as_str())));
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
        "lead": lead,
        "verifiers": verifiers,
        "advisors": advisors,
        "workers": ordered_workers,
        "recent_events": recent_events,
    })
}

fn read_request_path(stream: &mut TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if method != "GET" {
        return None;
    }
    let path = parts.next()?.split('?').next()?.to_string();
    Some(path)
}

fn handle_client(
    mut stream: TcpStream,
    shared_json: Arc<Mutex<String>>,
    poll_ms: u64,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let Some(path) = read_request_path(&mut stream) else {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
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
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(body.as_bytes());
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

    let mut opts = LiveSyncOptions::new(repo_dir);
    opts.repo_filter_dir = repo_filter.clone();
    let mut snapshotter = LiveSyncSnapshotter::new(opts);

    let initial = build_web_snapshot(db_path.as_deref(), repo_filter.as_ref(), &mut snapshotter);
    let shared_json = Arc::new(Mutex::new(
        serde_json::to_string(&initial).unwrap_or_else(|_| "{}".to_string()),
    ));

    // 백그라운드 폴러 스레드 — N개의 SSE 클라이언트가 붙어도 ps/hc 스캔은 1회만 수행
    let bg_json = Arc::clone(&shared_json);
    let bg_db = db_path.clone();
    let bg_repo = repo_filter.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(poll_ms));
        let snap = build_web_snapshot(bg_db.as_deref(), bg_repo.as_ref(), &mut snapshotter);
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
}
