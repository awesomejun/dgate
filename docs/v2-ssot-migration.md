# v2 단일 SSOT 전환 계획 — Node v1 동결 및 Rust v2 이관 로드맵

Rust v2(`crates/dgate-core`, `crates/dgate-cli`, `crates/dgate-gui`)를 dgate의 단일 SSOT(Single Source of Truth)로 삼는 전환 계획이다. Node v1 구현은 단계별로 동결·폐기하며, 각 단계는 `door`(되돌림 가능성)와 `blast_radius`(영향 범위)를 명시해 무중단으로 진행한다.

## S1 — 즉시 동결 대상

**대상**: `src/decision/` 12파일 + `scripts/dispatch.ts`

| 파일 | v2 대응 |
| --- | --- |
| `src/decision/dg.ts` | `crates/dgate-cli` (`dg` 바이너리) |
| `src/decision/engine.ts` | `dgate-core/src/engine.rs` |
| `src/decision/db.ts` | `dgate-core/src/db.rs` |
| `src/decision/verdict.ts` | `dgate-core/src/verdict.rs` |
| `src/decision/telemetry.ts` | `dgate-core/src/telemetry.rs` |
| `src/decision/roster.ts` | `dgate-core/src/roster.rs` |
| `src/decision/stats.ts` | `dgate-core/src/stats.rs` |
| `src/decision/checkpoint.ts` | `dgate-core/src/checkpoint.rs` |
| `src/decision/report.ts` | `dgate-core/src/report.rs` |
| `src/decision/adapter.ts` | `dgate-core/src/adapter.rs` |
| `src/decision/redact.ts` | `dgate-core/src/redact.rs` |
| `src/decision/suggestSublead.ts` | `dgate-core/src/suggest_sublead.rs` |
| `scripts/dispatch.ts` | `dgate-cli` `dispatch`·`dispatch-mode` 명령 |

**근거**: `crates/dgate-core`는 v1 엔진을 1:1 포팅했고, `dgate-cli`의 `COMMANDS[22]`(`route`·`gate`·`close`·`touch`·`record`·`backprop`·`attempt`·`retro`·`settle-orphans`·`wrap`·`compact`·`stats`·`checkpoint`·`worktree`·`report`·`hook`·`setup`·`dispatch`·`dispatch-mode`·`send`·`reap`·`suggest-sublead`)는 Node `dg.ts`의 15명령 상위집합이다. 동결 대상은 신규 기능·수정 금지 — 버그 수정도 v2에만 적용한다.

## 동결 보류 3축

v1이라도 아직 v2 대체가 없거나 과도기 안전망으로 필요한 축은 동결하지 않는다.

1. **`src/cli.ts` (TUI)** — 대시보드·워커 토폴로지 표시. S5에서 `crates/dgate-tui`로 이전 확정 전까지 유지한다.
2. **`.agents/hooks.json` + `.agents/hooks/dg-hook.ts`** — 에이전트 훅 가드·수집. S2에서 `dg hook` 네이티브 우선 + node 폴백(two-way)으로 전환하고, 폴백은 S5 완전 제거 전까지 안전망으로 유지한다.
3. **`scripts/setup.ts`·`scripts/install-global.ts`** — 온보딩 위저드·글로벌 설치. S3에서 `setup.rs` v2 설치·점검 정합을 맞추고, S7 패키징 단계에서 최종 정리한다.

## 단계별 이관 로드맵

| 단계 | 내용 | door | blast_radius |
| --- | --- | --- | --- |
| **S1 동결** | `src/decision/` 12파일 + `scripts/dispatch.ts` 동결 선언 | two-way | 동결 선언 문서만 — 코드 불변. 되돌리기는 선언 철회 |
| **S2 훅 v2 우선 전환** | `.agents/hooks.json`의 PreToolUse/PostToolUse를 `dg hook --guard\|--collect` 우선 + `node hooks/dg-hook.ts` 폴백 셸 한 줄로 전환 | two-way | `.agents/hooks.json`, 설치 템플릿(`setup.rs`·`setup.ts`의 canonical 복사본), 훅 스펙 검사·테스트. `dg` 미설치 환경은 node 폴백으로 기존과 동일 |
| **S3 설치 v2 전환** | `setup.rs`의 `install_repo_hooks`가 v2 우선 `hooks.json`을 배포하고, `check`가 네이티브 `dg` 존재 시 Node/node:sqlite 부재를 허용 | two-way | `crates/dgate-core/src/setup.rs`, `scripts/setup.ts`, setup/hook 테스트. Node 위저드도 canonical을 복사하므로 별도 템플릿 분기 없음 |
| **S5 TUI Rust 이전 확정** | `crates/dgate-tui`(`ratatui` + `crossterm` + `dgate-core`, 실행 바이너리명 `dgate-tui` 유지) 신설·이전 후 Node `src/cli.ts` TUI 제거 | one-way(제거 시점) / two-way(신설까지) | 신규 `crates/dgate-tui/*`, `Cargo.toml` members, `scripts/install-global.ts` 래퍼, `package.json`. Node TUI 제거 후 되돌리기는 git revert |
| **S6 테스트 정리** | v1 전용 Node 테스트(`tests/*.test.ts`) 중 v2로 이관·대체된 것 정리, 잔여는 v2 검증으로 재배정 | two-way | `tests/` 트리. 테스트 삭제만으로는 기능 회귀 없음, 커버리지 공백이 blast |
| **S7 패키징·래퍼 정리** | `package.json` bin(`dg`→`src/decision/dg.ts`)·npm 스크립트를 네이티브 바이너리 배포로 전환, `scripts/install-global.ts` 래퍼 정리 | two-way | `package.json`, `scripts/install-global.ts`, `bin/` 래퍼. npm 배포 형상 변경 — 릴리스 절차와 합의 필요 |
| **S8 문서 정합** | README·SKILL·가이드의 v1 참조(`node src/decision/dg.ts` 등)를 v2 명령으로 갱신 | two-way | `README.md`, `skills/dgate/`, `docs/`, `.herdr/roles/`. 문서만 |

### 진행 원칙

- 각 단계는 기존 테스트 회귀 0 — `npm test`와 `cargo test --workspace` 전수 통과를 유지한다.
- 과도기에는 two-way만 사용한다: 네이티브 바이너리 우선 + Node 폴백 유지. one-way 제거는 해당 축의 v2 대체가 검증된 뒤에만 수행한다.
- 단계별 변경은 `.herdr/briefs/` 브리프에 Standards/Spec/Merge Danger를 명시하고 이종 Verifier 검증 후 커밋한다.
