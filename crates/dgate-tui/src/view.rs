//! dgate-tui `ratatui` 렌더 계층 — 스냅숏 → 프레임.
//!
//! 목적: Node 원본(`src/ui/renderApp.ts` + `src/ui/layout.ts`)의 2컬럼 토폴로지
//! 배치(좌측 Advisor + 우측 Lead↔Verifier → Decision Gate → 팬아웃 레일 →
//! Workers 카드 → 팬인 → 다시 Lead)와 실시간 모션(브레일 스피너 · 와이어
//! 흐름 패킷 · 슬라이딩 활동 바)을 `TestBackend`로 창 없이 단언 가능한 순수
//! 그리기로 재현한다. 데이터 조립은 `state`가 담당하고 이 모듈은 받은
//! 스냅숏 + `sim_time`만 그린다(판정 로직 없음).
//!
//! 주의:
//! - 모든 패널·와이어는 `canvas` 절대 좌표 쓰기로 그린다 — ratatui 버퍼는
//!   프레임 간 재사용되므로 프레임 시작 시 전체를 `theme::BG`로 지운다.
//! - `sim_time`은 초 단위 f64 — 스냅숏(`--time`)과 라이브 틱(100ms)이
//!   같은 렌더 경로를 타므로 모션 테스트는 시간만 바꿔 비교한다.

use ratatui::backend::TestBackend;
use ratatui::buffer::{Buffer, CellWidth};
use ratatui::layout::Rect;
use ratatui::{Frame, Terminal};

use dgate_core::live_sync::LiveWorkerInfo;
use dgate_core::stats::SHARP_FLOOR;

use crate::canvas::{
    pad_right_width, spinner_frame, string_width, truncate_width, wrap_by_width, BoxOpts, BoxStyle,
    Canvas, Seg,
};
use crate::layout::{compute_layout, max_card_slots_for, CompactLayout, ComputedLayout, FullLayout};
use crate::state::{
    cluster_workers_by_sublead, format_elapsed_mmss, format_sublead_owner_badge,
    partition_sessions_by_role, worker_actively_running, TuiSnapshot, WorkerClock,
};
use crate::theme::{self, lerp_color};

/// Advisor 자문 트리거 3종 — `src/state/store.ts` `TRIGGER_LABELS` 미러.
const TRIGGER_LABELS: [&str; 3] = ["계획 확정 전", "같은 오류 2회", "완료 전"];
/// 라이브 watch 빈 상태 문구 — 가짜 자리표 카드 대신 정직한 단일 박스.
const EMPTY_WORKERS_MESSAGE: &str = "현재 실행 중인 하위 워커가 없습니다";

// ---------------------------------------------------------------------------
// 패널 포커스 — `src/state/store.ts` FOCUS_ORDER 미러
// ---------------------------------------------------------------------------

/// Tab으로 순환하는 패널 포커스 — 원본 순서 그대로.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusPanel {
    Advisor,
    Main,
    Neon,
    Decision,
    Swarm,
    Logs,
}

impl FocusPanel {
    const ORDER: [FocusPanel; 6] = [
        FocusPanel::Advisor,
        FocusPanel::Main,
        FocusPanel::Neon,
        FocusPanel::Decision,
        FocusPanel::Swarm,
        FocusPanel::Logs,
    ];

    pub fn next(self) -> Self {
        let idx = Self::ORDER.iter().position(|f| *f == self).unwrap_or(0);
        Self::ORDER[(idx + 1) % Self::ORDER.len()]
    }

    pub fn prev(self) -> Self {
        let idx = Self::ORDER.iter().position(|f| *f == self).unwrap_or(0);
        Self::ORDER[(idx + Self::ORDER.len() - 1) % Self::ORDER.len()]
    }

    pub fn label(self) -> &'static str {
        match self {
            FocusPanel::Advisor => "advisor",
            FocusPanel::Main => "main",
            FocusPanel::Neon => "neon",
            FocusPanel::Decision => "decision",
            FocusPanel::Swarm => "swarm",
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
    /// Compact 레이아웃 활성 탭(0=파이프라인 · 1=스웜 · 2=Advisor · 3=기록).
    pub compact_tab: usize,
}

impl Default for UiState {
    fn default() -> Self {
        UiState {
            focused: FocusPanel::Main,
            worker_select: 0,
            compact_tab: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// 파생 뷰 데이터 — live 로스터 → 역할 패널 입력
// ---------------------------------------------------------------------------

/// 클러스터 정렬된 워커 카드 1항목 — `OrderedClusterCard` 미러.
struct CardView<'a> {
    worker: &'a LiveWorkerInfo,
    /// 소유 sublead 짧은 배지(`↳ sublead-auth`) — 미소속·sublead 본인은 None.
    owner_badge: Option<String>,
    /// 클러스터 헤더 카드(sublead 본인)면 소속 워커 수 — `sublead-auth · 2` 표기용.
    cluster_size: Option<usize>,
}

/// `orderSwarmCardsByCluster` 미러 — 각 클러스터(sublead → 소속 워커) → 미소속.
fn ordered_card_views(snap: &TuiSnapshot) -> Vec<CardView<'_>> {
    let parts = partition_sessions_by_role(&snap.roster.workers);
    let clustered = cluster_workers_by_sublead(parts.sub_workers.iter().copied());
    let mut out: Vec<CardView> = Vec::new();
    for cluster in &clustered.clusters {
        let badge = format_sublead_owner_badge(&cluster.sublead.name);
        out.push(CardView {
            worker: cluster.sublead,
            owner_badge: None,
            cluster_size: Some(cluster.workers.len()),
        });
        for w in &cluster.workers {
            out.push(CardView {
                worker: w,
                owner_badge: Some(badge.clone()),
                cluster_size: None,
            });
        }
    }
    for w in &clustered.unowned {
        out.push(CardView {
            worker: w,
            owner_badge: None,
            cluster_size: None,
        });
    }
    out
}

/// Verifier 패널 상태 — hc 상태 문자열을 원본 neonState 4종으로 환원.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NeonState {
    Idle,
    Run,
    Pass,
    Fail,
}

fn neon_state_of(w: Option<&LiveWorkerInfo>) -> NeonState {
    let Some(w) = w else {
        return NeonState::Idle;
    };
    match w.status.as_deref() {
        Some("done") => NeonState::Pass,
        Some("error") | Some("failed") => NeonState::Fail,
        Some("idle") => NeonState::Idle,
        _ => NeonState::Run,
    }
}

/// 프레임 전체에서 공유하는 파생값 묶음 — 각 패널 렌더러의 인자 폭을 줄인다.
struct RoleCtx<'a> {
    lead: Option<&'a LiveWorkerInfo>,
    verifier: Option<&'a LiveWorkerInfo>,
    advisor: Option<&'a LiveWorkerInfo>,
    cards: Vec<CardView<'a>>,
    lead_n: usize,
    worker_n: usize,
    verifier_n: usize,
    advisor_n: usize,
    neon: NeonState,
    lead_active: bool,
    advisor_running: bool,
    /// 활성 자문 트리거(0..2) — Advisor 활동 중이면 최우선 트리거(계획 확정 전→Lead).
    active_trigger: i32,
    /// 카드/와이어 모션 게이트 — `liveMotionOf` 미러(데모 또는 라이브 워커 존재).
    motion: bool,
    has_running_workers: bool,
}

fn build_ctx<'a>(snap: &'a TuiSnapshot, cards: Vec<CardView<'a>>) -> RoleCtx<'a> {
    let parts = partition_sessions_by_role(&snap.roster.workers);
    let lead = parts.leads.first().copied();
    let verifier = parts.verifiers.first().copied();
    let advisor = parts.advisors.first().copied();
    let advisor_running = snap.demo || advisor.is_some_and(worker_actively_running);
    let has_running = parts.sub_workers.iter().any(|w| worker_actively_running(w));
    RoleCtx {
        lead,
        verifier,
        advisor,
        lead_n: parts.leads.len(),
        worker_n: parts.sub_workers.len(),
        verifier_n: parts.verifiers.len(),
        advisor_n: parts.advisors.len(),
        neon: neon_state_of(verifier),
        lead_active: snap.demo || lead.is_some_and(worker_actively_running),
        advisor_running,
        active_trigger: if advisor_running { 0 } else { -1 },
        motion: snap.demo || !cards.is_empty(),
        has_running_workers: snap.demo || has_running,
        cards,
    }
}

/// `effortToGauge` 미러 — 실측 effort 문자열 → `▮▮▮▯ high`형 게이지.
/// 미확인 값은 None(허위 게이지 금지 — `effortKnown === false`와 같은 게이트).
fn effort_to_gauge(effort: Option<&str>) -> Option<String> {
    let s = match effort?.trim().to_lowercase().as_str() {
        "low" => "▮▯▯▯ low",
        "medium" => "▮▮▯▯ medium",
        "high" => "▮▮▮▯ high",
        "max" => "▮▮▮▮ max+",
        _ => return None,
    };
    Some(s.to_string())
}

/// `sortRoutesForDisplay` 미러 — forced → p<floor → 원래 순서 안정 정렬.
fn sorted_route_indices(snap: &TuiSnapshot) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..snap.routes.len()).collect();
    idx.sort_by_key(|&i| {
        let r = &snap.routes[i];
        if r.forced_split {
            0
        } else if r.p < SHARP_FLOOR {
            1
        } else {
            2
        }
    });
    idx
}

// ---------------------------------------------------------------------------
// 프레임 진입점
// ---------------------------------------------------------------------------

/// 전체 대시보드 프레임 — Full(2컬럼 토폴로지) 또는 Compact(탭) 레이아웃.
pub fn render_dashboard(
    frame: &mut Frame,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    sim_time: f64,
) {
    let mut canvas = Canvas::new(frame.buffer_mut());
    let area = canvas.buf.area;
    // 버퍼는 프레임 간 재사용 — 잔여 와이어/패널 문자가 남지 않게 전체를 지운다.
    canvas.fill_rect(area, theme::BG, theme::FG, ' ');

    let card_views = ordered_card_views(snap);
    let visible_count = if card_views.is_empty() {
        1
    } else {
        card_views.len().clamp(1, max_card_slots_for(area.width))
    };
    let ctx = build_ctx(snap, card_views);
    match compute_layout(area.width, area.height, visible_count) {
        ComputedLayout::Full(l) => render_full_layout(&mut canvas, snap, ui, clock, sim_time, &ctx, &l),
        ComputedLayout::Compact(l) => {
            render_compact_layout(&mut canvas, snap, ui, clock, sim_time, &ctx, &l)
        }
    }
}

