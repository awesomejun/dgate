//! `dgate-tui` CLI 옵션 — 수동 파서(clap 미사용, 의존성 최소).
//!
//! 기존 `node src/cli.ts --watch` 호출 관례와 호환되는 플래그만 받는다:
//! 관측 대시보드가 기본 모드이며 `--snapshot`은 헤드리스 검증용 1회 출력 경로다.

/// 기본 스냅숏 크기 — brief 계약 140×40.
pub const DEFAULT_COLS: u16 = 140;
pub const DEFAULT_ROWS: u16 = 40;

/// `dgate-tui` CLI 옵션.
#[derive(Debug, Clone, PartialEq)]
pub struct TuiCliOptions {
    /// `--watch` — 라이브 대시보드(기본 모드; 명시 여부만 기록).
    pub watch: bool,
    /// `--watch-db <path>` / `--db <path>` — decision.db 경로 오버라이드
    /// (없으면 `dgate_core::db::resolve_db_path` 우선순위).
    pub db_path: Option<String>,
    /// `--repo <dir>` — 관측 스코프 레포 디렉터리 (없으면 현재 cwd 레포).
    pub repo_dir: Option<String>,
    /// `--all` — 전체 레포 관측으로 시작 (`a` 키로 레포/전체 토글).
    pub all: bool,
    /// `--demo` — DB·hc 없이 내장 데모 스냅숏으로 렌더.
    pub demo: bool,
    /// `--snapshot` — 비대화형 1회 텍스트 스냅숏을 stdout에 출력하고 종료.
    pub snapshot: bool,
    /// `--watch` 선택적 파일 경로(v1 호환 — 현재 구현은 미사용).
    pub watch_path: Option<String>,
    /// `--cols <n>` — 스냅숏 가로 셀 (기본 140).
    pub cols: u16,
    /// `--rows <n>` — 스냅숏 세로 셀 (기본 40).
    pub rows: u16,
    /// `--time <sec>` — 스냅숏 모션 시간 위상 (기본 10.0 — 결정론적 재현용).
    pub time: f64,
    /// `--help` / `-h` — 사용법 출력 후 종료.
    pub help: bool,
}

impl Default for TuiCliOptions {
    fn default() -> Self {
        TuiCliOptions {
            watch: false,
            db_path: None,
            repo_dir: None,
            all: false,
            demo: false,
            snapshot: false,
            watch_path: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            time: 10.0,
            help: false,
        }
    }
}

/// `--help` 출력 텍스트 — main.rs가 그대로 println하고 exit 0 한다.
pub const HELP_TEXT: &str = "\
DGATE TUI (v2) — ratatui 라이브 관측 대시보드

사용법:
  dgate-tui [옵션]

옵션:
  --watch, -w [path]   실시간 라이브 대시보드 (기본 모드)
  --watch-db <path>    SQLite 결정 DB(decision.db) 경로 지정
  --db <path>          --watch-db와 동일
  --repo <dir>         관측 스코프를 특정 레포로 한정 (기본: 현재 cwd 레포)
  --all, -a            전체 레포 관측으로 시작 (a 키로 레포/전체 토글)
  --demo               DB·hc 없이 내장 데모 스냅숏 렌더
  --snapshot           지정 해상도의 텍스트 프레임을 stdout에 1회 출력하고 종료
  --cols <n>           스냅숏 가로 셀 크기 (기본: 140)
  --rows <n>           스냅숏 세로 셀 크기 (기본: 40)
  --time <sec>         스냅숏 모션 시간 위상 (기본: 10.0 — 같은 값이면 같은 프레임)
  --help, -h           이 도움말을 출력하고 종료

단축키:
  q / Ctrl+C           종료
  a                    전체 레포 ↔ 단일 레포 스코프 토글
  r                    즉시 리프레시
  ← / →                워커 카드 선택 이동
  Tab / Shift+Tab      패널 포커스 전환

DB는 항상 읽기전용으로만 엽니다. hc·DB가 없어도 대기 상태로 표시됩니다.
";

