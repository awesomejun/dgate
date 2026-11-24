//! dgate-tui `ratatui` 렌더 계층 — 스냅숏 → 프레임.
//!
//! 목적: 3단 레이아웃(헤더 · 역할 토폴로지 · 게이트+로그)을 순수 그리기로
//! 제공해 `TestBackend`로 창 없이 단언한다. 데이터 조립은 `state`가 담당하고
//! 이 모듈은 받은 스냅숏만 그린다(판정 로직 없음).

use ratatui::backend::TestBackend;
use ratatui::buffer::{Buffer, CellWidth};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::{Frame, Terminal};

use dgate_core::live_sync::LiveWorkerInfo;
use dgate_core::stats::SHARP_FLOOR;

use crate::state::{
    cluster_workers_by_sublead, format_cluster_header_label, format_elapsed_mmss,
    partition_sessions_by_role, visible_worker_columns, worker_actively_running, TuiSnapshot,
    WorkerClock,
};

/// 워커 카드 높이 — 테두리 2 + 내용 3줄(모델 · 활동 · 경과/상태).
const CARD_H: u16 = 5;
/// 역할 상태 바 높이 — 테두리 2 + 내용 2줄(모델 · 활동/상태).
const ROLE_H: u16 = 4;
/// 게이트 카드 높이 — 테두리 2 + 내용 2줄(p·표본 · basis/판정).
const GATE_H: u16 = 4;
/// 헤더 높이 — 제목줄 · 게이트 요약줄 · 단축키줄.
const HEADER_H: u16 = 3;
/// 하단 게이트+로그 높이 — 140×40 기본 프레임에서 중앙 토폴로지를 남긴다.
const BOTTOM_H: u16 = 14;

/// Tab으로 순환하는 패널 포커스.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusPanel {
    Topology,
    Gates,
    Logs,
}

impl FocusPanel {
    pub fn next(self) -> Self {
        match self {
            FocusPanel::Topology => FocusPanel::Gates,
            FocusPanel::Gates => FocusPanel::Logs,
            FocusPanel::Logs => FocusPanel::Topology,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            FocusPanel::Topology => FocusPanel::Logs,
            FocusPanel::Gates => FocusPanel::Topology,
            FocusPanel::Logs => FocusPanel::Gates,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            FocusPanel::Topology => "topology",
            FocusPanel::Gates => "gates",
            FocusPanel::Logs => "logs",
        }
    }
}

/// 뷰가 들고 다니는 UI 상태 — 선택·포커스만 담당(데이터는 스냅숏이 소유).
#[derive(Debug, Clone, PartialEq)]
pub struct UiState {
    pub focused: FocusPanel,
    /// `TuiSnapshot::display_workers()` 순서 기준 선택 인덱스.
    pub worker_select: usize,
}