/// `TestBackend`에 렌더해 화면 텍스트를 돌려준다 — `--snapshot` 출력과
/// 단위 테스트의 공통 경로(비대화형 1회 렌더). `sim_time`은 모션 위상.
pub fn render_to_text(
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    cols: u16,
    rows: u16,
    sim_time: f64,
) -> String {
    let mut terminal = Terminal::new(TestBackend::new(cols.max(1), rows.max(1)))
        .expect("TestBackend 터미널 생성 실패");
    terminal
        .draw(|f| render_dashboard(f, snap, ui, clock, sim_time))
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
// Full 레이아웃 — 원본 renderFullLayout 호출 순서 미러
// ---------------------------------------------------------------------------

fn render_full_layout(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    sim_time: f64,
    ctx: &RoleCtx,
    l: &FullLayout,
) {
    // 1. 상단 크롬 바 (충분한 높이일 때 표시)
    if l.show_chrome {
        render_chrome_bar(cv, snap, l);
    }

    // 2. 헤더 바 + 이중선(═) 구분선
    render_header(
        cv,
        snap,
        ctx,
        l.pad_x as i32,
        l.header_y as i32,
        (l.cols - l.pad_x * 2) as usize,
    );

    // 3. 범례 네비게이션 바
    render_legend_nav(
        cv,
        snap,
        l.pad_x as i32,
        l.nav_y as i32,
        (l.cols - l.pad_x * 2) as usize,
    );

    // 4. 파이프라인 & Advisor 자문 연결 와이어 (패널보다 먼저 그려서 보더와 자연스럽게 접합)
    render_pipeline_wires(cv, snap, ctx, sim_time, l);
    render_advisory_wires(cv, ctx, sim_time, l);

    // 5. 좌측 Advisor 자문 패널
    render_advisor_panel(cv, snap, ui, ctx, sim_time, l);

    // 6. 우측 4단 파이프라인 패널들 + Verifier 교차 검증 패널
    render_main_panel(cv, snap, ui, ctx, sim_time, l);
    render_neon_panel(cv, snap, ui, ctx, sim_time, l);
    render_decision_panel(cv, snap, ui, l);
    render_swarm_section(cv, snap, ui, clock, ctx, sim_time, l);
    render_back_panel(cv, ui, ctx, l);

    // 7. 하단 세션 기록 패널
    render_logs_panel(cv, snap, ui.focused == FocusPanel::Logs, l.logs);

    // 8. 최하단 상태 푸터
    render_footer(
        cv,
        snap,
        ctx,
        l.pad_x as i32,
        l.footer_y as i32,
        (l.cols - l.pad_x * 2) as usize,
    );
}

/// 상단 크롬 바 — 트래픽 라이트 + 중앙 타이틀 + 우측 힌트(`renderFullLayout` 1번 미러).
fn render_chrome_bar(cv: &mut Canvas, snap: &TuiSnapshot, l: &FullLayout) {
    let cols = l.cols as i32;
    cv.fill_rect(Rect::new(0, 0, l.cols, 1), theme::BG_CHROME, theme::FG, ' ');
    cv.set_char(2, 0, "●", theme::TRAFFIC_RED, Some(theme::BG_CHROME), true);
    cv.set_char(4, 0, "●", theme::TRAFFIC_YELLOW, Some(theme::BG_CHROME), true);
    cv.set_char(6, 0, "●", theme::TRAFFIC_GREEN, Some(theme::BG_CHROME), true);

    let mode_tag = if snap.demo {
        "DEMO"
    } else if snap.db_live {
        "WATCH · LIVE"
    } else {
        "WATCH · PRIOR"
    };
    let scope = if snap.scope_label == "all" {
        "all".to_string()
    } else {
        snap.scope_label
            .strip_prefix("repo:")
            .unwrap_or(&snap.scope_label)
            .to_string()
    };
    let lead_cli = snap
        .roster
        .labels
        .lead
        .split(':')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("lead");
    let center_title = format!("{} · {} · {}×{} · {}", scope, lead_cli, l.cols, l.rows, mode_tag);
    cv.write_centered(
        0,
        0,
        l.cols as usize,
        &center_title,
        theme::CHROME_FG,
        Some(theme::BG_CHROME),
        false,
    );
    cv.write_right(
        0,
        0,
        cols.saturating_sub(2) as usize,
        "Tab:패널이동  a:전체/레포  r:새로고침  q:종료",
        theme::CHROME_FG,
        Some(theme::BG_CHROME),
        false,
    );
}

/// 헤더 — `renderHeader` 미러(타이틀 + 모드 배지 + 스코프 + 우측 카운트 + ═ 구분선).
fn render_header(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ctx: &RoleCtx,
    x: i32,
    y: i32,
    width: usize,
) {
    let title = "DGATE TUI";
    cv.write_text(x, y, title, theme::FG, Some(theme::BG), true, Some(width));
    let title_w = string_width(title) as i32;

    // 모드 배지 — 읽기전용 관측(WATCH)과 시뮬레이션(DEMO)을 즉시 구분
    let (mode_badge, badge_fg) = if snap.demo {
        ("[시뮬레이션 · DEMO]", theme::ORANGE)
    } else {
        ("[읽기전용 관측 · WATCH]", theme::BLUE)
    };
    let badge_w = string_width(mode_badge) as i32;
    let mut left_w = title_w;
    if width as i32 - left_w > badge_w + 10 {
        cv.write_text(
            x + left_w + 1,
            y,
            mode_badge,
            badge_fg,
            Some(theme::BG),
            true,
            Some(width - left_w as usize - 1),
        );
        left_w += 1 + badge_w;
    }

    // 우측 카운터 폭을 먼저 계산 — 라이브 세션 배지(LEAD/WORKERS/VERIFIES/ADVISOR).
    let b1 = format!("LEAD [{}]", ctx.lead_n);
    let b2 = format!("WORKERS [{}]", ctx.worker_n);
    let b3 = format!("VERIFIES [{}]", ctx.verifier_n);
    let b4 = format!("ADVISOR [{}]", ctx.advisor_n);
    let gap = if width >= 124 {
        "   "
    } else if width >= 96 {
        "  "
    } else {
        " "
    };
    let total_right_w = string_width(&b1) + string_width(&b2) + string_width(&b3)
        + string_width(&b4)
        + gap.len() * 3;
    let start_right = x + width as i32 - total_right_w as i32;
    let counters_drawn = start_right > x + 24 + left_w;

    if width as i32 - left_w > 8 {
        // 관측 스코프 표기 — repo 스코프는 `repo=<이름>`, 전체 관측은 '전체'.
        let repo_scope = if snap.scope_label == "all" {
            Some("전체".to_string())
        } else {
            snap.scope_label
                .strip_prefix("repo:")
                .map(|n| format!("repo={}", n))
        };
        let scope_max_w = if counters_drawn {
            (width as i32 - left_w - total_right_w as i32 - 2).max(0) as usize
        } else {
            (width as i32 - left_w).max(0) as usize
        };
        let mut scope_text = format!(
            " · profile={}{}",
            snap.roster.labels.profile_name,
            repo_scope
                .as_ref()
                .map(|s| format!(" · {}", s))
                .unwrap_or_default()
        );
        if string_width(&scope_text) > scope_max_w {
            if let Some(scope) = &repo_scope {
                // 공간이 부족하면 프로필명을 버리고라도 repo 스코프는 온전히 노출.
                scope_text = format!(" · {}", scope);
            }
        }
        cv.write_text(
            x + left_w,
            y,
            &scope_text,
            theme::MUTED,
            Some(theme::BG),
            false,
            Some(scope_max_w),
        );
    }

    if counters_drawn {
        cv.write_segments(
            start_right,
            y,
            &[
                Seg::new(b1, theme::ORANGE).bold(),
                Seg::new(gap, theme::MUTED),
                Seg::new(b2, theme::BLUE).bold(),
                Seg::new(gap, theme::MUTED),
                Seg::new(b3, theme::NEON).bold(),
                Seg::new(gap, theme::MUTED),
                Seg::new(b4, theme::PURPLE).bold(),
            ],
            None,
        );
    }

    cv.draw_hline(x, y + 1, width, '═', theme::BORDER_HEADER, Some(theme::BG));
}

/// 범례 네비게이션 — `renderLegendNav` 미러(5역할 색 점 + 라벨 중앙 정렬).
fn render_legend_nav(cv: &mut Canvas, snap: &TuiSnapshot, x: i32, y: i32, width: usize) {
    let lb = &snap.roster.labels;
    let items: [(String, ratatui::style::Color); 5] = [
        (format!("Lead · {}", lb.lead), theme::ORANGE),
        (
            format!("Workers · {} / {}", lb.explore, lb.coder),
            theme::BLUE,
        ),
        ("Decision Gate".to_string(), theme::GREEN),
        (format!("Verifier · {}", lb.verifier), theme::NEON),
        (format!("Advisor · {}", lb.advisor), theme::PURPLE),
    ];

    // 항목(아이콘 2칸 + 라벨)이 폭 안에 들어가는 가장 넓은 간격을 고른다.
    let fixed_w: usize = items.iter().map(|(t, _)| 2 + string_width(t)).sum();
    let n_gaps = items.len() - 1;
    let gap = if fixed_w + 6 * n_gaps <= width {
        "      "
    } else if fixed_w + 4 * n_gaps <= width {
        "    "
    } else if fixed_w + 3 * n_gaps <= width {
        "   "
    } else if fixed_w + 2 * n_gaps <= width {
        "  "
    } else {
        " "
    };

    let mut segments: Vec<Seg> = Vec::new();
    for (idx, (text, fg)) in items.iter().enumerate() {
        if idx > 0 {
            segments.push(Seg::new(gap, theme::MUTED));
        }
        segments.push(Seg::new("■ ", *fg).bold());
        segments.push(Seg::new(text.clone(), theme::MUTED));
    }
    cv.write_segments_centered(x, y, width, &segments);
}

/// 파이프라인 와이어 — `renderPipelineWires` 미러.
/// Lead→Decision 세로 · Decision→팬아웃 레일→카드 · 카드→팬인→Back · Lead↔Verifier 링크,
/// 그리고 각 경로 위를 흐르는 `sim_time` 구동 펄스 패킷.
fn render_pipeline_wires(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ctx: &RoleCtx,
    sim_time: f64,
    l: &FullLayout,
) {
    let cx = l.center_x as i32;
    let wire_fg = theme::BORDER_WIRE;
    let bg = Some(theme::BG);

    // 1) Lead Main 하단 -> Decision 상단 수직선
    let m_bottom = (l.main.y + l.main.height) as i32;
    let mut path_main_to_dec: Vec<(i32, i32)> = Vec::new();
    for y in m_bottom..l.decision.y as i32 {
        cv.set_char(cx, y, "│", wire_fg, bg, false);
        path_main_to_dec.push((cx, y));
    }

    // 2) Decision 하단 -> 위임 라벨 -> 팬아웃 트리 -> 실제 카드 상단
    let d_bottom = (l.decision.y + l.decision.height) as i32;
    for y in d_bottom..l.fan_out_y as i32 {
        if y != l.delegate_label_y as i32 {
            cv.set_char(cx, y, "│", wire_fg, bg, false);
        }
    }

    // 실제 렌더링된 카드의 중심 x목록 — 빈 슬롯으로 향하는 와이어는 그리지 않는다
    let xs: Vec<i32> = l
        .cards
        .iter()
        .map(|r| (r.x + r.width / 2) as i32)
        .collect();
    let fan_out_y = l.fan_out_y as i32;
    let fan_in_y = l.fan_in_y as i32;

    // 팬아웃/팬인 수평 레일 — min(cx, xs[0]) .. max(cx, xs[last]) 구간만, 정확한 접합 문자 사용
    let draw_rail = |cv: &mut Canvas, y: i32, kind: RailKind| {
        let rail_l = xs.first().map(|x| (*x).min(cx)).unwrap_or(cx);
        let rail_r = xs.last().map(|x| (*x).max(cx)).unwrap_or(cx);
        if rail_l == rail_r {
            // 카드 1장 — 빈 슬롯으로 가로선 없이 곧장 세로 스템
            cv.set_char(cx, y, "│", wire_fg, bg, false);
            return;
        }
        for x in rail_l..=rail_r {
            let is_stem = xs.contains(&x);
            let is_feed = x == cx;
            let ch = if is_stem && is_feed {
                '┼'
            } else {
                match kind {
                    RailKind::FanOut => {
                        if is_feed {
                            '┴'
                        } else if is_stem {
                            '┬'
                        } else if x == rail_l {
                            '┌'
                        } else if x == rail_r {
                            '┐'
                        } else {
                            '─'
                        }
                    }
                    RailKind::FanIn => {
                        if is_feed {
                            '┬'
                        } else if is_stem {
                            '┴'
                        } else if x == rail_l {
                            '└'
                        } else if x == rail_r {
                            '┘'
                        } else {
                            '─'
                        }
                    }
                }
            };
            cv.set_char(x, y, &ch.to_string(), wire_fg, bg, false);
        }
    };
    draw_rail(cv, fan_out_y, RailKind::FanOut);
    draw_rail(cv, fan_in_y, RailKind::FanIn);

    // 3) 카드 하단 -> 팬인 트리 -> 다시 Lead 상단
    for y in (fan_in_y + 1)..l.back.y as i32 {
        let is_last = y == l.back.y as i32 - 1;
        cv.set_char(cx, y, if is_last { "▼" } else { "│" }, wire_fg, bg, false);
    }

    // 4) Lead Main 우측 <-> Verifier 좌측 교차 검증 링크
    let neon_start_x = (l.main.x + l.main.width) as i32;
    let neon_end_x = l.neon.x as i32 - 1;
    let neon_active = matches!(ctx.neon, NeonState::Run | NeonState::Pass);
    let neon_link_color = match ctx.neon {
        NeonState::Fail => theme::TRAFFIC_RED,
        _ if neon_active => theme::NEON,
        _ => wire_fg,
    };
    let neon_link_char = if neon_active { "━" } else { "─" };
    let mut path_neon_go: Vec<(i32, i32)> = Vec::new();
    let mut path_neon_back: Vec<(i32, i32)> = Vec::new();
    for x in neon_start_x..=neon_end_x {
        cv.set_char(
            x,
            l.neon_link_row as i32,
            neon_link_char,
            neon_link_color,
            bg,
            neon_active,
        );
        path_neon_go.push((x, l.neon_link_row as i32));
    }
    for x in (neon_start_x..=neon_end_x).rev() {
        path_neon_back.push((x, l.neon_link_row as i32));
    }

    // 데이터 흐름 펄스 애니메이션 (gemini_sub_neon.html의 comet 대응)
    let t = sim_time;

    if ctx.lead_active || ctx.has_running_workers {
        cv.draw_pulse_along_path(&path_main_to_dec, t * 0.9, theme::ORANGE, "●");
    }

    // 카드별 개별 펄스 — 실행 중인 카드로만 흐른다(대기/빈 카드는 펄스 0개).
    // 위상을 카드 인덱스로 엇갈리게 해 2번째(가운데)·4번째 워커도 확실히 보이게 한다.
    if ctx.motion {
        for (i, card_view) in ctx.cards.iter().enumerate().take(l.cards.len()) {
            if !snap.demo && !worker_actively_running(card_view.worker) {
                continue;
            }
            let Some(&tx) = xs.get(i) else { continue };

            // 팬아웃: Decision 하단 세로 → fanOutY 레일 → 카드 i 상단 (위임 라벨 행은 제외)
            let mut path_out: Vec<(i32, i32)> = Vec::new();
            for y in d_bottom..fan_out_y {
                if y != l.delegate_label_y as i32 {
                    path_out.push((cx, y));
                }
            }
            if tx < cx {
                for x in (tx..=cx).rev() {
                    path_out.push((x, fan_out_y));
                }
            } else {
                for x in cx..=tx {
                    path_out.push((x, fan_out_y));
                }
            }
            cv.draw_pulse_along_path(&path_out, t * 0.48 + i as f64 * 0.27, theme::BLUE, "●");

            // 팬인: 카드 i 하단 → fanInY 레일 → 다시 Lead(back) 상단
            let mut path_in: Vec<(i32, i32)> = Vec::new();
            if tx >= cx {
                for x in (cx..=tx).rev() {
                    path_in.push((x, fan_in_y));
                }
            } else {
                for x in tx..=cx {
                    path_in.push((x, fan_in_y));
                }
            }
            for y in (fan_in_y + 1)..l.back.y as i32 {
                path_in.push((cx, y));
            }
            cv.draw_pulse_along_path(&path_in, t * 0.3 + i as f64 * 0.19, theme::FG, "•");
        }
    }

    if !path_neon_go.is_empty() {
        if ctx.neon == NeonState::Run {
            let nt = (t / 1.6).rem_euclid(1.0);
            if nt < 0.5 {
                cv.draw_pulse_along_path(&path_neon_go, nt * 2.0, theme::ORANGE, "●");
            } else {
                cv.draw_pulse_along_path(&path_neon_back, (nt - 0.5) * 2.0, theme::NEON, "●");
            }
        } else if snap.demo && ctx.neon == NeonState::Pass {
            cv.draw_pulse_along_path(&path_neon_back, t * 0.85, theme::NEON, "●");
        }
    }
}

#[derive(Clone, Copy)]
enum RailKind {
    FanOut,
    FanIn,
}

/// 자문 와이어 — `renderAdvisoryWires` 미러(3대 트리거 행 → 우측 타겟 패널).
fn render_advisory_wires(cv: &mut Canvas, ctx: &RoleCtx, sim_time: f64, l: &FullLayout) {
    let start_x = (l.advisor.x + l.advisor.width) as i32;
    let targets: [(i32, i32, i32); 3] = [
        (
            l.tr0_row as i32,
            l.main.x as i32 - 1,
            0,
        ),
        (
            l.tr1_row as i32,
            l.cards.first().map(|c| c.x as i32 - 1).unwrap_or(-1),
            1,
        ),
        (l.tr2_row as i32, l.back.x as i32 - 1, 2),
    ];

    for (row, end_x, idx) in targets {
        if end_x <= start_x {
            continue;
        }
        let is_on = ctx.active_trigger == idx;
        let line_color = if is_on {
            theme::PURPLE
        } else {
            theme::BORDER_ADVISORY_IDLE
        };
        let line_char = if is_on { "━" } else { "┄" };
        let arrow_char = if is_on { "▶" } else { "▷" };

        let mut path: Vec<(i32, i32)> = Vec::new();
        for x in start_x..end_x {
            cv.set_char(x, row, line_char, line_color, Some(theme::BG), is_on);
            path.push((x, row));
        }
        cv.set_char(end_x, row, arrow_char, line_color, Some(theme::BG), is_on);

        if is_on && ctx.advisor_running && !path.is_empty() {
            cv.draw_pulse_along_path(&path, sim_time * 0.75, theme::BORDER_FOCUS_BOOST, "◈");
        }
    }
}

/// 좌측 Advisor 패널 — `renderAdvisorPanel` 미러(트리거 행·본문·텔레메트리).
fn render_advisor_panel(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ui: &UiState,
    ctx: &RoleCtx,
    sim_time: f64,
    l: &FullLayout,
) {
    let r = l.advisor;
    let focused = ui.focused == FocusPanel::Advisor;
    let border_color = if focused {
        lerp_color(theme::PURPLE, theme::BORDER_FOCUS_BOOST, 0.35)
    } else {
        theme::PURPLE
    };

    cv.draw_box(
        r,
        &BoxOpts {
            style: if focused {
                Some(BoxStyle::Heavy)
            } else {
                Some(BoxStyle::Single)
            },
            border_color,
            fill_bg: Some(theme::BG),
            right_label: focused.then(|| "관측 중".to_string()),
            right_label_color: Some(theme::PURPLE),
            bold_border: focused,
            ..Default::default()
        },
    );

    // 우측 보더에서 자문 화살표 분기점(├ / ┣) 마킹
    let right_x = (r.x + r.width - 1) as i32;
    for (idx, row) in [l.tr0_row, l.tr1_row, l.tr2_row].iter().enumerate() {
        let row = *row as i32;
        if row > r.y as i32 && row < (r.y + r.height - 1) as i32 {
            let on = ctx.active_trigger == idx as i32;
            cv.set_char(
                right_x,
                row,
                if on { "┣" } else { "├" },
                if on { theme::PURPLE } else { border_color },
                Some(theme::BG),
                on,
            );
        }
    }

    let ix = r.x as i32 + 2;
    let iw = (r.width - 4) as usize;

    // 상단 헤더 영역 (R.y + 1 ~ tr0Row - 1)
    let mut hy = r.y as i32 + 1;
    if hy < l.tr0_row as i32 {
        cv.write_centered(ix, hy, iw, "Advisor", theme::PURPLE, Some(theme::BG), true);
        hy += 1;
    }
    if hy < l.tr0_row as i32 {
        let advisor_active = ctx.advisor_running;
        let spinner = if advisor_active {
            format!(" {}", spinner_frame(sim_time, 3.0))
        } else {
            String::new()
        };
        let status = ctx
            .advisor
            .and_then(|w| w.status.clone())
            .unwrap_or_else(|| "대기".to_string());
        let advisor_title = format!("{} · {}{}", snap.roster.labels.advisor, status, spinner);
        cv.write_centered(
            ix,
            hy,
            iw,
            &advisor_title,
            theme::PURPLE,
            Some(theme::BG),
            advisor_active,
        );
        hy += 1;
    }
    if hy < l.tr0_row as i32 {
        let tel = ctx
            .advisor
            .map(|w| w.telemetry_line())
            .unwrap_or_else(|| "roster 대기".to_string());
        cv.write_centered(ix, hy, iw, &tel, theme::MUTED, Some(theme::BG), false);
    }

    // 트리거 3개 행 렌더링 (활성 시 보라 하이라이트 배경 바)
    for (idx, t_row) in [l.tr0_row, l.tr1_row, l.tr2_row].iter().enumerate() {
        let t_row = *t_row as i32;
        if t_row <= r.y as i32 || t_row >= (r.y + r.height - 1) as i32 {
            continue;
        }
        let active = ctx.active_trigger == idx as i32;
        let row_bg = if active {
            theme::BG_TRIGGER_ACTIVE
        } else {
            theme::BG
        };
        let row_fg = if active { theme::PURPLE } else { theme::MUTED };
        cv.fill_rect(
            Rect::new(r.x + 1, t_row as u16, r.width - 2, 1),
            row_bg,
            theme::FG,
            ' ',
        );
        let prefix = if active { "● " } else { "◇ " };
        cv.write_text(
            ix,
            t_row,
            &format!("{}{}", prefix, TRIGGER_LABELS[idx]),
            row_fg,
            Some(row_bg),
            active,
            Some(iw),
        );
    }

    // 중단 자문 본문 블록 (tr0Row + 1 ~ tr1Row - 1): 좌측 점선(┆) 가이드
    let body_start = l.tr0_row as i32 + 1;
    let body_end = l.tr1_row as i32 - 1;
    let avail_body = body_end - body_start + 1;
    if avail_body >= 3 {
        for y in body_start..=body_end {
            cv.set_char(ix, y, "┆", theme::BORDER_ASIDE_DASH, Some(theme::BG), false);
        }

        let bx = ix + 2;
        let bw = iw.saturating_sub(2);
        let mut by = body_start;

        if avail_body >= 9 {
            cv.write_text(
                bx,
                by,
                "세션 전체·도구 호출·결과를",
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(bw),
            );
            by += 1;
            cv.write_text(
                bx,
                by,
                "읽습니다",
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(bw),
            );
            by += 2;
        } else {
            cv.write_text(
                bx,
                by,
                "세션 전체·도구 결과를 읽음",
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(bw),
            );
            by += 1;
        }

        if by <= body_end {
            cv.write_text(bx, by, "최근 조언", theme::MUTED, Some(theme::BG), false, Some(bw));
            by += 1;
        }

        // 남은 공간 계산해 최근 조언 줄바꿈 출력 (최대 2~3줄)
        let reserved_stats = if avail_body >= 8 { 3 } else { 2 };
        let max_advice_lines = (body_end - by + 1 - reserved_stats).clamp(1, 3) as usize;
        let advice_text = ctx
            .advisor
            .map(|w| w.activity.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("자문 대기");
        let advice_lines = wrap_by_width(advice_text, bw, max_advice_lines);
        for line in advice_lines {
            if by > body_end - reserved_stats {
                break;
            }
            cv.write_text(bx, by, &line, theme::PURPLE, Some(theme::BG), true, Some(bw));
            by += 1;
        }

        if avail_body >= 10 && by < body_end - 2 {
            by += 1;
        }

        // 호출 수 — 실측 턴 수(없으면 '—')
        if by <= body_end {
            cv.write_text(bx, by, "호출 수", theme::MUTED, Some(theme::BG), false, None);
            let calls = ctx
                .advisor
                .and_then(|w| w.turn)
                .map(|t| t.to_string())
                .unwrap_or_else(|| "—".to_string());
            cv.write_right(
                bx,
                by,
                bw,
                &calls,
                theme::PURPLE,
                Some(theme::BG),
                true,
            );
            by += 1;
        }
        if by <= body_end {
            if avail_body >= 11 && by < body_end {
                by += 1;
            }
            cv.write_text(
                bx,
                by,
                "일상 턴에서는 침묵",
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(bw),
            );
        }
    }

    // 하단 보조 설명 블록 (tr1Row + 1 ~ tr2Row - 1)
    let exp_start = l.tr1_row as i32 + 1;
    let exp_end = l.tr2_row as i32 - 1;
    if exp_end >= exp_start {
        // 하단 마지막 줄은 실측 cli · model · effort (없으면 대기 중)
        let tel_row = if exp_end - exp_start >= 3 {
            exp_end
        } else {
            -1
        };
        let text_end = if tel_row >= 0 { tel_row - 1 } else { exp_end };
        let mut ey = exp_start + if exp_end - exp_start >= 2 { 1 } else { 0 };
        if ey <= text_end {
            cv.write_text(
                ix + 1,
                ey,
                "코드는 직접 쓰지 않습니다.",
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(iw.saturating_sub(1)),
            );
            ey += 1;
        }
        if ey <= text_end {
            cv.write_text(
                ix + 1,
                ey,
                "조언은 Lead가 적용합니다.",
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(iw.saturating_sub(1)),
            );
        }
        if tel_row >= 0 {
            let tel = ctx.advisor.map(|w| w.telemetry_line());
            cv.write_centered(
                ix,
                tel_row,
                iw,
                tel.as_deref().unwrap_or("대기 중"),
                if tel.is_some() {
                    theme::PURPLE
                } else {
                    theme::MUTED
                },
                Some(theme::BG),
                false,
            );
        }
    }
}

/// Lead 메인 패널 — `renderMainPanel` 미러(effort 게이지·스피너·텔레메트리).
fn render_main_panel(
    cv: &mut Canvas,
    _snap: &TuiSnapshot,
    ui: &UiState,
    ctx: &RoleCtx,
    sim_time: f64,
    l: &FullLayout,
) {
    let r = l.main;
    let glowing = ctx.active_trigger == 0;
    let focused = ui.focused == FocusPanel::Main;
    let panel_bg = if glowing {
        theme::BG_GLOW_PURPLE
    } else {
        theme::BG
    };
    let base_border = if glowing {
        theme::PURPLE
    } else {
        theme::ORANGE
    };
    let border_color = if focused {
        lerp_color(base_border, theme::BORDER_FOCUS_BOOST, 0.35)
    } else {
        base_border
    };

    let warn = ctx.lead.and_then(|w| w.subagent_warning.clone());
    cv.draw_box(
        r,
        &BoxOpts {
            style: if glowing || focused || warn.is_some() {
                Some(BoxStyle::Heavy)
            } else {
                Some(BoxStyle::Single)
            },
            border_color: if warn.is_some() {
                theme::TRAFFIC_RED
            } else {
                border_color
            },
            fill_bg: Some(panel_bg),
            right_label: if warn.is_some() {
                Some("⚠ 서브에이전트".to_string())
            } else if focused {
                Some("관측 중".to_string())
            } else if glowing {
                Some("Advisor 자문".to_string())
            } else {
                None
            },
            right_label_color: Some(if warn.is_some() {
                theme::TRAFFIC_RED
            } else if glowing {
                theme::PURPLE
            } else {
                theme::ORANGE
            }),
            bold_border: glowing || focused || warn.is_some(),
            ..Default::default()
        },
    );

    // 우측 보더에서 Verifier 연결 분기점(├ / ┣) 마킹
    if l.neon_link_row > r.y && l.neon_link_row < r.y + r.height - 1 {
        let neon_on = matches!(ctx.neon, NeonState::Run | NeonState::Pass);
        cv.set_char(
            (r.x + r.width - 1) as i32,
            l.neon_link_row as i32,
            if glowing || focused || neon_on { "┣" } else { "├" },
            if neon_on { theme::NEON } else { border_color },
            Some(panel_bg),
            glowing || focused || neon_on,
        );
    }

    let ix = r.x as i32 + 2;
    let iw = (r.width - 4) as usize;
    let mut cy = r.y as i32 + 1;
    let y_max = (r.y + r.height - 1) as i32;

    cv.write_centered(ix, cy, iw, "Lead", theme::ORANGE, Some(panel_bg), true);
    cy += 1;
    if let Some(warn_text) = warn {
        if cy < y_max {
            cv.write_centered(ix, cy, iw, &warn_text, theme::TRAFFIC_RED, Some(panel_bg), true);
            cy += 1;
        }
    } else if cy < y_max {
        let summary = ctx
            .lead
            .map(|w| w.activity.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("roster 대기 — 활성 세션 없음");
        cv.write_centered(ix, cy, iw, summary, theme::FG, Some(panel_bg), false);
        cy += 1;
    }
    if cy < y_max {
        let mut phase_segs: Vec<Seg> = Vec::new();
        // 실측 effort가 확인될 때만 게이지를 표시(허위 게이지 금지).
        if let Some(gauge) = effort_to_gauge(ctx.lead.and_then(|w| w.effort.as_deref())) {
            phase_segs.push(Seg::new("effort ", theme::MUTED).bg(panel_bg));
            phase_segs.push(Seg::new(gauge, theme::ORANGE).bg(panel_bg).bold());
            phase_segs.push(Seg::new(" · ", theme::MUTED).bg(panel_bg));
        }
        let phase = ctx
            .lead
            .and_then(|w| w.status.clone())
            .unwrap_or_else(|| "대기 중".to_string());
        phase_segs.push(Seg::new(phase, theme::FG).bg(panel_bg));
        // Lead 활성 시 위상 배지 옆 회전 스피너 — 패널이 살아 있음을 즉시 보여준다.
        if ctx.lead_active {
            phase_segs.push(
                Seg::new(format!(" {}", spinner_frame(sim_time, 2.0)), theme::ORANGE)
                    .bg(panel_bg)
                    .bold(),
            );
        }
        cv.write_segments_centered(ix, cy, iw, &phase_segs);
        cy += 1;
    }
    // 하단 텔레메트리 — 실측 cli · model · effort (없으면 대기 중)
    if cy < y_max {
        let bottom = ctx
            .lead
            .map(|w| w.telemetry_line())
            .unwrap_or_else(|| "대기 중".to_string());
        cv.write_centered(ix, cy, iw, &bottom, theme::MUTED, Some(panel_bg), false);
    }
}

/// Verifier 패널 — `renderNeonPanel` 미러(프로그레스 바·스피너·검증 상태).
fn render_neon_panel(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ui: &UiState,
    ctx: &RoleCtx,
    sim_time: f64,
    l: &FullLayout,
) {
    let r = l.neon;
    let focused = ui.focused == FocusPanel::Neon;
    let is_run = ctx.neon == NeonState::Run;
    let is_pass = ctx.neon == NeonState::Pass;
    let is_fail = ctx.neon == NeonState::Fail;
    let active = is_run || is_pass || is_fail;

    let panel_bg = if active {
        theme::BG_GLOW_NEON
    } else {
        theme::BG
    };
    let base_border = if is_fail {
        theme::TRAFFIC_RED
    } else if active {
        theme::NEON
    } else {
        lerp_color(theme::NEON, theme::BORDER_WIRE, 0.32)
    };
    let border_color = if focused {
        lerp_color(theme::NEON, theme::BORDER_FOCUS_BOOST, 0.35)
    } else {
        base_border
    };

    let right_label = if focused {
        Some("관측 중")
    } else if is_run {
        Some("검증 중")
    } else if is_pass {
        Some("통과")
    } else if is_fail {
        Some("주의")
    } else {
        None
    };
    let right_label_color = if is_pass {
        theme::GREEN
    } else if is_fail {
        theme::TRAFFIC_RED
    } else {
        theme::NEON
    };

    cv.draw_box(
        r,
        &BoxOpts {
            style: if active || focused {
                Some(BoxStyle::Heavy)
            } else {
                Some(BoxStyle::Single)
            },
            border_color,
            fill_bg: Some(panel_bg),
            right_label: right_label.map(str::to_string),
            right_label_color: Some(right_label_color),
            bold_border: active || focused,
            ..Default::default()
        },
    );

    // 좌측 보더에서 Lead 메인 연결 접합점(┤ / ┫) 마킹
    if l.neon_link_row > r.y && l.neon_link_row < r.y + r.height - 1 {
        cv.set_char(
            r.x as i32,
            l.neon_link_row as i32,
            if active || focused { "┫" } else { "┤" },
            if active {
                if is_fail {
                    theme::TRAFFIC_RED
                } else {
                    theme::NEON
                }
            } else {
                border_color
            },
            Some(panel_bg),
            active || focused,
        );
    }

    let ix = r.x as i32 + 2;
    let iw = (r.width - 4) as usize;
    let mut cy = r.y as i32 + 1;
    let y_max = (r.y + r.height - 1) as i32;

    // 1) 제목 — watch 관측은 역할명('Verifier')만 표시
    cv.write_centered(
        ix,
        cy,
        iw,
        "Verifier",
        if active || focused {
            theme::NEON
        } else {
            lerp_color(theme::NEON, theme::MUTED, 0.2)
        },
        Some(panel_bg),
        true,
    );
    cy += 1;

    // 2) 프로그레스 바 — 데모면 슬라이딩 필+RUN, 실측 실행이면 스피너 상태 한 줄
    if cy < y_max {
        if snap.demo && is_run {
            let bar_w = (iw.saturating_sub(5)).max(6);
            let start_x = ix + ((iw as i32 - (bar_w + 1 + 4) as i32).max(0) / 2).max(0);
            cv.draw_indeterminate_bar(
                start_x,
                cy,
                bar_w,
                theme::NEON,
                theme::BG_NEON_TRACK,
                sim_time,
                1.0,
            );
            cv.write_text(
                start_x + bar_w as i32 + 1,
                cy,
                &format!("{} RUN", spinner_frame(sim_time, 1.0)),
                theme::NEON,
                Some(panel_bg),
                true,
                None,
            );
        } else if is_run {
            cv.write_centered(
                ix,
                cy,
                iw,
                &format!("{} 교차 검증 중", spinner_frame(sim_time, 1.0)),
                theme::NEON,
                Some(panel_bg),
                true,
            );
        } else if is_pass {
            cv.write_centered(ix, cy, iw, "✓ 검증 통과", theme::GREEN, Some(panel_bg), true);
        } else if is_fail {
            cv.write_centered(
                ix,
                cy,
                iw,
                "✕ 검증 실패",
                theme::TRAFFIC_RED,
                Some(panel_bg),
                true,
            );
        } else {
            cv.write_centered(
                ix,
                cy,
                iw,
                "○ 교차 검증 대기",
                theme::MUTED,
                Some(panel_bg),
                false,
            );
        }
        cy += 1;
    }

    // 3) 실행/완료/대기 상태
    if cy < y_max {
        let (status_label, status_fg) = if is_run {
            (
                format!(
                    "◉ {}",
                    ctx.verifier
                        .map(|w| w.activity.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or("교차 검증 중")
                ),
                theme::NEON,
            )
        } else if is_pass {
            ("✓ 검증 통과".to_string(), theme::GREEN)
        } else if is_fail {
            ("✕ 검증 주의".to_string(), theme::TRAFFIC_RED)
        } else if iw >= 26 {
            ("○ 대기 · 호출 시 독립 검증".to_string(), theme::MUTED)
        } else {
            ("○ 대기 · 호출 시 검증".to_string(), theme::MUTED)
        };
        cv.write_centered(
            ix,
            cy,
            iw,
            &status_label,
            status_fg,
            Some(panel_bg),
            is_run || is_pass || is_fail,
        );
        cy += 1;
    }

    // 4) 하단 텔레메트리 — 실측 cli · model · effort (없으면 대기 중)
    if cy < y_max {
        let bottom = ctx
            .verifier
            .map(|w| w.telemetry_line())
            .unwrap_or_else(|| "대기 중".to_string());
        cv.write_centered(ix, cy, iw, &bottom, theme::MUTED, Some(panel_bg), false);
    }
}

/// Decision Gate 패널 — `renderDecisionPanel` 미러(라우트별 프로그레스 바).
fn render_decision_panel(cv: &mut Canvas, snap: &TuiSnapshot, ui: &UiState, l: &FullLayout) {
    let r = l.decision;
    let focused = ui.focused == FocusPanel::Decision;
    let border_color = if focused {
        lerp_color(theme::GREEN, theme::BORDER_FOCUS_BOOST, 0.35)
    } else {
        theme::GREEN
    };

    cv.draw_box(
        r,
        &BoxOpts {
            style: if focused {
                Some(BoxStyle::Heavy)
            } else {
                Some(BoxStyle::Single)
            },
            border_color,
            fill_bg: Some(theme::BG),
            right_label: focused.then(|| "관측 중".to_string()),
            right_label_color: Some(theme::GREEN),
            bold_border: focused,
            ..Default::default()
        },
    );

    let ix = r.x as i32 + 2;
    let iw = (r.width - 4) as usize;
    let mut cy = r.y as i32 + 1;
    let y_max = (r.y + r.height - 1) as i32;

    // 헤더: Decision Gate · 분기 계층  |  forks N
    cv.write_text(
        ix,
        cy,
        "Decision Gate · 분기 계층",
        theme::GREEN,
        Some(theme::BG),
        true,
        Some(iw),
    );
    let forks_str = snap.total_forks.to_string();
    let right_w = string_width("forks ") + string_width(&forks_str);
    if iw > right_w + 24 {
        cv.write_segments(
            ix + iw as i32 - right_w as i32,
            cy,
            &[
                Seg::new("forks ", theme::MUTED),
                Seg::new(forks_str.clone(), theme::GREEN).bold(),
            ],
            None,
        );
    }
    cy += 1;

    // 라우트 행: forced → split 순 우선 정렬, 패널 높이가 허용하는 슬롯 전부 활용(최소 3행)
    let label_w = ((iw as f64 * 0.28) as usize).clamp(14, 18);
    let status_w = 19usize; // "p=0.89 sharp m:24"
    let bar_w = (iw.saturating_sub(label_w + status_w + 4)).max(8);
    let max_route_rows = (y_max - cy).max(3);

    for &ri in sorted_route_indices(snap).iter().take(max_route_rows as usize) {
        if cy >= y_max {
            break;
        }
        let route = &snap.routes[ri];
        let is_split = route.forced_split || route.p < SHARP_FLOOR;
        let row_color = if route.forced_split {
            theme::TRAFFIC_RED
        } else if is_split {
            theme::ORANGE
        } else {
            theme::GREEN
        };
        let track_bg = if is_split {
            theme::BG_ORANGE_TRACK
        } else {
            theme::BG_GREEN_TRACK
        };
        let tag = if route.forced_split {
            format!("p={:.2} SPLIT!", route.p)
        } else {
            // basis는 반드시 m:<n>(실측) / p:<n>(사전) 표기.
            let basis_tag = match route.basis {
                dgate_core::engine::DecisionBasis::Measured => "m",
                dgate_core::engine::DecisionBasis::Prior => "p",
            };
            format!(
                "p={:.2} {} {}:{}",
                route.p,
                if is_split { "split" } else { "sharp" },
                basis_tag,
                route.samples
            )
        };

        cv.write_text(
            ix,
            cy,
            &pad_right_width(route.name, label_w),
            if is_split { row_color } else { theme::FG },
            Some(theme::BG),
            false,
            None,
        );
        cv.draw_progress_bar(ix + label_w as i32 + 2, cy, bar_w, route.p, row_color, track_bg);
        cv.write_text(
            ix + label_w as i32 + 2 + bar_w as i32 + 2,
            cy,
            &tag,
            row_color,
            Some(theme::BG),
            is_split,
            Some((iw as i32 - label_w as i32 - bar_w as i32 - 4).max(0) as usize),
        );
        cy += 1;
    }

    // 하단 범례 (높이 여유가 있을 때 표시)
    if cy < y_max {
        cv.write_segments(
            ix,
            cy,
            &[
                Seg::new("sharp → 코드에서 실행", theme::GREEN),
                Seg::new("   split → Lead", theme::MUTED),
            ],
            Some(iw),
        );
    }
}

/// Workers 섹션 — `renderSwarmSection` 미러(위임 라벨 + 클러스터 카드 행).
fn render_swarm_section(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    ctx: &RoleCtx,
    sim_time: f64,
    l: &FullLayout,
) {
    // 위임 라벨 (하위 에이전트에 위임 · Workers) — 슬롯 초과 워커는 +N 배지로 안내
    let overflow = ctx.cards.len().saturating_sub(l.cards.len());
    if l.delegate_label_y < l.fan_out_y {
        let first = l.cards[0];
        let last = l.cards[l.cards.len() - 1];
        let card_span_w = (last.x + last.width - first.x) as usize;
        // 카드 1~2장일 땐 라벨이 카드 폭보다 길어질 수 있어 decision 폭까지 중앙 확장
        let label_w = card_span_w.max((l.decision.width as usize).min(36));
        let label_x = l.center_x as i32 - (label_w / 2) as i32;
        let mut label_segs = vec![
            Seg::new("하위 에이전트에 위임 · ", theme::FG),
            Seg::new("Workers", theme::BLUE).bold(),
        ];
        if overflow > 0 {
            label_segs.push(Seg::new(format!(" · +{}개 더", overflow), theme::ORANGE).bold());
        }
        cv.write_segments_centered(label_x, l.delegate_label_y as i32, label_w, &label_segs);
    }

    let focused = ui.focused == FocusPanel::Swarm;
    let err_advisory = ctx.active_trigger == 1;

    // 라이브 watch + 활성 하위 워커 0명 — 정직한 단일 뮤트 빈 상태 박스.
    // 가짜 자리표 카드를 절대 그리지 않는다.
    if ctx.cards.is_empty() {
        let empty_rect = l.cards[0];
        cv.draw_box(
            empty_rect,
            &BoxOpts {
                style: Some(BoxStyle::Single),
                border_color: theme::BORDER_LOG,
                fill_bg: Some(theme::BG),
                ..Default::default()
            },
        );
        let msg_y = empty_rect.y as i32 + (empty_rect.height as i32 / 2).max(1);
        if msg_y < (empty_rect.y + empty_rect.height - 1) as i32 {
            cv.write_centered(
                empty_rect.x as i32 + 1,
                msg_y,
                (empty_rect.width - 2) as usize,
                EMPTY_WORKERS_MESSAGE,
                theme::MUTED,
                Some(theme::BG),
                false,
            );
        }
        return;
    }

    let sel_card_idx = (ui.worker_select).min(l.cards.len().saturating_sub(1));

    for (idx, card_rect) in l.cards.iter().enumerate() {
        let Some(entry) = ctx.cards.get(idx) else { break };
        let card_rect = *card_rect;
        let w = entry.worker;

        let card_advisory_glow = err_advisory && idx == 0;
        let card_selected = focused && idx == sel_card_idx;
        let card_bg = if card_advisory_glow {
            theme::BG_GLOW_PURPLE
        } else {
            theme::BG
        };
        let base_border = if card_advisory_glow {
            theme::PURPLE
        } else if card_selected {
            theme::ORANGE
        } else {
            theme::BLUE
        };
        let border_color = if focused {
            lerp_color(base_border, theme::BORDER_FOCUS_BOOST, 0.35)
        } else {
            base_border
        };

        cv.draw_box(
            card_rect,
            &BoxOpts {
                style: if focused || card_advisory_glow || card_selected {
                    Some(BoxStyle::Heavy)
                } else {
                    Some(BoxStyle::Single)
                },
                border_color,
                fill_bg: Some(card_bg),
                right_label: card_selected.then(|| "선택됨".to_string()),
                right_label_color: Some(if card_selected {
                    theme::ORANGE
                } else {
                    theme::BLUE
                }),
                bold_border: focused || card_advisory_glow || card_selected,
                ..Default::default()
            },
        );

        let ix = card_rect.x as i32 + 2;
        let iw = (card_rect.width - 4) as usize;
        let mut cy = card_rect.y as i32 + 1;
        let y_max = (card_rect.y + card_rect.height - 1) as i32;

        // 이름 (sublead 카드는 `sublead-auth · N` 클러스터 헤더 표기 유지,
        // 5행 컴팩트 카드에선 소유 배지를 같은 줄에 병기)
        let name_text = match entry.cluster_size {
            Some(n) => format!("{} · {}", w.name, n),
            None => w.name.clone(),
        };
        let inline_owner = if entry.owner_badge.is_some() && card_rect.height < 6 {
            format!(" {}", entry.owner_badge.clone().unwrap_or_default())
        } else {
            String::new()
        };
        cv.write_centered(
            ix,
            cy,
            iw,
            &format!(
                "{}{}{}",
                if card_selected { "▶ " } else { "" },
                name_text,
                inline_owner
            ),
            theme::FG,
            Some(card_bg),
            true,
        );
        cy += 1;

        // 소유 sublead 배지 — 소속 워커 카드에만 표시(sublead 본인과 미소속은 줄 추가 없음).
        if let Some(badge) = &entry.owner_badge {
            if card_rect.height >= 6 && cy < y_max.saturating_sub(1) {
                cv.write_centered(ix, cy, iw, badge, theme::ORANGE, Some(card_bg), false);
                cy += 1;
            }
        }

        // 진행 표시 — 실측 카드(progress 미관측)는 스피너+실측 경과+턴의
        // 중앙 텔레메트리 라인. 데모일 때만 슬라이딩 필 바를 그린다.
        // idle 카드는 sim_time과 무관하게 항상 동일하게 그린다(침착 대기 불변식).
        if cy < y_max {
            let status = w.status.as_deref().unwrap_or("live");
            let is_done = status == "done";
            let is_idle = matches!(status, "idle" | "error");
            let turn_suffix = w.turn.map(|t| format!(" · turn {}", t)).unwrap_or_default();
            let demo_idx = if snap.demo { Some(idx) } else { None };
            let elapsed = clock.elapsed_secs(&w.address, demo_idx);

            if snap.demo && worker_actively_running(w) {
                // 슬라이딩 활동 필 + 우측 스피너·경과 라벨.
                let right_label = match elapsed {
                    Some(secs) => format!(
                        "{} {}",
                        spinner_frame(sim_time, idx as f64),
                        format_elapsed_mmss(secs)
                    ),
                    None => format!("{} RUN", spinner_frame(sim_time, idx as f64)),
                };
                let bar_w = (iw.saturating_sub(string_width(&right_label) + 1)).max(6);
                let start_x = ix
                    + ((iw as i32 - (bar_w + 1 + string_width(&right_label)) as i32).max(0) / 2)
                        .max(0);
                cv.draw_indeterminate_bar(
                    start_x,
                    cy,
                    bar_w,
                    theme::BLUE,
                    theme::BG_BLUE_TRACK,
                    sim_time,
                    idx as f64,
                );
                cv.write_text(
                    start_x + bar_w as i32 + 1,
                    cy,
                    &right_label,
                    theme::BLUE,
                    Some(card_bg),
                    true,
                    None,
                );
            } else {
                let (line, fg, bold) = if is_done {
                    (
                        format!(
                            "✓ 완료{}{}",
                            elapsed
                                .map(|s| format!(" · {}", format_elapsed_mmss(s)))
                                .unwrap_or_default(),
                            turn_suffix
                        ),
                        theme::GREEN,
                        true,
                    )
                } else if is_idle {
                    if status == "error" {
                        ("✕ 오류".to_string(), theme::TRAFFIC_RED, false)
                    } else {
                        ("▪ 대기 중".to_string(), theme::MUTED, false)
                    }
                } else if ctx.motion {
                    (
                        format!(
                            "{} 실행 중 · {}{}",
                            spinner_frame(sim_time, idx as f64),
                            elapsed
                                .map(format_elapsed_mmss)
                                .unwrap_or_else(|| "RUN".to_string()),
                            turn_suffix
                        ),
                        theme::BLUE,
                        true,
                    )
                } else {
                    // 비-모션(관측 폴백) 실행 카드 — 100% 정적 표기(침착 대기 불변식)
                    ("◉ 실행 중".to_string(), theme::BLUE, false)
                };
                cv.write_centered(ix, cy, iw, &line, fg, Some(card_bg), bold);
            }
            cy += 1;
        }

        // 카드 설명(활동) — 7행 카드에서만
        if cy < y_max && card_rect.height >= 7 {
            cv.write_centered(
                card_rect.x as i32 + 1,
                cy,
                (card_rect.width - 2) as usize,
                &w.activity,
                theme::FG_SOFT,
                Some(card_bg),
                false,
            );
            cy += 1;
        }

        // 하단 줄 — 실측 cli · model · effort
        if cy < y_max {
            cv.write_centered(
                ix,
                cy,
                iw,
                &w.telemetry_line(),
                theme::BLUE,
                Some(card_bg),
                false,
            );
        }
    }
}

/// 다시 Lead 패널 — `renderBackPanel` 미러(팬인 결과를 Lead가 검토).
fn render_back_panel(cv: &mut Canvas, _ui: &UiState, ctx: &RoleCtx, l: &FullLayout) {
    let r = l.back;
    let glowing = ctx.active_trigger == 2;
    let panel_bg = if glowing {
        theme::BG_GLOW_PURPLE
    } else {
        theme::BG
    };
    let border_color = if glowing {
        theme::PURPLE
    } else {
        theme::ORANGE
    };

    cv.draw_box(
        r,
        &BoxOpts {
            style: if glowing {
                Some(BoxStyle::Heavy)
            } else {
                Some(BoxStyle::Single)
            },
            border_color,
            fill_bg: Some(panel_bg),
            right_label: glowing.then(|| "Advisor 최종 점검".to_string()),
            right_label_color: Some(theme::PURPLE),
            bold_border: glowing,
            ..Default::default()
        },
    );

    let ix = r.x as i32 + 2;
    let iw = (r.width - 4) as usize;
    let y1 = r.y as i32 + 1;
    cv.write_centered(ix, y1, iw, "다시 Lead · 리드", theme::ORANGE, Some(panel_bg), true);
    if y1 + 1 < (r.y + r.height - 1) as i32 {
        cv.write_segments_centered(
            ix,
            y1 + 1,
            iw,
            &[
                Seg::new("검토 + 확인 ", theme::FG).bg(panel_bg),
                Seg::new("· review + verify", theme::MUTED).bg(panel_bg),
            ],
        );
    }
}

/// 세션 기록 패널 — 최근 `decision_events` 로그(최신순 → 화면은 최신이 하단).
fn render_logs_panel(cv: &mut Canvas, snap: &TuiSnapshot, focused: bool, r: Rect) {
    let border_color = if focused {
        theme::FG_SOFT
    } else {
        theme::BORDER_LOG
    };
    cv.draw_box(
        r,
        &BoxOpts {
            style: if focused {
                Some(BoxStyle::Heavy)
            } else {
                Some(BoxStyle::Single)
            },
            border_color,
            fill_bg: Some(theme::BG),
            title: Some("최근 로그 (decision_events)".to_string()),
            title_color: Some(theme::MUTED),
            right_label: focused.then(|| "관측 중".to_string()),
            right_label_color: Some(theme::GREEN),
            bold_border: focused,
        },
    );

    let inner_rows = (r.height.saturating_sub(2)).max(1) as usize;
    // 스냅숏은 최신순(DESC) — 화면에는 최신이 하단에 오도록 역순 배치.
    let visible: Vec<&String> = snap.recent_log.iter().take(inner_rows).rev().collect();
    let ix = r.x as i32 + 2;
    let iw = (r.width - 4) as usize;

    if visible.is_empty() {
        cv.write_text(
            ix,
            r.y as i32 + 1,
            "기록 없음 — DB 대기",
            theme::DIM,
            Some(theme::BG),
            false,
            Some(iw),
        );
        return;
    }
    for (i, line) in visible.iter().enumerate() {
        let y = r.y as i32 + 1 + i as i32;
        let is_latest = i == visible.len() - 1;
        cv.write_text(
            ix,
            y,
            if is_latest { "› " } else { "  " },
            if is_latest { theme::FG } else { theme::DIM },
            Some(theme::BG),
            is_latest,
            Some(2),
        );
        cv.write_text(
            ix + 2,
            y,
            &truncate_width(line, iw.saturating_sub(2), "…"),
            if is_latest { theme::FG } else { theme::FG_SOFT },
            Some(theme::BG),
            is_latest,
            Some(iw.saturating_sub(2)),
        );
    }
}

/// 하단 상태 푸터 — `renderFooter` 미러(관측 힌트 + 우측 상태 배지).
fn render_footer(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ctx: &RoleCtx,
    x: i32,
    y: i32,
    width: usize,
) {
    let neon_status_text = match ctx.neon {
        NeonState::Run => "검증 중",
        NeonState::Pass => "통과",
        NeonState::Fail => "주의",
        NeonState::Idle => "대기",
    };
    let compact_status = width < 114;
    let running_n = ctx
        .cards
        .iter()
        .filter(|c| worker_actively_running(c.worker))
        .count();
    let s1 = if compact_status {
        format!("[ 워커 {} ]", running_n)
    } else {
        format!("[ 하위 에이전트 {}/{} ]", running_n, ctx.worker_n)
    };
    let s2 = format!("[ Verifier {} ]", neon_status_text);
    let s3 = format!("[ forks {} ]", snap.total_forks);
    let gap = if compact_status { " " } else { "  " };
    let status_total_w = string_width(&s1) + string_width(&s2) + string_width(&s3) + gap.len() * 2;
    let status_start_x = x + (width as i32 - status_total_w as i32).max(0);

    if status_start_x > x + 20 {
        cv.write_segments(
            status_start_x,
            y,
            &[
                Seg::new(s1, theme::BLUE).bold(),
                Seg::new(gap, theme::MUTED),
                Seg::new(
                    s2,
                    if ctx.neon == NeonState::Fail {
                        theme::TRAFFIC_RED
                    } else {
                        theme::NEON
                    },
                )
                .bold(),
                Seg::new(gap, theme::MUTED),
                Seg::new(s3, theme::GREEN).bold(),
            ],
            None,
        );
    }

    // 좌측 관측 힌트 — brief 푸터 계약(Tab 패널이동 · q 종료 · a 전체/레포).
    let hint_max_w = (status_start_x - x - 2).max(18) as usize;
    cv.write_text(
        x,
        y,
        "Tab:패널이동 · q:종료 · a:전체/레포 · r:새로고침 · ←/→:워커",
        theme::MUTED,
        Some(theme::BG),
        false,
        Some(hint_max_w),
    );
}

// ---------------------------------------------------------------------------
// Compact 폴백 — `renderCompactLayout` 미러(작은 터미널 탭 모드)
// ---------------------------------------------------------------------------

fn render_compact_layout(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ui: &UiState,
    clock: &WorkerClock,
    sim_time: f64,
    ctx: &RoleCtx,
    l: &CompactLayout,
) {
    render_header(cv, snap, ctx, 1, l.header_y as i32, l.cols.saturating_sub(2) as usize);

    let tabs = [
        "[1:파이프라인]".to_string(),
        format!("[2:스웜({})]", ctx.worker_n),
        format!(
            "[3:Advisor({})]",
            ctx.advisor
                .and_then(|w| w.status.clone())
                .unwrap_or_else(|| "대기".to_string())
        ),
        "[4:기록]".to_string(),
    ];
    let tab_colors = [theme::ORANGE, theme::BLUE, theme::PURPLE, theme::GREEN];

    let mut tx = 1i32;
    for (idx, label) in tabs.iter().enumerate() {
        let active = ui.compact_tab == idx;
        let (fg, bg) = if active {
            (theme::BG, tab_colors[idx])
        } else {
            (theme::MUTED, theme::BG)
        };
        tx += cv.write_text(
            tx,
            l.tab_bar_y as i32,
            &format!(" {} ", label),
            fg,
            Some(bg),
            active,
            None,
        ) as i32;
        tx += 1;
    }

    let b = l.body;
    match ui.compact_tab {
        0 => render_compact_pipeline_tab(cv, snap, ctx, sim_time, b),
        1 => render_compact_swarm_tab(cv, snap, clock, ctx, sim_time, b),
        2 => render_compact_advisor_tab(cv, snap, ctx, b),
        _ => render_logs_panel(cv, snap, false, b),
    }

    render_footer(cv, snap, ctx, 1, l.footer_y as i32, l.cols.saturating_sub(2) as usize);
}

fn render_compact_pipeline_tab(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    ctx: &RoleCtx,
    sim_time: f64,
    b: Rect,
) {
    let phase = ctx
        .lead
        .and_then(|w| w.status.clone())
        .unwrap_or_else(|| "대기 중".to_string());
    cv.draw_box(
        b,
        &BoxOpts {
            border_color: theme::ORANGE,
            title: Some(format!(
                "Lead({}) → Decision Gate({} forks)",
                phase, snap.total_forks
            )),
            title_color: Some(theme::ORANGE),
            ..Default::default()
        },
    );
    let ix = b.x as i32 + 2;
    let iw = (b.width - 4) as usize;
    let mut cy = b.y as i32 + 1;
    let y_max = (b.y + b.height - 1) as i32;

    let summary = ctx
        .lead
        .map(|w| w.activity.as_str())
        .unwrap_or("roster 대기 — 활성 세션 없음");
    let effort_suffix = effort_to_gauge(ctx.lead.and_then(|w| w.effort.as_deref()))
        .map(|g| format!(" ({})", g))
        .unwrap_or_default();
    let spin = if ctx.lead_active {
        format!(" {}", spinner_frame(sim_time, 2.0))
    } else {
        String::new()
    };
    cv.write_text(
        ix,
        cy,
        &format!("Lead 메인: {}{}{}", summary, effort_suffix, spin),
        theme::ORANGE,
        Some(theme::BG),
        true,
        Some(iw),
    );
    cy += 2;
    for &ri in sorted_route_indices(snap).iter() {
        if cy >= y_max - 1 {
            break;
        }
        let r = &snap.routes[ri];
        let split = r.forced_split || r.p < SHARP_FLOOR;
        let col = if r.forced_split {
            theme::TRAFFIC_RED
        } else if split {
            theme::ORANGE
        } else {
            theme::GREEN
        };
        cv.write_text(
            ix,
            cy,
            &pad_right_width(r.name, 16),
            col,
            Some(theme::BG),
            false,
            Some(16),
        );
        cv.draw_progress_bar(
            ix + 17,
            cy,
            (iw.saturating_sub(33)).max(8),
            r.p,
            col,
            if split {
                theme::BG_ORANGE_TRACK
            } else {
                theme::BG_GREEN_TRACK
            },
        );
        let tag = if r.forced_split {
            format!("p={:.2} SPLIT!", r.p)
        } else {
            let basis_tag = match r.basis {
                dgate_core::engine::DecisionBasis::Measured => "m",
                dgate_core::engine::DecisionBasis::Prior => "p",
            };
            format!(
                "p={:.2} {} {}:{}",
                r.p,
                if split { "split" } else { "sharp" },
                basis_tag,
                r.samples
            )
        };
        cv.write_right(ix, cy, iw, &tag, col, Some(theme::BG), r.forced_split);
        cy += 1;
    }
    cy += 1;
    if cy < y_max {
        let (text, fg) = match ctx.neon {
            NeonState::Run => (format!("◉ 교차 검증 중 {}", spinner_frame(sim_time, 1.0)), theme::NEON),
            NeonState::Pass => ("✓ 검증 통과".to_string(), theme::GREEN),
            NeonState::Fail => ("✕ 검증 주의".to_string(), theme::TRAFFIC_RED),
            NeonState::Idle => ("○ 대기 · 호출 시 독립 검증".to_string(), theme::MUTED),
        };
        cv.write_text(ix, cy, &format!("Verifier: {}", text), fg, Some(theme::BG), ctx.neon != NeonState::Idle, Some(iw));
        cy += 1;
    }
    if cy < y_max {
        let advice = ctx
            .advisor
            .map(|w| w.activity.as_str())
            .unwrap_or("자문 대기");
        let status = ctx
            .advisor
            .and_then(|w| w.status.clone())
            .unwrap_or_else(|| "대기".to_string());
        cv.write_text(
            ix,
            cy,
            &format!("Advisor({}): {}", status, advice),
            theme::PURPLE,
            Some(theme::BG),
            false,
            Some(iw),
        );
        cy += 1;
    }
    if cy < y_max {
        cv.write_text(
            ix,
            cy,
            "리드 검증: 검토 + 확인",
            theme::ORANGE,
            Some(theme::BG),
            false,
            Some(iw),
        );
    }
}

fn render_compact_swarm_tab(
    cv: &mut Canvas,
    snap: &TuiSnapshot,
    clock: &WorkerClock,
    ctx: &RoleCtx,
    sim_time: f64,
    b: Rect,
) {
    let running_n = ctx
        .cards
        .iter()
        .filter(|c| worker_actively_running(c.worker))
        .count();
    cv.draw_box(
        b,
        &BoxOpts {
            border_color: theme::BLUE,
            title: Some(format!(
                "Workers 하위 에이전트 ({}/{})",
                running_n, ctx.worker_n
            )),
            title_color: Some(theme::BLUE),
            ..Default::default()
        },
    );
    let ix = b.x as i32 + 2;
    let iw = (b.width - 4) as usize;
    let mut cy = b.y as i32 + 1;
    let y_max = (b.y + b.height - 1) as i32;
    if ctx.cards.is_empty() {
        cv.write_centered(
            b.x as i32 + 2,
            cy,
            (b.width - 4) as usize,
            EMPTY_WORKERS_MESSAGE,
            theme::MUTED,
            Some(theme::BG),
            false,
        );
        return;
    }
    for (idx, entry) in ctx.cards.iter().enumerate() {
        if cy >= y_max {
            break;
        }
        let c = entry.worker;
        cv.write_text(
            ix,
            cy,
            &pad_right_width(&c.name, 10),
            theme::BLUE,
            Some(theme::BG),
            true,
            None,
        );
        let status = c.status.as_deref().unwrap_or("live");
        let is_done = status == "done";
        let is_idle = matches!(status, "idle" | "error");
        let demo_idx = if snap.demo { Some(idx) } else { None };
        let elapsed = clock.elapsed_secs(&c.address, demo_idx);
        let turn_suffix = c
            .turn
            .map(|t| format!(" · turn {}", t))
            .unwrap_or_default();
        let (right, fg, bold) = if is_done {
            (
                format!(
                    "✓ 완료{}{}",
                    elapsed
                        .map(|s| format!(" · {}", format_elapsed_mmss(s)))
                        .unwrap_or_default(),
                    turn_suffix
                ),
                theme::GREEN,
                true,
            )
        } else if is_idle {
            if status == "error" {
                ("✕ 오류".to_string(), theme::TRAFFIC_RED, false)
            } else {
                ("▪ 대기 중".to_string(), theme::MUTED, false)
            }
        } else if ctx.motion {
            (
                format!(
                    "{} 실행 중 · {}{}",
                    spinner_frame(sim_time, idx as f64),
                    elapsed
                        .map(format_elapsed_mmss)
                        .unwrap_or_else(|| "RUN".to_string()),
                    turn_suffix
                ),
                theme::BLUE,
                true,
            )
        } else {
            ("◉ 실행 중".to_string(), theme::BLUE, false)
        };
        cv.write_right(ix, cy, iw, &right, fg, Some(theme::BG), bold);
        cy += 1;
        if cy < y_max {
            cv.write_text(
                ix + 2,
                cy,
                &c.activity,
                theme::MUTED,
                Some(theme::BG),
                false,
                Some(iw.saturating_sub(2)),
            );
            cy += 1;
        }
    }
}

fn render_compact_advisor_tab(cv: &mut Canvas, _snap: &TuiSnapshot, ctx: &RoleCtx, b: Rect) {
    let status = ctx
        .advisor
        .and_then(|w| w.status.clone())
        .unwrap_or_else(|| "대기".to_string());
    cv.draw_box(
        b,
        &BoxOpts {
            border_color: theme::PURPLE,
            title: Some(format!("Advisor · 자문 ({})", status)),
            title_color: Some(theme::PURPLE),
            ..Default::default()
        },
    );
    let ix = b.x as i32 + 2;
    let iw = (b.width - 4) as usize;
    let mut cy = b.y as i32 + 1;
    let y_max = (b.y + b.height - 1) as i32;
    for (idx, lbl) in TRIGGER_LABELS.iter().enumerate() {
        if cy >= y_max {
            break;
        }
        let act = ctx.active_trigger == idx as i32;
        cv.write_text(
            ix,
            cy,
            &format!("{} {}", if act { "●" } else { "◇" }, lbl),
            if act { theme::PURPLE } else { theme::MUTED },
            Some(if act {
                theme::BG_TRIGGER_ACTIVE
            } else {
                theme::BG
            }),
            act,
            Some(iw),
        );
        cy += 1;
    }
    cy += 1;
    let advice = ctx
        .advisor
        .map(|w| w.activity.as_str())
        .unwrap_or("자문 대기");
    for line in wrap_by_width(advice, iw, 3) {
        if cy >= y_max {
            break;
        }
        cv.write_text(ix, cy, &line, theme::PURPLE, Some(theme::BG), true, Some(iw));
        cy += 1;
    }
    if cy < y_max {
        let calls = ctx
            .advisor
            .and_then(|w| w.turn)
            .map(|t| t.to_string())
            .unwrap_or_else(|| "—".to_string());
        cv.write_text(
            ix,
            cy,
            &format!("호출 수: {}", calls),
            theme::MUTED,
            Some(theme::BG),
            false,
            Some(iw),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::pad_left_width;
    use crate::state::{demo_snapshot, TuiSnapshot};

    fn render_demo(cols: u16, rows: u16) -> String {
        let snap = demo_snapshot();
        render_to_text(&snap, &UiState::default(), &WorkerClock::default(), cols, rows, 10.0)
    }

    fn render_demo_at(cols: u16, rows: u16, sim_time: f64) -> String {
        let snap = demo_snapshot();
        render_to_text(
            &snap,
            &UiState::default(),
            &WorkerClock::default(),
            cols,
            rows,
            sim_time,
        )
    }

    #[test]
    fn demo_full_layout_shows_two_column_topology() {
        let text = render_demo(140, 40);
        // 상단 헤더 + 이중선 + 범례
        assert!(text.contains("DGATE TUI"), "헤더:\n{}", text);
        assert!(text.contains("═"), "이중선:\n{}", text);
        assert!(text.contains("repo=demo-app"), "스코프:\n{}", text);
        assert!(text.contains("LEAD ["), "카운트:\n{}", text);
        assert!(text.contains("WORKERS ["), "카운트:\n{}", text);
        // 좌측 Advisor + 우측 역할 패널
        for role in ["Advisor", "Lead", "Verifier", "Decision Gate"] {
            assert!(text.contains(role), "{} 패널 없음:\n{}", role, text);
        }
        // sublead 클러스터 표기 + 소유 배지
        assert!(text.contains("sublead-auth · 2"), "클러스터 헤더:\n{}", text);
        assert!(text.contains("↳ sublead-auth"), "소유 배지:\n{}", text);
        // 팬아웃/팬인 레일 접합 문자
        assert!(text.contains('┬'), "팬아웃 레일:\n{}", text);
        assert!(text.contains('┼') || text.contains('┴'), "팬인 레일:\n{}", text);
        // 라우트 + 게이지 태그 — 140×40(비루미)은 원본과 동일하게 상위 3개만,
        // roomy 높이(≥42행)에선 4개 전부 노출된다.
        for label in ["어느 파일", "어느 도구", "재시도 또는 중단"] {
            assert!(text.contains(label), "라우트 {} 없음:\n{}", label, text);
        }
        let tall = render_demo(140, 44);
        assert!(tall.contains("스웜 위임"), "4번째 라우트 없음(140×44):\n{}", tall);
        assert!(text.contains("p=0."), "라우트 p 태그:\n{}", text);
        assert!(text.contains("sharp"), "sharp 판정:\n{}", text);
        assert!(text.contains("SPLIT!"), "강제 split 판정:\n{}", text);
        // 위임 라벨 + 워커 경과(데모는 슬라이딩 필 + MM:SS, 라이브는 '실행 중 · MM:SS').
        assert!(text.contains("하위 에이전트에 위임"), "위임 라벨:\n{}", text);
        assert!(text.contains("00:42"), "워커 경과 mm:ss:\n{}", text);
        // 자문 패널 고정 텍스트 + 와이어
        assert!(text.contains("일상 턴에서는 침묵"), "자문 패널:\n{}", text);
        assert!(text.contains('▶') || text.contains('◈'), "자문 와이어:\n{}", text);
        // 로그 + 푸터
        assert!(text.contains("최근 로그"), "로그 패널:\n{}", text);
        assert!(text.contains("q:종료"), "푸터:\n{}", text);
    }

    #[test]
    fn full_layout_two_column_topology_at_120x36() {
        // brief 계약: 120×36 Full 레이아웃 — Advisor + Lead/Verifier/Gate/Workers + 레일.
        let text = render_demo(120, 36);
        for needle in [
            "Advisor",
            "Lead",
            "Verifier",
            "Decision Gate",
            "Workers",
            "sublead-auth",
        ] {
            assert!(text.contains(needle), "{} 없음:\n{}", needle, text);
        }
        assert!(
            text.contains('┬') || text.contains('┼'),
            "팬아웃 레일(┬/┼) 없음:\n{}",
            text
        );
    }

    #[test]
    fn motion_frames_differ_across_sim_time() {
        // brief 계약: sim_time 0.0 vs 0.5 렌더가 실제로 달라야 한다(모션 실동작 증명).
        let a = render_demo_at(140, 40, 0.0);
        let b = render_demo_at(140, 40, 0.5);
        assert_ne!(a, b, "sim_time이 달라도 출력이 같으면 모션이 동작하지 않는 것");
        // 브레일 스피너 문자가 실제 프레임에 존재.
        let has_spinner = |s: &str| s.chars().any(|c| "⠋⠙⠹⠸⠼⠴⠦⠧".contains(c));
        assert!(has_spinner(&a) || has_spinner(&b), "스피너 프레임 부재");
    }

    #[test]
    fn wire_packet_positions_move_with_time() {
        // 와이어 패킷(●) 위치가 sim_time에 따라 이동한다.
        let find_packets = |s: &str| -> Vec<(usize, usize)> {
            s.lines()
                .enumerate()
                .flat_map(|(y, line)| {
                    line.chars()
                        .enumerate()
                        .filter_map(move |(x, c)| (c == '●').then_some((x, y)))
                })
                .collect()
        };
        let a = find_packets(&render_demo_at(140, 40, 0.0));
        let b = find_packets(&render_demo_at(140, 40, 0.7));
        assert!(!a.is_empty() && !b.is_empty(), "패킷 부재");
        assert_ne!(a, b, "패킷 위치가 고정돼 있으면 와이어 모션이 아님");
    }

    #[test]
    fn compact_layout_for_small_terminal() {
        let text = render_demo(80, 20);
        assert!(text.contains("[1:파이프라인]"), "컴팩트 탭바:\n{}", text);
        assert!(text.contains("DGATE TUI"), "헤더:\n{}", text);
    }

    #[test]
    fn compact_tabs_switch_content() {
        let snap = demo_snapshot();
        for tab in 0..4 {
            let mut ui = UiState::default();
            ui.compact_tab = tab;
            let _ = render_to_text(&snap, &ui, &WorkerClock::default(), 80, 20, 10.0);
        }
        let mut ui = UiState::default();
        ui.compact_tab = 1;
        let text = render_to_text(&snap, &ui, &WorkerClock::default(), 80, 20, 10.0);
        assert!(text.contains("Workers 하위 에이전트"), "스웜 탭:\n{}", text);
    }

    #[test]
    fn render_handles_small_sizes_without_panic() {
        for (c, r) in [(40u16, 10u16), (60, 20), (1, 1), (0, 0), (200, 60), (98, 30)] {
            let _ = render_demo(c, r);
        }
    }

    #[test]
    fn empty_workers_show_honest_empty_state() {
        let mut snap = demo_snapshot();
        snap.roster.workers.clear();
        snap.roster.active_worker_count = 0;
        let text = render_to_text(&snap, &UiState::default(), &WorkerClock::default(), 140, 40, 10.0);
        assert!(text.contains("하위 워커가 없습니다"), "빈 상태:\n{}", text);
    }

    #[test]
    fn selected_worker_card_is_highlighted() {
        let snap = demo_snapshot();
        let mut ui = UiState::default();
        ui.focused = FocusPanel::Swarm;
        ui.worker_select = 0;
        let text = render_to_text(&snap, &ui, &WorkerClock::default(), 140, 40, 10.0);
        assert!(text.contains('▶'), "선택 마커:\n{}", text);
    }

    #[test]
    fn focus_panel_cycles_in_order() {
        assert_eq!(FocusPanel::Advisor.next(), FocusPanel::Main);
        assert_eq!(FocusPanel::Main.next(), FocusPanel::Neon);
        assert_eq!(FocusPanel::Swarm.next(), FocusPanel::Logs);
        assert_eq!(FocusPanel::Logs.next(), FocusPanel::Advisor);
        assert_eq!(FocusPanel::Advisor.prev(), FocusPanel::Logs);
    }

    #[test]
    fn effort_gauge_maps_known_levels() {
        assert_eq!(effort_to_gauge(Some("high")).as_deref(), Some("▮▮▮▯ high"));
        assert_eq!(effort_to_gauge(Some("max")).as_deref(), Some("▮▮▮▮ max+"));
        assert_eq!(effort_to_gauge(None), None);
        assert_eq!(effort_to_gauge(Some("bogus")), None);
    }

    #[test]
    fn non_demo_snapshot_flag_off() {
        let snap: TuiSnapshot = demo_snapshot();
        assert!(snap.routes.len() >= 4);
    }

    #[test]
    fn pad_left_width_helper() {
        assert_eq!(pad_left_width("42%", 4), " 42%");
    }
}
