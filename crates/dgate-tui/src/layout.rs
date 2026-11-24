//! 토폴로지 레이아웃 계산 — `src/ui/layout.ts` `computeLayout`의 Rust 미러(SSOT).
//!
//! 목적: 2컬럼 배치(좌측 Advisor + 우측 Lead↔Verifier → Decision Gate →
//! 팬아웃 레일 → Workers 카드 행 → 팬인 → 다시 Lead)의 모든 패널·와이어
//! 좌표를 터미널 크기에서 결정론적으로 산출한다. 계산식·임계값은 원본과 1:1
//! (`cols < 98 || rows < 30`이면 Compact 폴백).
//!
//! 주의: 모든 좌표는 셀 단위 u16. 중간 산출은 음수가 될 수 있어 i32로 계산한
//! 뒤 0 미만은 0으로 클램프한다(렌더 단은 추가 클램프 없이 그대로 그린다).

use ratatui::layout::Rect;

/// Full 레이아웃 — 원본 `FullLayout` 인터페이스 필드 대응.
#[derive(Debug, Clone, PartialEq)]
pub struct FullLayout {
    pub cols: u16,
    pub rows: u16,
    pub pad_x: u16,
    pub show_chrome: bool,
    pub header_y: u16,
    pub nav_y: u16,

    pub advisor: Rect,
    pub tr0_row: u16,
    pub tr1_row: u16,
    pub tr2_row: u16,

    pub center_x: u16,
    pub main: Rect,
    pub neon: Rect,
    pub neon_link_row: u16,
    pub decision: Rect,
    pub delegate_label_y: u16,
    pub fan_out_y: u16,
    /// 실제 렌더링되는 워커 카드 수(1..=max_card_slots) — center_x 기준 정렬.
    pub cards: Vec<Rect>,
    pub fan_in_y: u16,
    pub back: Rect,

    pub logs: Rect,
    pub footer_y: u16,
}

/// Compact 폴백 — 작은 터미널의 탭 모드(`cols < 98 || rows < 30`).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactLayout {
    pub cols: u16,
    pub rows: u16,
    pub header_y: u16,
    pub tab_bar_y: u16,
    pub body: Rect,
    pub footer_y: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ComputedLayout {
    Full(FullLayout),
    Compact(CompactLayout),
}

/// 전체 레이아웃 파이프라인 영역 폭 — 카드 슬롯 상한 산정과 compute_layout이 공유.
pub fn pipeline_width_for(cols: u16) -> i32 {
    pipeline_metrics_for(cols).2
}

/// (pad_x, pipe_x, pipe_w, advisor_w) — `pipelineMetricsFor` 미러.
fn pipeline_metrics_for(cols: u16) -> (i32, i32, i32, i32) {
    let cols = cols as i32;
    let pad_x = if cols >= 136 { 2 } else { 1 };
    let advisor_w = if cols >= 142 {
        36
    } else if cols >= 122 {
        32
    } else {
        28
    };
    let bridge_min = if cols >= 142 {
        6
    } else if cols >= 122 {
        5
    } else {
        3
    };
    let pipe_x = pad_x + advisor_w + bridge_min;
    (
        pad_x,
        pipe_x,
        (cols - pad_x - pipe_x).max(58),
        advisor_w,
    )
}

/// 현재 폭에서 렌더링 가능한 워커 카드 최대 슬롯 수 — 파이프 폭 기반 2~4개.
pub fn max_card_slots_for(cols: u16) -> usize {
    let pipe_w = pipeline_width_for(cols);
    if pipe_w >= 92 {
        4
    } else if pipe_w >= 68 {
        3
    } else {
        2
    }
}

fn u16_clamp(v: i32) -> u16 {
    v.max(0) as u16
}

fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
    Rect::new(u16_clamp(x), u16_clamp(y), u16_clamp(w), u16_clamp(h))
}

