//! dgate-tui: `ratatui` 기반 라이브 관측 대시보드 (Rust v2).
//!
//! 전체 모듈: `args`(CLI 파싱) · `state`(스냅숏 조립 — dgate-core `live_sync`·
//! `telemetry`·`db` 재사용) · `view`(ratatui 렌더 — TestBackend로 창 없이 테스트).

pub mod args;
pub mod state;
pub mod view;
