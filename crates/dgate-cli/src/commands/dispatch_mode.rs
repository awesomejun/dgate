//! `dg dispatch-mode [--set off|strict]` — strict dispatch 집행 장치 스위치.
//!
//! strict: `dg wrap --route delegate_swarm`은 `dg dispatch`가 발급한 `--fork`로만
//! 실행된다(미발급 fork·무fork는 exit 2 거부). 기본값 off(백워드 호환).
use serde_json::json;

use crate::args::{optional_flag, ParsedArgs};
use crate::util::prelude::*;
use dgate_core::engine;

pub fn cmd_dispatch_mode(args: &ParsedArgs, json: bool) -> CmdResult {
    match optional_flag(args, "set").as_deref() {
        None | Some("") => {
            let cur = engine::read_dispatch_mode();
            emit(
                json,
                format!("[dispatch-mode] {cur}"),
                &json!({ "dispatch_mode": cur }),
            );
        }
        Some(m) => {
            engine::write_dispatch_mode(m).map_err(DgError::Fatal)?;
            let cur = engine::read_dispatch_mode();
            emit(
                json,
                format!("[dispatch-mode] set → {cur}"),
                &json!({ "dispatch_mode": cur }),
            );
        }
    }
    Ok(0)
}
