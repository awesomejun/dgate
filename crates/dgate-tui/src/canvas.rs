//! 직접 버퍼 그리기 프리미티브 — `src/core/buffer.ts` `CellBuffer`의 Rust 미러.
//!
//! 목적: 위젯 트리 대신 절대 좌표 셀 쓰기로 원본 토폴로지 렌더를 재현한다.
//! 텍스트 폭 규칙(`codePointWidth` — 한글·CJK·전각 2셀, 나머지 1셀)과
//! 박스/프로그레스 바/펄스/불정 바/스피너 알고리즘은 원본과 1:1이다.
//!
//! 주의:
//! - 모든 좌표는 버퍼 전역 좌표. 범위 밖 쓰기는 조용히 무시한다
//!   (`set_stringn`은 y가 버퍼 밖이면 패닉하므로 항상 `in_bounds`로 막는다).
//! - 멀티폭 문자는 `Buffer::set_stringn` 경유로만 쓴다(다음 셀 자동 리셋).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};

use crate::theme::{self, lerp_color};

// ---------------------------------------------------------------------------
// 셀 폭 규칙 — `src/core/width.ts` `codePointWidth` 미러
// ---------------------------------------------------------------------------

/// 코드포인트 → 표시 셀 폭(0/1/2) — `codePointWidth` 미러.
fn code_point_width(cp: u32) -> usize {
    if cp == 0 {
        return 0;
    }
    if cp < 0x20 || (0x7f..0xa0).contains(&cp) {
        return 0;
    }
    // 결합 문자 (Combining marks)
    if (0x0300..=0x036f).contains(&cp)
        || (0x1ab0..=0x1aff).contains(&cp)
        || (0x1dc0..=0x1dff).contains(&cp)
        || (0x20d0..=0x20ff).contains(&cp)
        || (0xfe00..=0xfe0f).contains(&cp)
        || (0xfe20..=0xfe2f).contains(&cp)
    {
        return 0;
    }
    // 한글 자모·가~힣, CJK, 전각 형태, 이모지 대역 → 2셀
    if (0x1100..=0x115f).contains(&cp)
        || cp == 0x2329
        || cp == 0x232a
        || (0x2e80..=0x303e).contains(&cp)
        || (0x3040..=0x33bf).contains(&cp)
        || (0x3400..=0x4dbf).contains(&cp)
        || (0x4e00..=0xa4cf).contains(&cp)
        || (0xa960..=0xa97f).contains(&cp)
        || (0xac00..=0xd7a3).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0xfe10..=0xfe19).contains(&cp)
        || (0xfe30..=0xfe6f).contains(&cp)
        || (0xff01..=0xff60).contains(&cp)
        || (0xffe0..=0xffe6).contains(&cp)
        || (0x1f300..=0x1faff).contains(&cp)
        || (0x20000..=0x3fffd).contains(&cp)
    {
        return 2;
    }
    1
}

/// 문자열 표시 셀 폭 — `stringWidth` 미러.
pub fn string_width(s: &str) -> usize {
    s.chars().map(|c| code_point_width(c as u32)).sum()
}

/// 최대 셀 폭으로 자르고 말줄임표 부착 — `truncateWidth` 미러.
pub fn truncate_width(s: &str, max_width: usize, ellipsis: &str) -> String {
    if max_width == 0 {
        return String::new();
    }
    if string_width(s) <= max_width {
        return s.to_string();
    }
    let ell_w = string_width(ellipsis);
    if max_width <= ell_w {
        return slice_by_width(s, max_width);
    }
    let target = max_width - ell_w;
    let mut acc = 0usize;
    let mut out = String::new();
    for ch in s.chars() {
        let cw = code_point_width(ch as u32);
        if acc + cw > target {
            break;
        }
        out.push(ch);
        acc += cw;
    }
    format!("{}{}", out, ellipsis)
}