/// 인자 벡터 → TuiCliOptions. 값 누락·비숫자 크기·알 수 없는 플래그는 Err.
pub fn parse_tui_cli_options(args: &[String]) -> Result<TuiCliOptions, String> {
    let mut opts = TuiCliOptions::default();
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--help" | "-h" => {
                opts.help = true;
                return Ok(opts);
            }
            "--watch" | "-w" => {
                opts.watch = true;
                // v1 호환 — 다음 인자가 경로(비플래그)면 선택 파일 경로로 흡수.
                if let Some(next) = args.get(i + 1) {
                    if !next.starts_with('-') {
                        opts.watch_path = Some(next.clone());
                        i += 1;
                    }
                }
            }
            "--watch-db" | "--db" | "--repo" | "--project" | "--cols" | "--rows" | "--time" => {
                i += 1;
                let value = args
                    .get(i)
                    .cloned()
                    .filter(|v| {
                        !v.trim().is_empty()
                            && (!v.starts_with('-')
                                || (arg == "--time" && v.parse::<f64>().is_ok()))
                    })
                    .ok_or_else(|| {
                        format!("{} 플래그에 값이 필요합니다 (예: {} <value>)", arg, arg)
                    })?;
                match arg {
                    "--watch-db" | "--db" => opts.db_path = Some(value),
                    "--repo" | "--project" => opts.repo_dir = Some(value),
                    "--cols" => {
                        opts.cols = parse_u16(arg, &value)?;
                    }
                    "--rows" => {
                        opts.rows = parse_u16(arg, &value)?;
                    }
                    _ => {
                        opts.time = parse_f64(arg, &value)?;
                    }
                }
            }
            "--all" | "-a" => opts.all = true,
            "--demo" => opts.demo = true,
            "--snapshot" => opts.snapshot = true,
            other => {
                return Err(format!("알 수 없는 옵션입니다: {}", other));
            }
        }
        i += 1;
    }
    Ok(opts)
}

fn parse_u16(flag: &str, value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("{} 값이 숫자가 아닙니다: {}", flag, value))
        .map(|n| n.max(1))
}

fn parse_f64(flag: &str, value: &str) -> Result<f64, String> {
    value
        .parse::<f64>()
        .map_err(|_| format!("{} 값이 숫자가 아닙니다: {}", flag, value))
        .map(|n| if n.is_finite() { n.max(0.0) } else { 0.0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<TuiCliOptions, String> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse_tui_cli_options(&owned)
    }

    #[test]
    fn defaults_are_watch_mode_with_default_size() {
        let opts = parse(&[]).unwrap();
        assert!(!opts.help);
        assert!(!opts.demo);
        assert!(!opts.snapshot);
        assert_eq!(opts.cols, 140);
        assert_eq!(opts.rows, 40);
    }

    #[test]
    fn parses_all_documented_flags() {
        let opts = parse(&[
            "--watch",
            "--watch-db",
            "/tmp/x.db",
            "--repo",
            "/tmp/repo",
            "--demo",
            "--snapshot",
            "--cols",
            "100",
            "--rows",
            "30",
        ])
        .unwrap();
        assert!(opts.watch);
        assert_eq!(opts.db_path.as_deref(), Some("/tmp/x.db"));
        assert_eq!(opts.repo_dir.as_deref(), Some("/tmp/repo"));
        assert!(opts.demo);
        assert!(opts.snapshot);
        assert_eq!(opts.cols, 100);
        assert_eq!(opts.rows, 30);
    }

    #[test]
    fn db_alias_and_all_and_short_flags() {
        let opts = parse(&["--db", "a.db", "-a", "-w"]).unwrap();
        assert_eq!(opts.db_path.as_deref(), Some("a.db"));
        assert!(opts.all);
        assert!(opts.watch);
        assert_eq!(opts.watch_path, None);
    }

    #[test]
    fn watch_absorbs_optional_path_for_v1_compat() {
        let opts = parse(&["--watch", "/tmp/session.jsonl"]).unwrap();
        assert!(opts.watch);
        assert_eq!(opts.watch_path.as_deref(), Some("/tmp/session.jsonl"));
    }

    #[test]
    fn parses_time_flag_for_deterministic_snapshots() {
        let opts = parse(&["--snapshot", "--time", "0.5"]).unwrap();
        assert_eq!(opts.time, 0.5);
        let opts = parse(&["--time", "-2.5"]).unwrap();
        assert_eq!(opts.time, 0.0, "음수·비유한 값은 0으로 클램프");
        assert_eq!(parse(&[]).unwrap().time, 10.0);
        assert!(parse(&["--time", "abc"]).is_err());
        assert!(parse(&["--time"]).is_err());
    }

    #[test]
    fn help_short_circuits() {
        let opts = parse(&["--bogus-later", "--help"]).unwrap_err();
        assert!(opts.contains("알 수 없는"));
        let opts = parse(&["-h"]).unwrap();
        assert!(opts.help);
        let opts = parse(&["--help"]).unwrap();
        assert!(opts.help);
    }

    #[test]
    fn errors_on_missing_value_and_unknown_flag() {
        assert!(parse(&["--repo"]).is_err());
        assert!(parse(&["--db"]).is_err());
        assert!(parse(&["--cols"]).is_err());
        assert!(parse(&["--cols", "abc"]).is_err());
        assert!(parse(&["--rows", "-1"]).is_err());
        assert!(parse(&["--frobnicate"]).is_err());
        // 플래그처럼 보이는 값은 값으로 받지 않는다.
        assert!(parse(&["--repo", "--demo"]).is_err());
    }
}