/// `computeLayout` 미러 — Full(2컬럼 토폴로지) 또는 Compact(탭 폴백) 반환.
/// `visible_card_count`는 실제 보여줄 워커 카드 수(라이브 목록 길이 기준).
pub fn compute_layout(cols: u16, rows: u16, visible_card_count: usize) -> ComputedLayout {
    let cols = cols as i32;
    let rows = rows as i32;

    if cols < 98 || rows < 30 {
        let header_y = 0;
        let tab_bar_y = 2;
        let footer_y = (rows - 1).max(4);
        let body_y = 3;
        let body_h = (footer_y - body_y).max(3);
        return ComputedLayout::Compact(CompactLayout {
            cols: u16_clamp(cols),
            rows: u16_clamp(rows),
            header_y: u16_clamp(header_y),
            tab_bar_y: u16_clamp(tab_bar_y),
            body: rect(1, body_y, (cols - 2).max(10), body_h),
            footer_y: u16_clamp(footer_y),
        });
    }

    let pad_x = if cols >= 136 { 2 } else { 1 };
    let show_chrome = rows >= 38;
    let header_y = if show_chrome { 1 } else { 0 };
    let nav_y = header_y + 2;
    let footer_y = rows - 1;

    // 로그 패널 높이 결정 (원본은 5줄 = 높이 7)
    let log_lines = if rows >= 41 {
        5
    } else if rows >= 36 {
        4
    } else {
        3
    };
    let log_h = log_lines + 2;
    let bottom_gap = if rows >= 40 { 1 } else { 0 };
    let logs_y = footer_y - bottom_gap - log_h;

    let top_gap = if rows >= 42 { 1 } else { 0 };
    let work_top = nav_y + 1 + top_gap;
    let work_bottom = logs_y - if rows >= 39 { 1 } else { 0 };
    let work_h = (work_bottom - work_top).max(21);

    // 우측 파이프라인 각 박스 높이 배분 (기본 최소 21행 필요)
    let roomy = work_h >= 28;
    let medium = work_h >= 25;

    let main_h = if roomy { 6 } else { 5 };
    let decision_h = if roomy { 7 } else { 6 };
    let card_h = if roomy {
        7
    } else if medium {
        6
    } else {
        5
    };
    let back_h = if roomy { 4 } else { 3 };

    let fixed_boxes_h = main_h + decision_h + card_h + back_h;
    let remain_wire_rows = (work_h - fixed_boxes_h).max(4);

    // 와이어 구간 3곳 분배: gap1(main->decision), gap2(decision->cards), gap3(cards->back)
    let gap2 = ((remain_wire_rows as f64 * 0.5).ceil() as i32).clamp(2, 4);
    let rest_after_gap2 = (remain_wire_rows - gap2).max(2);
    let gap1 = (rest_after_gap2 / 2).max(1);
    let gap3 = (rest_after_gap2 - gap1).max(1);

    // 좌우 폭 계산
    let (_, pipe_x, pipe_w, advisor_w) = pipeline_metrics_for(cols as u16);
    let center_x = pipe_x + pipe_w / 2;

    // 각 패널 X/W 계산 (Lead 메인 중앙 축 대칭 + 우측 Verifier 교차 검증 패널)
    let right_bound = cols - pad_x;
    let neon_link_gap = if pipe_w >= 96 {
        4
    } else if pipe_w >= 78 {
        3
    } else {
        2
    };
    let neon_w = if pipe_w >= 112 {
        32
    } else if pipe_w >= 96 {
        28
    } else if pipe_w >= 78 {
        26
    } else {
        23
    };
    let neon_x = right_bound - neon_w;
    let neon_y = work_top;

    let ideal_main_w = if pipe_w >= 112 {
        42
    } else if pipe_w >= 96 {
        38
    } else if pipe_w >= 78 {
        36
    } else {
        34
    };
    let max_right_half = neon_x - neon_link_gap - center_x;
    let mut main_w = ideal_main_w;
    let mut main_x = center_x - main_w / 2;

    if main_x + main_w > neon_x - neon_link_gap {
        if max_right_half >= 17 {
            main_w = ideal_main_w.min(max_right_half * 2);
            main_x = center_x - main_w / 2;
        } else {
            let max_main_w = (neon_x - neon_link_gap - (pipe_x + 2)).max(26);
            main_w = ideal_main_w.min(max_main_w);
            main_x = neon_x - neon_link_gap - main_w;
        }
    }
    if center_x >= main_x + main_w - 1 {
        main_x = (neon_x - neon_link_gap - main_w).min(center_x - main_w + 3);
    }
    let main_y = work_top;
    let neon_link_row = main_y + main_h / 2;

    let decision_w = (pipe_w - 2).min(70);
    let decision_x = center_x - decision_w / 2;
    let decision_y = main_y + main_h + gap1;

    let cards_y = decision_y + decision_h + gap2;
    // 가변 워커 카드 — 실제 보여줄 카드 수만큼(1..=max_slots) center_x 중심 정렬.
    let max_cols = max_card_slots_for(cols as u16);
    let visible_count = visible_card_count.clamp(1, max_cols) as i32;
    let card_gap = if visible_count >= 4 {
        2
    } else if pipe_w >= 96 {
        3
    } else {
        2
    };
    let max_cards_span = pipe_w.min(102);
    let card_w = ((max_cards_span - card_gap * (visible_count - 1)) / visible_count).max(18);
    let actual_cards_span = card_w * visible_count + card_gap * (visible_count - 1);
    let cards_start_x = center_x - actual_cards_span / 2;
    let card_rects: Vec<Rect> = (0..visible_count)
        .map(|i| {
            rect(
                cards_start_x + (card_w + card_gap) * i,
                cards_y,
                card_w,
                card_h,
            )
        })
        .collect();

    let fan_out_y = cards_y - 1;
    let delegate_label_y = if gap2 >= 2 {
        cards_y - 2
    } else {
        fan_out_y
    };

    let back_y = cards_y + card_h + gap3;
    let back_w = (pipe_w - 4).min(52);
    let back_x = center_x - back_w / 2;
    let fan_in_y = cards_y + card_h;

    let pipeline_bottom = back_y + back_h;
    let advisor_rect = rect(pad_x, main_y, advisor_w, (pipeline_bottom - main_y).max(18));

    // Advisor 3대 트리거 행을 우측 타겟 패널 내부 행과 1:1 정렬
    let tr0_row = main_y + (main_h - 2).min((main_h / 2 + 1).max(3));
    let tr1_row = cards_y + card_h / 2;
    let tr2_row = back_y + back_h / 2;

    let logs_rect = rect(pad_x, logs_y, cols - pad_x * 2, log_h);

    ComputedLayout::Full(FullLayout {
        cols: u16_clamp(cols),
        rows: u16_clamp(rows),
        pad_x: u16_clamp(pad_x),
        show_chrome,
        header_y: u16_clamp(header_y),
        nav_y: u16_clamp(nav_y),
        advisor: advisor_rect,
        tr0_row: u16_clamp(tr0_row),
        tr1_row: u16_clamp(tr1_row),
        tr2_row: u16_clamp(tr2_row),
        center_x: u16_clamp(center_x),
        main: rect(main_x, main_y, main_w, main_h),
        neon: rect(neon_x, neon_y, neon_w, main_h),
        neon_link_row: u16_clamp(neon_link_row),
        decision: rect(decision_x, decision_y, decision_w, decision_h),
        delegate_label_y: u16_clamp(delegate_label_y),
        fan_out_y: u16_clamp(fan_out_y),
        cards: card_rects,
        fan_in_y: u16_clamp(fan_in_y),
        back: rect(back_x, back_y, back_w, back_h),
        logs: logs_rect,
        footer_y: u16_clamp(footer_y),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(cols: u16, rows: u16, cards: usize) -> FullLayout {
        match compute_layout(cols, rows, cards) {
            ComputedLayout::Full(l) => l,
            ComputedLayout::Compact(_) => panic!("full 기대: {}x{}", cols, rows),
        }
    }

    #[test]
    fn compact_below_threshold() {
        assert!(matches!(
            compute_layout(97, 40, 3),
            ComputedLayout::Compact(_)
        ));
        assert!(matches!(
            compute_layout(140, 29, 3),
            ComputedLayout::Compact(_)
        ));
        assert!(matches!(
            compute_layout(98, 30, 3),
            ComputedLayout::Full(_)
        ));
    }

    #[test]
    fn full_two_column_topology_at_140x40() {
        let l = full(140, 40, 3);
        // 좌측 Advisor 컬럼 + 우측 파이프라인 컬럼 분리.
        assert!(l.advisor.x < l.main.x);
        assert!(l.advisor.width >= 28);
        // Lead → Decision → 카드 → Back 세로 흐름.
        assert!(l.main.y + l.main.height <= l.decision.y);
        assert!(l.decision.y + l.decision.height <= l.cards[0].y);
        assert!(l.cards[0].y + l.cards[0].height <= l.back.y);
        // 팬아웃 레일은 카드 바로 위, Verifier는 Lead 우측.
        assert_eq!(l.fan_out_y, l.cards[0].y - 1);
        assert!(l.neon.x > l.main.x + l.main.width);
        // 로그·푸터는 하단.
        assert!(l.logs.y > l.back.y);
        assert_eq!(l.footer_y, 39);
    }

    #[test]
    fn card_slots_follow_pipeline_width() {
        assert_eq!(max_card_slots_for(100), 2);
        assert_eq!(max_card_slots_for(120), 3);
        assert_eq!(max_card_slots_for(150), 4);
        // 슬롯 상한으로 클램프되고 최소 1장은 유지.
        assert_eq!(full(100, 40, 9).cards.len(), 2);
        assert_eq!(full(140, 40, 0).cards.len(), 1);
    }

    #[test]
    fn compact_layout_rows() {
        let ComputedLayout::Compact(l) = compute_layout(80, 20, 2) else {
            panic!("compact 기대")
        };
        assert_eq!(l.header_y, 0);
        assert_eq!(l.tab_bar_y, 2);
        assert_eq!(l.footer_y, 19);
        assert!(l.body.height >= 3);
    }
}
