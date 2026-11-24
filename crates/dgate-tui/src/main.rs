//! dgate-tui 실행 진입점 — `ratatui` + `crossterm` 라이브 관측 대시보드.
//!
//! 목적: `hc` 라이브 워커 로스터와 읽기전용 결정 DB를 3단 레이아웃으로 보여준다.
//! `--snapshot`은 터미널 초기화 없이 텍스트 프레임만 출력하는 헤드리스 경로다.
//!
//! 주의:
//! - 이벤트 루프는 250ms 폴링, 데이터 리프레시는 2000ms — `hc`/SQLite 호출이
//!   매 프레임 도배되지 않게 한다(§3.5 조용한 폴백 계약은 state가 담당).
//! - 종료(q/Ctrl+C) 시 raw 모드 해제·대체 화면 복원을 Drop 가드가 보장한다.

use std::io::{stdout, IsTerminal};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use dgate_core::live_sync::{LiveSyncOptions, LiveSyncSnapshotter};

use dgate_tui::args::{parse_tui_cli_options, TuiCliOptions, HELP_TEXT};
use dgate_tui::state::{
    demo_snapshot, poll_once, Scope, TuiSnapshot, WorkerClock, DEFAULT_POLL_MS,
};
use dgate_tui::view::{render_dashboard, render_to_text, UiState};

/// 터미널 이벤트 폴링 간격 — 데이터 주기(2s)보다 훨씬 짧게 잡아 키 입력을
/// 즉시 반영한다(화면 자체는 마지막 스냅숏으로 그린다).
const EVENT_POLL_MS: u64 = 250;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse_tui_cli_options(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("dgate-tui: {}\n\n{}", e, HELP_TEXT);
            return ExitCode::from(2);
        }
    };
    if opts.help {
        print!("{}", HELP_TEXT);
        return ExitCode::SUCCESS;
    }
    if opts.snapshot {
        return run_snapshot(&opts);
    }
    run_interactive(&opts)
}

/// 스냅숏터의 로스터 탐색 기준 디렉터리 — `--repo` 지정 시 그 레포,
/// 아니면 현재 cwd(프로젝트 오버라이드 roster.json 탐색 계약과 동일).
fn roster_base_dir(opts: &TuiCliOptions) -> PathBuf {
    opts.repo_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
}

/// `--snapshot` — 터미널 초기화 없이 1회 텍스트 프레임을 stdout에 출력.
/// `--demo`면 내장 스냅숏, 아니면 live 1틱을 수집한다(hc·DB 없으면 대기 상태).
fn run_snapshot(opts: &TuiCliOptions) -> ExitCode {
    let snap = if opts.demo {
        demo_snapshot()
    } else {
        let scope = Scope::initial(opts.repo_dir.as_deref(), opts.all);
        let mut snapshotter = LiveSyncSnapshotter::new(LiveSyncOptions::new(roster_base_dir(opts)));
        poll_once(opts.db_path.as_deref(), &scope, &mut snapshotter)
    };
    let text = render_to_text(&snap, &UiState::default(), &WorkerClock::default(), opts.cols, opts.rows);
    println!("{}", text);
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// 인터랙티브 루프
// ---------------------------------------------------------------------------

/// raw 모드 + 대체 화면 해제를 Drop으로 보장 — q·Ctrl+C·패닉·에러 경로
/// 모두에서 터미널이 깨진 채 남지 않게 한다.
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> std::io::Result<Self> {
        enable_raw_mode()?;
        execute!(stdout(), EnterAlternateScreen)?;
        Ok(TerminalGuard)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), LeaveAlternateScreen);
    }
}

/// 인터랙티브 앱 상태 — 스냅숏 캐시 + UI 선택 + 리프레시 타이밍.
struct App {
    opts: TuiCliOptions,
    scope: Scope,
    repo_base: PathBuf,
    snapshotter: Option<LiveSyncSnapshotter>,
    snapshot: Option<TuiSnapshot>,
    ui: UiState,
    clock: WorkerClock,
    last_refresh: Instant,
    quit: bool,
}

impl App {
    fn new(opts: &TuiCliOptions) -> Self {
        let repo_base = roster_base_dir(opts);
        // 스냅숏터는 항상 전역 관측 — 스코프 필터는 표시 단의
        // `matches_repo_scope`로 적용해 `a` 토글이 재구성 없이 즉시 반영된다.
        let snapshotter = if opts.demo {
            None
        } else {
            Some(LiveSyncSnapshotter::new(LiveSyncOptions::new(
                repo_base.clone(),
            )))
        };
        App {
            opts: opts.clone(),
            scope: Scope::initial(opts.repo_dir.as_deref(), opts.all),
            repo_base,
            snapshotter,
            snapshot: None,
            ui: UiState::default(),
            clock: WorkerClock::default(),
            last_refresh: Instant::now() - Duration::from_millis(DEFAULT_POLL_MS),
            quit: false,
        }
    }