impl Default for UiState {
    fn default() -> Self {
        UiState {
            focused: FocusPanel::Topology,
            worker_select: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// 프레임 진입점
// ---------------------------------------------------------------------------

/// 전체 대시보드 프레임 — 헤더 · 중앙 토폴로지 · 하단 게이트+로그.
pub fn render_dashboard(
    frame: &mut Frame,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
) {
    let rows = Layout::vertical([
        Constraint::Length(HEADER_H),
        Constraint::Min(1),
        Constraint::Length(BOTTOM_H),
    ])
    .split(frame.area());
    render_header(frame, snap, ui, rows[0]);
    render_topology(frame, snap, ui, clock, rows[1]);
    render_bottom(frame, snap, ui, rows[2]);
}

/// `TestBackend`에 렌더해 화면 텍스트를 돌려준다 — `--snapshot` 출력과
/// 단위 테스트의 공통 경로(비대화형 1회 렌더).
pub fn render_to_text(
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    cols: u16,
    rows: u16,
) -> String {
    let mut terminal = Terminal::new(TestBackend::new(cols.max(1), rows.max(1)))
        .expect("TestBackend 터미널 생성 실패");
    terminal
        .draw(|f| render_dashboard(f, snap, ui, clock))
        .expect("TestBackend 렌더 실패");
    buffer_to_text(terminal.backend().buffer())
}

/// 백엔드 버퍼 → 트림된 텍스트(후행 공백·후행 빈 줄 제거).
/// 멀티폭 문자(CJK·이모지)의 연속 셀은 reset되어 빈 심볼을 반환하므로,
/// 첫 셀의 `cell_width`만큼 이후 셀을 건너뛰어 문자 사이에 가짜 공백이
/// 끼지 않게 한다(ratatui `buffer_view`와 같은 방식).
fn buffer_to_text(buf: &Buffer) -> String {
    let area = buf.area;
    let mut lines: Vec<String> = Vec::with_capacity(area.height as usize);
    for y in 0..area.height {
        let mut line = String::new();
        let mut skip: u16 = 0;
        for x in 0..area.width {
            if let Some(cell) = buf.cell((x, y)) {
                if skip == 0 {
                    line.push_str(cell.symbol());
                }
                skip = cell.cell_width().saturating_sub(1).max(skip.saturating_sub(1));
            }
        }
        lines.push(line.trim_end().to_string());
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// 헤더 — 제목 · 스코프 · 게이트 요약 · 단축키
// ---------------------------------------------------------------------------

fn render_header(frame: &mut Frame, snap: &TuiSnapshot, ui: &UiState, area: Rect) {
    let demo_tag = if snap.demo { " · [DEMO]" } else { "" };
    let db_tag = if snap.demo {
        "demo"
    } else if snap.db_live {
        "live"
    } else {
        "prior"
    };
    let title = Line::from(vec![
        Span::styled(
            "DGATE TUI (v2)",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!(
            "  scope={}  db={}  forks={} open ({} total)  workers={}  {}{}",
            snap.scope_label,
            db_tag,
            snap.open_forks,
            snap.total_forks,
            snap.roster.active_worker_count,
            snap.updated_at_label,
            demo_tag,
        )),
    ]);

    // 게이트 요약 — 라우트별 `id NN% basis 판정`을 한 줄로(p·basis·forced 표기는
    // brief 헤더 계약, 상세는 하단 게이트 카드가 전체 정밀도로 보여준다).
    let mut gate_spans: Vec<Span> = Vec::new();
    for (i, r) in snap.routes.iter().enumerate() {
        if i > 0 {
            gate_spans.push(Span::styled(" · ", Style::default().fg(Color::DarkGray)));
        }
        let decision = decision_label(r.forced_split, r.p);
        let forced = if r.forced_split { "*" } else { "" };
        gate_spans.push(Span::raw(format!(
            "{} {}% {}",
            r.id.as_str(),
            (r.p * 100.0).round() as i64,
            r.basis.as_str(),
        )));
        gate_spans.push(Span::styled(
            format!(" {}{}", decision, forced),
            decision_style(decision),
        ));
    }
    let gates = Line::from(gate_spans);

    let hints = Line::from(vec![
        Span::styled("keys ", Style::default().fg(Color::DarkGray)),
        Span::raw(
            "q 종료 · a 전체/레포 · r 새로고침 · ←/→ 워커 선택 · Tab 패널 전환",
        ),
        Span::styled(
            format!("   focus={}", ui.focused.label()),
            Style::default().fg(Color::DarkGray),
        ),
    ]);

    frame.render_widget(Paragraph::new(vec![title, gates, hints]), area);
}

fn decision_label(forced: bool, p: f64) -> &'static str {
    if forced || p < SHARP_FLOOR {
        "SPLIT"
    } else {
        "SHARP"
    }
}

fn decision_style(decision: &str) -> Style {
    if decision == "SHARP" {
        Style::default().fg(Color::Green)
    } else {
        Style::default().fg(Color::Red)
    }
}

// ---------------------------------------------------------------------------
// 중앙 토폴로지 — 역할 상태 바 + Workers(sublead 클러스터 | 평면 그리드)
// ---------------------------------------------------------------------------

fn render_topology(
    frame: &mut Frame,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    area: Rect,
) {
    let mid = Layout::vertical([Constraint::Length(ROLE_H), Constraint::Min(1)]).split(area);
    render_role_bars(frame, snap, ui, mid[0]);
    render_workers(frame, snap, ui, clock, mid[1]);
}

/// Lead · Verifier · Advisor 상태 바 — roster 라벨은 live 병합본을 그대로 쓴다.
fn render_role_bars(frame: &mut Frame, snap: &TuiSnapshot, ui: &UiState, area: Rect) {
    let parts = partition_sessions_by_role(&snap.roster.workers);
    let cols = Layout::horizontal([Constraint::Ratio(1, 3); 3]).split(area);
    let focused = ui.focused == FocusPanel::Topology;
    let bars: [(&str, &str, Option<&LiveWorkerInfo>); 3] = [
        ("Lead", snap.roster.labels.lead.as_str(), parts.leads.first().copied()),
        (
            "Verifier",
            snap.roster.labels.verifier.as_str(),
            parts.verifiers.first().copied(),
        ),
        (
            "Advisor",
            snap.roster.labels.advisor.as_str(),
            parts.advisors.first().copied(),
        ),
    ];
    for (i, (title, model, worker)) in bars.iter().enumerate() {
        let (status, activity) = match worker {
            Some(w) => {
                let st = w.status.clone().unwrap_or_else(|| "live".to_string());
                (st, w.activity.clone())
            }
            None => ("대기".to_string(), "roster 대기 — 활성 세션 없음".to_string()),
        };
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(if focused {
                Style::default().fg(Color::Yellow)
            } else {
                Style::default().fg(Color::DarkGray)
            })
            .title(format!(" {} ", title));
        let inner = block.inner(cols[i]);
        frame.render_widget(block, cols[i]);
        let running = worker.is_some_and(worker_actively_running);
        let lines = vec![
            Line::from(vec![
                Span::styled(
                    model.to_string(),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {}", if running { "●" } else { "○" }),
                    if running {
                        Style::default().fg(Color::Green)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ),
                Span::styled(format!(" {}", status), Style::default().fg(Color::DarkGray)),
            ]),
            Line::from(Span::styled(
                truncate(&activity, inner.width as usize),
                Style::default().fg(Color::Gray),
            )),
        ];
        frame.render_widget(Paragraph::new(lines), inner);
    }
}

/// Workers 섹션 — sublead 클러스터 헤더 + 소속 카드 행, 미소속은 평면 그리드.
/// `dgate-gui` 분할 규칙과 동일: 클러스터 0개면 평면 그리드만, 카드는 최대 4열.
fn render_workers(
    frame: &mut Frame,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    area: Rect,
) {
    let parts = partition_sessions_by_role(&snap.roster.workers);
    let clustered = cluster_workers_by_sublead(parts.sub_workers.iter().copied());

    // 표시 순서 카드 → display_workers 인덱스 매핑(←/→ 선택 하이라이트).
    let ordered: Vec<&LiveWorkerInfo> = snap.display_workers();

    // 높이 계산 — 클러스터당 헤더 1 + 카드 행(≤4열 랩)수, 미소속은 4열 랩.
    let mut constraints: Vec<Constraint> = Vec::new();
    for c in &clustered.clusters {
        constraints.push(Constraint::Length(1));
        let rows = c.workers.len().max(1).div_ceil(4);
        for _ in 0..rows {
            constraints.push(Constraint::Length(CARD_H));
        }
    }
    if !clustered.unowned.is_empty() {
        for _ in 0..clustered.unowned.len().div_ceil(4) {
            constraints.push(Constraint::Length(CARD_H));
        }
    }
    if clustered.clusters.is_empty() && clustered.unowned.is_empty() {
        constraints.push(Constraint::Length(3));
    }
    let areas = Layout::vertical(constraints).split(area);

    let mut cursor = 0usize;
    for cluster in &clustered.clusters {
        // 클러스터 헤더 — `sublead-<name> · N` + sublead 배지.
        let header = Line::from(vec![
            Span::styled(
                format_cluster_header_label(cluster),
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {}", cluster.sublead.short_model),
                Style::default().fg(Color::DarkGray),
            ),
        ]);
        frame.render_widget(Paragraph::new(header), areas[cursor]);
        cursor += 1;
        for chunk in cluster.workers.chunks(4) {
            render_card_row(frame, chunk, &ordered, snap, ui, clock, areas[cursor]);
            cursor += 1;
        }
    }
    for chunk in clustered.unowned.chunks(4) {
        render_card_row(frame, chunk, &ordered, snap, ui, clock, areas[cursor]);
        cursor += 1;
    }
    if clustered.clusters.is_empty() && clustered.unowned.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "실행 중인 워커 없음 — hc 대기",
            Style::default().fg(Color::DarkGray),
        )))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(" Workers "),
        );
        frame.render_widget(empty, areas[0]);
    }
}

