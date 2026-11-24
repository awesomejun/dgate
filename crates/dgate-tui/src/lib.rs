//! dgate-tui: `ratatui` 기반 라이브 관측 대시보드 (Rust v2).
//!
//! 전체 모듈: `args`(CLI 파싱) · `state`(스냅숏 조립 — dgate-core `live_sync`·
//! `telemetry`·`db` 재사용) · `theme`(Obsidian Signal 팔레트) · `layout`
//! (원본 2컬럼 토폴로지 배치 계산) · `canvas`(절대 좌표 그리기 프리미티브) ·
//! `view`(ratatui 렌더 — TestBackend로 창 없이 테스트).

pub mod args;
pub mod canvas;
pub mod layout;
pub mod state;
pub mod theme;
pub mod view;