    /// 데이터가 stale(≥2s)하거나 아직 없으면 1틱 수집 — DEMO는 내장 스냅숏.
    fn refresh_if_stale(&mut self, force: bool) {
        if self.opts.demo {
            if self.snapshot.is_none() {
                self.snapshot = Some(demo_snapshot());
            }
            return;
        }
        if !force
            && self.snapshot.is_some()
            && self.last_refresh.elapsed() < Duration::from_millis(DEFAULT_POLL_MS)
        {
            return;
        }
        if let Some(snapshotter) = self.snapshotter.as_mut() {
            let snap = poll_once(self.opts.db_path.as_deref(), &self.scope, snapshotter);
            self.clock.observe(&snap.roster.workers);
            self.snapshot = Some(snap);
            self.last_refresh = Instant::now();
        }
        // 선택 인덱스를 표시 목록 범위 안으로 클램프.
        let n = self
            .snapshot
            .as_ref()
            .map(|s| s.display_workers().len())
            .unwrap_or(0);
        if n == 0 {
            self.ui.worker_select = 0;
        } else if self.ui.worker_select >= n {
            self.ui.worker_select = n - 1;
        }
    }

    fn toggle_scope(&mut self) {
        if self.opts.demo {
            return;
        }
        self.scope = self.scope.toggled(&self.repo_base);
        self.ui.worker_select = 0;
        self.refresh_if_stale(true);
    }

    fn move_worker_select(&mut self, delta: isize) {
        let n = self
            .snapshot
            .as_ref()
            .map(|s| s.display_workers().len())
            .unwrap_or(0);
        if n == 0 {
            return;
        }
        let n = n as isize;
        self.ui.worker_select =
            ((self.ui.worker_select as isize + delta).rem_euclid(n)) as usize;
    }

    fn handle_key(&mut self, key: KeyEvent) {
        // Ctrl+C는 어떤 상태에서도 즉시 종료.
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        match key.code {
            // v1 관례 — 'q'와 두벌식 IME 동일 물리 키 'ㅂ' 모두 종료.
            KeyCode::Char('q') | KeyCode::Char('Q') | KeyCode::Char('ㅂ') => self.quit = true,
            KeyCode::Char('a') | KeyCode::Char('A') => self.toggle_scope(),
            KeyCode::Char('r') | KeyCode::Char('R') => self.refresh_if_stale(true),
            KeyCode::Left => self.move_worker_select(-1),
            KeyCode::Right => self.move_worker_select(1),
            KeyCode::Tab => {
                self.ui.focused = if key.modifiers.contains(KeyModifiers::SHIFT) {
                    self.ui.focused.prev()
                } else {
                    self.ui.focused.next()
                };
            }
            KeyCode::BackTab => {
                self.ui.focused = self.ui.focused.prev();
            }
            _ => {}
        }
    }
}

fn run_interactive(opts: &TuiCliOptions) -> ExitCode {
    // 헤드리스 환경(CI·파이프)에서는 대체 화면 진입이 무의미 — 스냅숏 경로 안내 후 종료.
    if !stdout().is_terminal() {
        eprintln!("dgate-tui: 대화형 터미널이 아닙니다 — `--snapshot`으로 1회 출력하세요.");
        return ExitCode::from(2);
    }
    let _guard = match TerminalGuard::enter() {
        Ok(g) => g,
        Err(e) => {
            eprintln!("dgate-tui: 터미널 초기화 실패: {}", e);
            return ExitCode::from(1);
        }
    };
    let backend = CrosstermBackend::new(stdout());
    let mut terminal = match Terminal::new(backend) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("dgate-tui: 터미널 생성 실패: {}", e);
            return ExitCode::from(1);
        }
    };
    let mut app = App::new(opts);
    let mut exit = ExitCode::SUCCESS;
    loop {
        app.refresh_if_stale(false);
        let snap = app.snapshot.clone();
        let ui = app.ui.clone();
        if let Some(snap) = &snap {
            if let Err(e) = terminal.draw(|f| render_dashboard(f, snap, &ui, &app.clock)) {
                eprintln!("dgate-tui: 렌더 실패: {}", e);
                exit = ExitCode::from(1);
                break;
            }
        }
        if app.quit {
            break;
        }
        match event::poll(Duration::from_millis(EVENT_POLL_MS)) {
            Ok(true) => match event::read() {
                Ok(Event::Key(key)) => app.handle_key(key),
                Ok(_) => {}
                Err(_) => break,
            },
            Ok(false) => {}
            Err(_) => break,
        }
        if app.quit {
            break;
        }
    }
    exit
}