/// 말줄임표 없이 최대 셀 폭까지 자르기 — `sliceByWidth` 미러.
fn slice_by_width(s: &str, max_width: usize) -> String {
    let mut acc = 0usize;
    let mut out = String::new();
    for ch in s.chars() {
        let cw = code_point_width(ch as u32);
        if acc + cw > max_width {
            break;
        }
        out.push(ch);
        acc += cw;
    }
    out
}

/// 우측 공백 패딩 — `padRightWidth` 미러.
pub fn pad_right_width(s: &str, target_width: usize) -> String {
    let clipped = truncate_width(s, target_width, "…");
    let w = string_width(&clipped);
    if w < target_width {
        format!("{}{}", clipped, " ".repeat(target_width - w))
    } else {
        clipped
    }
}

/// 좌측 공백 패딩 — `padLeftWidth` 미러.
pub fn pad_left_width(s: &str, target_width: usize) -> String {
    let clipped = truncate_width(s, target_width, "…");
    let w = string_width(&clipped);
    if w < target_width {
        format!("{}{}", " ".repeat(target_width - w), clipped)
    } else {
        clipped
    }
}

/// 한글 어절(공백 분리) 우선 줄바꿈 — `wrapByWidth` 미러.
pub fn wrap_by_width(text: &str, max_width: usize, max_lines: usize) -> Vec<String> {
    if max_width == 0 {
        return Vec::new();
    }
    let mut lines: Vec<String> = Vec::new();
    for para in text.split('\n') {
        if para.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut current_w = 0usize;
        for word in para.split(' ') {
            let word_w = string_width(word);
            if current.is_empty() {
                if word_w <= max_width {
                    current = word.to_string();
                    current_w = word_w;
                } else {
                    // 어절 자체가 maxWidth보다 길면 글자 단위로 분할
                    current = split_word(word, max_width, &mut lines);
                    current_w = string_width(&current);
                }
            } else if current_w + 1 + word_w <= max_width {
                current.push(' ');
                current.push_str(word);
                current_w += 1 + word_w;
            } else {
                lines.push(std::mem::take(&mut current));
                if word_w <= max_width {
                    current = word.to_string();
                    current_w = word_w;
                } else {
                    current = split_word(word, max_width, &mut lines);
                    current_w = string_width(&current);
                }
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        if let Some(last) = lines.last_mut() {
            *last = truncate_width(last, max_width, "…");
        }
    }
    lines
}

/// 어절을 max_width 단위로 쪼개 lines에 밀어넣고 마지막 조각을 돌려준다.
fn split_word(word: &str, max_width: usize, lines: &mut Vec<String>) -> String {
    let mut chunk = String::new();
    let mut chunk_w = 0usize;
    for ch in word.chars() {
        let cw = code_point_width(ch as u32);
        if chunk_w + cw > max_width {
            lines.push(std::mem::take(&mut chunk));
            chunk_w = 0;
        }
        chunk.push(ch);
        chunk_w += cw;
    }
    chunk
}

// ---------------------------------------------------------------------------
// 스피너 · 불정 바 · 펄스 — 모션 프리미티브 (`renderApp.ts`/`buffer.ts` 미러)
// ---------------------------------------------------------------------------

/// 브레일 스피너 프레임 — `SPINNER_FRAMES` 미러(simTime 8fps, seed 위상 오프셋).
pub const SPINNER_FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

/// `spinnerFrame` 미러 — `floor(simTime*8 + seed) mod 8`.
pub fn spinner_frame(sim_time: f64, seed: f64) -> &'static str {
    let idx = ((sim_time * 8.0 + seed).floor() as i64).rem_euclid(8) as usize;
    SPINNER_FRAMES[idx]
}

/// 프로그레스 바 부분 블록 — `EIGHTH_BLOCKS` 미러.
const EIGHTH_BLOCKS: [char; 9] = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/// 박스 스타일 — `BOX_CHARS` 미러.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxStyle {
    Single,
    Heavy,
    Double,
}

struct BoxChars {
    tl: char,
    tr: char,
    bl: char,
    br: char,
    h: char,
    v: char,
}

