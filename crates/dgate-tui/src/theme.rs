//! dgate "Obsidian Signal" 팔레트 — `src/theme.ts`의 Rust 미러(SSOT 대응).
//!
//! 목적: Node 원본이 쓰는 정밀 관제 콘솔 톤(깊은 옵시디언 캔버스 + 고대비
//! 시그널: 앰버·시안·틸에메랄드·바이올렛·골드)을 `ratatui` `Color::Rgb`로
//! 그대로 제공한다. 색상값·보간 규칙은 원본과 1:1이다.
//!
//! 외부 연결: `crate::canvas` 그리기 프리미티브와 `crate::view` 패널/와이어가
//! 이 상수들만 참조한다(하드코드된 `Color::Cyan` 등 자유 색상 금지).

use ratatui::style::Color;

/// `#rrggbb` 정수 → RGB (`src/theme.ts`의 `hex` 대응).
const fn hex(code: u32) -> Color {
    Color::Rgb(
        ((code >> 16) & 0xff) as u8,
        ((code >> 8) & 0xff) as u8,
        (code & 0xff) as u8,
    )
}

/// 두 색상의 선형 보간 — `lerpColor` 미러(t를 0..=1로 클램프, 채널별 반올림).
/// 비-RGB 색상이 섞이면 보간 없이 `b`를 반환한다(폴백 — 실사용은 항상 RGB).
pub fn lerp_color(a: Color, b: Color, t: f64) -> Color {
    let t = t.clamp(0.0, 1.0);
    fn lerp_ch(x: u8, y: u8, t: f64) -> u8 {
        (x as f64 + (y as f64 - x as f64) * t).round() as u8
    }
    match (a, b) {
        (Color::Rgb(ar, ag, ab), Color::Rgb(br, bg, bb)) => Color::Rgb(
            lerp_ch(ar, br, t),
            lerp_ch(ag, bg, t),
            lerp_ch(ab, bb, t),
        ),
        _ => b,
    }
}

pub const BG: Color = hex(0x0e1015);
pub const BG_CHROME: Color = hex(0x14171f);
pub const BG_ELEVATED: Color = hex(0x171b24);
pub const BG_MODAL: Color = hex(0x11141c);
pub const BG_GLOW_PURPLE: Color = hex(0x191626);
pub const BG_GLOW_NEON: Color = hex(0x1b1a14);
pub const BG_TRIGGER_ACTIVE: Color = hex(0x241f36);
pub const BG_INPUT_FOCUS: Color = hex(0x161e29);
pub const BG_GREEN_TRACK: Color = hex(0x152c26);
pub const BG_ORANGE_TRACK: Color = hex(0x2c1e16);
pub const BG_BLUE_TRACK: Color = hex(0x152534);
pub const BG_NEON_TRACK: Color = hex(0x282414);

pub const FG: Color = hex(0xedf0f5);
pub const FG_SOFT: Color = hex(0xb8c0ce);
pub const MUTED: Color = hex(0x7d8799);
pub const DIM: Color = hex(0x545d6e);
pub const CHROME_FG: Color = hex(0x6c768a);

pub const BORDER_HEADER: Color = hex(0x2c3342);
pub const BORDER_WIRE: Color = hex(0x384154);
pub const BORDER_ADVISORY_IDLE: Color = hex(0x3c3650);
pub const BORDER_ASIDE_DASH: Color = hex(0x332e44);
pub const BORDER_LOG: Color = hex(0x262c3a);
pub const BORDER_FOCUS_BOOST: Color = hex(0xf8fafc);

/// Lead · 리드 (Amber Signal)
pub const ORANGE: Color = hex(0xf59e0b);
/// Workers · 스웜 (Cyan-Sky Telemetry)
pub const BLUE: Color = hex(0x38bdf8);
/// Decision Gate · 분기 (Emerald-Teal Gate)
pub const GREEN: Color = hex(0x2dd4bf);
/// Advisor · 자문 (Electric Violet)
pub const PURPLE: Color = hex(0xc084fc);
/// Verifier · 교차 검증 (Precision Gold)
pub const NEON: Color = hex(0xfacc15);

pub const TRAFFIC_RED: Color = hex(0xfb7185);
pub const TRAFFIC_YELLOW: Color = hex(0xfbbf24);
pub const TRAFFIC_GREEN: Color = hex(0x34d399);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lerp_color_endpoints_and_clamp() {
        assert_eq!(lerp_color(ORANGE, NEON, 0.0), ORANGE);
        assert_eq!(lerp_color(ORANGE, NEON, 1.0), NEON);
        assert_eq!(lerp_color(ORANGE, NEON, -0.5), ORANGE);
        assert_eq!(lerp_color(ORANGE, NEON, 1.5), NEON);
        // 중간값 — 채널별 반올림 보간.
        let mid = lerp_color(Color::Rgb(0, 0, 0), Color::Rgb(10, 20, 30), 0.5);
        assert_eq!(mid, Color::Rgb(5, 10, 15));
    }
}