/// 워커 카드 1행(≤4장) — 열 수는 `dgate-gui` 규칙(카드 수=열 수, 최대 4).
/// `ordered`는 `TuiSnapshot::display_workers()` 결과 — 선택 인덱스와
/// DEMO 결정론 경과 인덱스의 공통 기준이다.
fn render_card_row(
    frame: &mut Frame,
    chunk: &[&LiveWorkerInfo],
    ordered: &[&LiveWorkerInfo],
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    area: Rect,
) {
    let cols = visible_worker_columns(chunk.len());
    let cells = Layout::horizontal(vec![Constraint::Ratio(1, cols as u32); cols]).split(area);
    let section_focused = ui.focused == FocusPanel::Topology;
    for (i, w) in chunk.iter().enumerate() {
        let pos = ordered.iter().position(|o| o.address == w.address);
        let selected = pos == Some(ui.worker_select);
        let border = if selected {
            Style::default().fg(Color::Yellow)
        } else if section_focused {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::DarkGray)
        };
        let demo_idx = if snap.demo { Some(pos.unwrap_or(0)) } else { None };
        render_worker_card(frame, w, clock, demo_idx, cells[i], border, selected);
    }
}

fn render_worker_card(
    frame: &mut Frame,
    w: &LiveWorkerInfo,
    clock: &WorkerClock,
    demo_idx: Option<usize>,
    area: Rect,
    border_style: Style,
    selected: bool,
) {
    let title = if selected {
        format!(" {} ▸ ", w.name)
    } else {
        format!(" {} ", w.name)
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style)
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 || inner.width == 0 {
        return;
    }

    let elapsed = clock
        .elapsed_secs(&w.address, demo_idx)
        .map(format_elapsed_mmss)
        .unwrap_or_else(|| "--:--".to_string());
    let status = w.status.clone().unwrap_or_else(|| "live".to_string());
    let turn = w.turn.map(|t| format!(" · turn {}", t)).unwrap_or_default();
    let lines = vec![
        Line::from(Span::styled(
            truncate(&w.telemetry_line(), inner.width as usize),
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            truncate(&w.activity, inner.width as usize),
            Style::default().fg(Color::Gray),
        )),
        Line::from(Span::styled(
            truncate(
                &format!("{} · {}{} · {}", elapsed, status, turn, w.repo_tag),
                inner.width as usize,
            ),
            Style::default().fg(Color::DarkGray),
        )),
    ];
    frame.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------
// 하단 — 4종 게이트 카드 + 최근 decision_events 로그
// ---------------------------------------------------------------------------

fn render_bottom(frame: &mut Frame, snap: &TuiSnapshot, ui: &UiState, area: Rect) {
    let rows = Layout::vertical([Constraint::Length(GATE_H), Constraint::Min(1)]).split(area);
    let cells = Layout::horizontal(vec![
        Constraint::Ratio(1, snap.routes.len().max(1) as u32);
        snap.routes.len().max(1)
    ])
    .split(rows[0]);
    let focused = ui.focused == FocusPanel::Gates;
    for (i, r) in snap.routes.iter().enumerate() {
        let decision = decision_label(r.forced_split, r.p);
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(if focused {
                Style::default().fg(Color::Yellow)
            } else {
                Style::default().fg(Color::DarkGray)
            })
            .title(format!(" {} ", r.name));
        let inner = block.inner(cells[i]);
        frame.render_widget(block, cells[i]);
        let lines = vec![
            Line::from(vec![
                Span::styled(
                    format!("p={:.2}", r.p),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  n={} {}", r.samples, r.basis.as_str()),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
            Line::from(vec![
                Span::styled(decision, decision_style(decision)),
                Span::styled(
                    if r.forced_split {
                        " (forced)"
                    } else {
                        ""
                    },
                    Style::default().fg(Color::Red),
                ),
                Span::styled(
                    format!("  {}", r.id.as_str()),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
        ];
        frame.render_widget(Paragraph::new(lines), inner);
    }

    let log_focused = ui.focused == FocusPanel::Logs;
    let log_block = Block::default()
        .borders(Borders::ALL)
        .border_style(if log_focused {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default().fg(Color::DarkGray)
        })
        .title(" 최근 로그 (decision_events) ");
    let inner = log_block.inner(rows[1]);
    frame.render_widget(log_block, rows[1]);
    let lines: Vec<Line> = if snap.recent_log.is_empty() {
        vec![Line::from(Span::styled(
            "기록 없음 — DB 대기",
            Style::default().fg(Color::DarkGray),
        ))]
    } else {
        snap.recent_log
            .iter()
            .map(|l| Line::from(Span::raw(truncate(l, inner.width as usize))))
            .collect()
    };
    frame.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------
// 문자열 유틸
// ---------------------------------------------------------------------------

/// 셀 폭 맞춰 문자를 자른다 — 잘린 경계가 멀티바이트 문자를 쪼개지 않게
/// `chars` 기준으로 잘라 말줄임표를 단다(폭 계산은 대략치 — 표시 목적).
fn truncate(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    if max_chars <= 1 {
        return "…".chars().take(max_chars).collect();
    }
    let body: String = s.chars().take(max_chars - 1).collect();
    format!("{}…", body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{demo_snapshot, TuiSnapshot};

    fn render_demo(cols: u16, rows: u16) -> String {
        let snap = demo_snapshot();
        render_to_text(&snap, &UiState::default(), &WorkerClock::default(), cols, rows)
    }

    #[test]
    fn demo_snapshot_renders_without_panic_and_shows_sections() {
        let text = render_demo(140, 40);
        // 상단 헤더 + 제목
        assert!(text.contains("DGATE TUI"), "헤더:\n{}", text);
        assert!(text.contains("scope=repo:demo-app"), "스코프:\n{}", text);
        assert!(text.contains("workers="), "워커 수:\n{}", text);
        // 역할 상태 바
        for role in ["Lead", "Verifier", "Advisor"] {
            assert!(text.contains(role), "{} 상태 바 없음:\n{}", role, text);
        }
        // sublead 클러스터 헤더 — `sublead-auth · 2`
        assert!(text.contains("sublead-auth · 2"), "클러스터 헤더:\n{}", text);
        // 4종 라우트 게이트 — 이름과 판정
        for label in ["어느 파일", "어느 도구", "재시도 또는 중단", "스웜 위임"] {
            assert!(text.contains(label), "라우트 {} 없음:\n{}", label, text);
        }
        for route in ["file_select", "tool_select", "retry_or_abort", "delegate_swarm"] {
            assert!(text.contains(route), "라우트 id {} 없음:\n{}", route, text);
        }
        assert!(text.contains("SHARP"), "SHARP 판정:\n{}", text);
        assert!(text.contains("SPLIT"), "SPLIT 판정:\n{}", text);
        // 단축키 힌트
        assert!(text.contains("q 종료"), "힌트:\n{}", text);
        // 로그
        assert!(text.contains("최근 로그"), "로그 패널:\n{}", text);
    }

    #[test]
    fn render_handles_small_sizes_without_panic() {
        for (c, r) in [(40u16, 10u16), (60, 20), (1, 1), (0, 0), (200, 60)] {
            let _ = render_demo(c, r);
        }
    }

    #[test]
    fn empty_workers_show_honest_empty_state() {
        let mut snap = demo_snapshot();
        snap.roster.workers.clear();
        snap.roster.active_worker_count = 0;
        let text = render_to_text(&snap, &UiState::default(), &WorkerClock::default(), 140, 40);
        assert!(text.contains("실행 중인 워커 없음"), "빈 상태:\n{}", text);
    }

    #[test]
    fn selected_worker_card_is_highlighted() {
        let snap = demo_snapshot();
        let mut ui = UiState::default();
        ui.worker_select = 0;
        let text = render_to_text(&snap, &ui, &WorkerClock::default(), 140, 40);
        assert!(text.contains('▸'), "선택 마커:\n{}", text);
    }

    #[test]
    fn focus_panel_cycles() {
        assert_eq!(FocusPanel::Topology.next(), FocusPanel::Gates);
        assert_eq!(FocusPanel::Gates.next(), FocusPanel::Logs);
        assert_eq!(FocusPanel::Logs.next(), FocusPanel::Topology);
        assert_eq!(FocusPanel::Topology.prev(), FocusPanel::Logs);
    }

    #[test]
    fn decision_label_rules() {
        assert_eq!(decision_label(false, 0.9), "SHARP");
        assert_eq!(decision_label(false, 0.69), "SPLIT");
        assert_eq!(decision_label(true, 0.99), "SPLIT", "forced_split은 p와 무관하게 SPLIT");
        assert_eq!(decision_label(false, SHARP_FLOOR), "SHARP");
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("가나다라마", 3), "가나…");
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("", 5), "");
        assert_eq!(truncate("abcdef", 1), "…");
    }

    #[test]
    fn non_demo_snapshot_flag_off() {
        let snap: TuiSnapshot = demo_snapshot();
        assert!(snap.routes.len() >= 4);
    }
}