fn box_chars(style: BoxStyle) -> BoxChars {
    match style {
        BoxStyle::Single => BoxChars {
            tl: '┌',
            tr: '┐',
            bl: '└',
            br: '┘',
            h: '─',
            v: '│',
        },
        BoxStyle::Heavy => BoxChars {
            tl: '┏',
            tr: '┓',
            bl: '┗',
            br: '┛',
            h: '━',
            v: '┃',
        },
        BoxStyle::Double => BoxChars {
            tl: '╔',
            tr: '╗',
            bl: '╚',
            br: '╝',
            h: '═',
            v: '║',
        },
    }
}

/// 색 입힌 텍스트 조각 — `TextSegment` 미러.
#[derive(Debug, Clone)]
pub struct Seg {
    pub text: String,
    pub fg: Color,
    pub bg: Option<Color>,
    pub bold: bool,
}

impl Seg {
    pub fn new(text: impl Into<String>, fg: Color) -> Self {
        Seg {
            text: text.into(),
            fg,
            bg: None,
            bold: false,
        }
    }
    pub fn bg(mut self, bg: Color) -> Self {
        self.bg = Some(bg);
        self
    }
    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }
}

/// drawBox 옵션 — `buf.drawBox` 두 번째 인자 미러.
#[derive(Debug, Default)]
pub struct BoxOpts {
    pub style: Option<BoxStyle>,
    pub border_color: Color,
    pub fill_bg: Option<Color>,
    pub title: Option<String>,
    pub title_color: Option<Color>,
    pub right_label: Option<String>,
    pub right_label_color: Option<Color>,
    pub bold_border: bool,
}

/// 절대 좌표 버퍼 캔버스 — `CellBuffer` 미러.
pub struct Canvas<'a> {
    pub buf: &'a mut Buffer,
}

impl<'a> Canvas<'a> {
    pub fn new(buf: &'a mut Buffer) -> Self {
        Canvas { buf }
    }

    fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.buf.area.width as i32 && y < self.buf.area.height as i32
    }

    /// 단일 문자 기록 — `setChar` 미러(범위 밖 무시, 반환 셀 폭).
    pub fn set_char(&mut self, x: i32, y: i32, ch: &str, fg: Color, bg: Option<Color>, bold: bool) {
        if !self.in_bounds(x, y) {
            return;
        }
        if let Some(cell) = self.buf.cell_mut((x as u16, y as u16)) {
            cell.set_symbol(ch);
            cell.fg = fg;
            if let Some(b) = bg {
                cell.bg = b;
            }
            if bold {
                cell.modifier.insert(Modifier::BOLD);
            } else {
                cell.modifier.remove(Modifier::BOLD);
            }
        }
    }

    /// 영역 채우기 — `fillRect` 미러.
    pub fn fill_rect(&mut self, r: Rect, bg: Color, fg: Color, ch: char) {
        let area = self.buf.area;
        // x+width 합산이 u16 범위를 넘을 수 있어 i32로 계산한다.
        let x0 = (r.x as i32).max(area.x as i32);
        let y0 = (r.y as i32).max(area.y as i32);
        let x1 = (r.x as i32 + r.width as i32).min(area.x as i32 + area.width as i32);
        let y1 = (r.y as i32 + r.height as i32).min(area.y as i32 + area.height as i32);
        let s = ch.to_string();
        for y in y0..y1 {
            for x in x0..x1 {
                self.set_char(x, y, &s, fg, Some(bg), false);
            }
        }
    }

    /// 텍스트 쓰기 — `writeText` 미러(max_width 시 말줄임, 반환 소비 폭).
    /// 인자 수는 원본 `writeText(x, y, text, fg, bg, bold, maxWidth)` 시그니처를 따른다.
    #[allow(clippy::too_many_arguments)]
    pub fn write_text(
        &mut self,
        x: i32,
        y: i32,
        text: &str,
        fg: Color,
        bg: Option<Color>,
        bold: bool,
        max_width: Option<usize>,
    ) -> usize {
        if y < 0 || y >= self.buf.area.height as i32 || x >= self.buf.area.width as i32 {
            return 0;
        }
        let clipped = match max_width {
            Some(w) => truncate_width(text, w, "…"),
            None => text.to_string(),
        };
        if clipped.is_empty() {
            return 0;
        }
        let mut style = Style::default().fg(fg);
        if let Some(b) = bg {
            style = style.bg(b);
        }
        if bold {
            style = style.add_modifier(Modifier::BOLD);
        }
        // set_stringn은 x 클램프만 내부 처리 — 음수 x는 직접 자른다.
        let (cx, skip_w) = if x < 0 {
            (0u16, (-x) as usize)
        } else {
            (x as u16, 0usize)
        };
        let mut written = 0usize;
        if skip_w > 0 {
            let mut acc = 0usize;
            let mut start_byte = 0usize;
            for (bi, ch) in clipped.char_indices() {
                let cw = code_point_width(ch as u32);
                if acc + cw > skip_w {
                    start_byte = bi;
                    break;
                }
                acc += cw;
                start_byte = bi + ch.len_utf8();
            }
            if start_byte < clipped.len() {
                let max_w = max_width.map(|w| w.saturating_sub(skip_w)).unwrap_or(u16::MAX as usize);
                let pos = self
                    .buf
                    .set_stringn(cx, y as u16, &clipped[start_byte..], max_w, style);
                written = (pos.0 - cx) as usize;
            }
        } else {
            let max_w = max_width.unwrap_or(u16::MAX as usize);
            let pos = self
                .buf
                .set_stringn(cx, y as u16, &clipped, max_w, style);
            written = (pos.0 - cx) as usize;
        }
        written
    }

    /// 중앙 정렬 쓰기 — `writeCentered` 미러(원본과 같은 인자 형태).
    #[allow(clippy::too_many_arguments)]
    pub fn write_centered(
        &mut self,
        x: i32,
        y: i32,
        width: usize,
        text: &str,
        fg: Color,
        bg: Option<Color>,
        bold: bool,
    ) {
        if width == 0 {
            return;
        }
        let clipped = truncate_width(text, width, "…");
        let tw = string_width(&clipped);
        let start_x = x + ((width as i32 - tw as i32).max(0) / 2);
        self.write_text(start_x, y, &clipped, fg, bg, bold, Some(width));
    }

    /// 우측 정렬 쓰기 — `writeRight` 미러(원본과 같은 인자 형태).
    #[allow(clippy::too_many_arguments)]
    pub fn write_right(
        &mut self,
        x: i32,
        y: i32,
        width: usize,
        text: &str,
        fg: Color,
        bg: Option<Color>,
        bold: bool,
    ) {
        if width == 0 {
            return;
        }
        let clipped = truncate_width(text, width, "…");
        let tw = string_width(&clipped);
        let start_x = x + (width as i32 - tw as i32).max(0);
        self.write_text(start_x, y, &clipped, fg, bg, bold, Some(width));
    }

    /// 세그먼트 연속 쓰기 — `writeSegments` 미러.
    pub fn write_segments(&mut self, x: i32, y: i32, segments: &[Seg], max_width: Option<usize>) {
        let mut cx = x;
        for seg in segments {
            let remain = max_width.map(|w| w as i32 - (cx - x));
            if remain.is_some_and(|r| r <= 0) {
                break;
            }
            cx += self.write_text(
                cx,
                y,
                &seg.text,
                seg.fg,
                seg.bg,
                seg.bold,
                remain.map(|r| r.max(0) as usize),
            ) as i32;
        }
    }

    /// 세그먼트 중앙 정렬 — `writeSegmentsCentered` 미러.
    pub fn write_segments_centered(&mut self, x: i32, y: i32, width: usize, segments: &[Seg]) {
        let total_w: usize = segments.iter().map(|s| string_width(&s.text)).sum();
        let start_x = x + ((width as i32 - total_w as i32).max(0) / 2);
        self.write_segments(start_x, y, segments, Some(width));
    }

    /// 가로선 — `drawHLine` 미러.
    pub fn draw_hline(&mut self, x: i32, y: i32, len: usize, ch: char, fg: Color, bg: Option<Color>) {
        let s = ch.to_string();
        for i in 0..len {
            self.set_char(x + i as i32, y, &s, fg, bg, false);
        }
    }

    /// 박스 — `drawBox` 미러(모서리·테두리·타이틀·우측 라벨).
    pub fn draw_box(&mut self, r: Rect, opts: &BoxOpts) {
        if r.width < 2 || r.height < 2 {
            return;
        }
        let chars = box_chars(opts.style.unwrap_or(BoxStyle::Single));
        let bg = opts.fill_bg.unwrap_or(theme::BG);
        if let Some(fill) = opts.fill_bg {
            self.fill_rect(r, fill, theme::FG, ' ');
        }
        let x0 = r.x as i32;
        let y0 = r.y as i32;
        let x1 = (r.x + r.width - 1) as i32;
        let y1 = (r.y + r.height - 1) as i32;
        let b = opts.bold_border;
        let bc = opts.border_color;

        self.set_char(x0, y0, &chars.tl.to_string(), bc, Some(bg), b);
        self.set_char(x1, y0, &chars.tr.to_string(), bc, Some(bg), b);
        self.set_char(x0, y1, &chars.bl.to_string(), bc, Some(bg), b);
        self.set_char(x1, y1, &chars.br.to_string(), bc, Some(bg), b);
        let hs = chars.h.to_string();
        let vs = chars.v.to_string();
        for x in (x0 + 1)..x1 {
            self.set_char(x, y0, &hs, bc, Some(bg), b);
            self.set_char(x, y1, &hs, bc, Some(bg), b);
        }
        for y in (y0 + 1)..y1 {
            self.set_char(x0, y, &vs, bc, Some(bg), b);
            self.set_char(x1, y, &vs, bc, Some(bg), b);
        }

        if let Some(title) = &opts.title {
            if r.width > 6 {
                let label = format!(" {} ", title);
                self.write_text(
                    x0 + 2,
                    y0,
                    &label,
                    opts.title_color.unwrap_or(theme::MUTED),
                    Some(bg),
                    false,
                    Some((r.width - 4) as usize),
                );
            }
        }
        if let Some(right_label) = &opts.right_label {
            if r.width > 10 {
                let r_label = format!(" {} ", right_label);
                let rw = string_width(&r_label);
                let rx = x1 - 1 - rw as i32;
                if rx > x0 + 2 {
                    self.write_text(
                        rx,
                        y0,
                        &r_label,
                        opts.right_label_color.unwrap_or(theme::MUTED),
                        Some(bg),
                        false,
                        Some(rw),
                    );
                }
            }
        }
    }

    /// 프로그레스 바 — `drawProgressBar` 미러(1/8 서브블록 + 5칸 스트라이프 명암).
    pub fn draw_progress_bar(
        &mut self,
        x: i32,
        y: i32,
        width: usize,
        ratio: f64,
        fill_fg: Color,
        track_bg: Color,
    ) {
        if width == 0 {
            return;
        }
        let clamped = ratio.clamp(0.0, 1.0);
        let total_eighths = (clamped * width as f64 * 8.0).round() as usize;
        let full_cells = total_eighths / 8;
        let rem_eighths = total_eighths % 8;

        let stripe_fill = lerp_color(fill_fg, theme::BG, 0.14);
        let stripe_track = lerp_color(track_bg, theme::BG, 0.25);

        for i in 0..width {
            let is_stripe = i % 5 == 4;
            let cell_track = if is_stripe { stripe_track } else { track_bg };
            let cell_fill = if is_stripe { stripe_fill } else { fill_fg };
            if i < full_cells {
                self.set_char(x + i as i32, y, "█", cell_fill, Some(cell_track), false);
            } else if i == full_cells && rem_eighths > 0 {
                self.set_char(
                    x + i as i32,
                    y,
                    &EIGHTH_BLOCKS[rem_eighths].to_string(),
                    cell_fill,
                    Some(cell_track),
                    false,
                );
            } else {
                self.set_char(
                    x + i as i32,
                    y,
                    "░",
                    lerp_color(cell_track, theme::MUTED, 0.18),
                    Some(cell_track),
                    false,
                );
            }
        }
    }

    /// 데이터 흐름 펄스 — `drawPulseAlongPath` 미러(헤드 + 2칸 잔상).
    pub fn draw_pulse_along_path(
        &mut self,
        path: &[(i32, i32)],
        progress01: f64,
        color: Color,
        head_glyph: &str,
    ) {
        if path.is_empty() {
            return;
        }
        let p = progress01.rem_euclid(1.0);
        let head_idx = (p * path.len() as f64) as i64;
        for offset in (0..=2i64).rev() {
            let idx = head_idx - offset;
            if idx < 0 || idx >= path.len() as i64 {
                continue;
            }
            let (px, py) = path[idx as usize];
            if !self.in_bounds(px, py) {
                continue;
            }
            let Some(existing) = self.buf.cell((px as u16, py as u16)) else {
                continue;
            };
            let sym = existing.symbol().to_string();
            let efg = existing.fg;
            let ebg = existing.bg;
            if offset == 0 {
                self.set_char(px, py, head_glyph, color, Some(ebg), true);
            } else {
                let faded = lerp_color(color, efg, offset as f64 * 0.38);
                self.set_char(px, py, &sym, faded, Some(ebg), false);
            }
        }
    }

    /// 부재 진행률(슬라이딩 활동 필) — `drawIndeterminateBar` 미러
    /// (원본과 같은 인자 형태: 위치 + 색 2종 + 시간 + 카드 시드).
    #[allow(clippy::too_many_arguments)]
    pub fn draw_indeterminate_bar(
        &mut self,
        x: i32,
        y: i32,
        w: usize,
        fill_fg: Color,
        track_bg: Color,
        sim_time: f64,
        seed: f64,
    ) {
        if w == 0 {
            return;
        }
        let block_w = (w / 4).max(3);
        let track_fg = lerp_color(track_bg, theme::MUTED, 0.18);
        for i in 0..w {
            self.set_char(x + i as i32, y, "░", track_fg, Some(track_bg), false);
        }
        let travel = w + block_w;
        let t = (sim_time * 0.7 + seed * 0.31).rem_euclid(1.0);
        let start = (t * travel as f64).round() as i32 - block_w as i32;
        for i in 0..block_w as i32 {
            let px = x + start + i;
            if px >= x && px < x + w as i32 {
                self.set_char(px, y, "█", fill_fg, Some(track_bg), true);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_rules() {
        assert_eq!(string_width("abc"), 3);
        assert_eq!(string_width("가나다"), 6);
        assert_eq!(string_width("━●◈"), 3);
    }

    #[test]
    fn truncate_and_pads() {
        assert_eq!(truncate_width("가나다라", 5, "…"), "가나…");
        assert_eq!(pad_right_width("ab", 4), "ab  ");
        assert_eq!(pad_left_width("ab", 4), "  ab");
    }

    #[test]
    fn spinner_frames_rotate_with_time() {
        assert_eq!(spinner_frame(0.0, 0.0), "⠋");
        assert_eq!(spinner_frame(0.125, 0.0), "⠙");
        assert_ne!(spinner_frame(0.0, 2.0), spinner_frame(0.5, 2.0));
    }

    #[test]
    fn wrap_by_width_keeps_words() {
        let lines = wrap_by_width("세션 전체 도구 호출", 8, 3);
        assert!(lines.len() >= 2);
        assert!(lines.iter().all(|l| string_width(l) <= 8));
    }
}
