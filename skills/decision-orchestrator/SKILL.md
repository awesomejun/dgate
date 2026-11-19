---
name: decision-orchestrator
description: Use when dispatching multi-CLI workers (pi/devin/agy via hc), running probability-gated sharp/split routing (dg route/dispatch), wrapping worker commands with stall watchdogs (dg wrap), safely removing git worktrees with sha256 checkpoints (dg worktree remove), or inspecting cost/timing/shadow-API telemetry (dg stats/report). Complements todo-flow, mistology, effort-router, and neverstuck without overlapping their roles.
---

# Decision Orchestrator — 실행·배차·안전 관제 레이어

로컬 SQLite WAL 통계(`EWMA Beta`) + 선택적 `gemini-decision-1` API + `herdr/hc` 멀티 CLI 워커 배차 엔진을 대화 중 일관되게 호출하기 위한 얇은 운영 스킬이다.

## 1. 기존 스킬과의 역할 경계 (중복 금지)

이 스킬은 **실행·배차·런타임 안전·통계 인프라**만 담당한다. 아래 4개 스킬과 역할을 섞지 않는다.

| 단계 | 담당 스킬 / 도구 | 이 레이어가 하는 일 |
|---|---|---|
| ① 요구사항·완료조건 | **`todo-flow`** (`todo`) | 할 일 트랙 문서, 중복 검사, Acceptance 조건 정의 |
| ② 과거 실수·결합 브리핑 | **`mistology`** | 착수 전 `mistology search -b`, 완료 전 `mistology impact`, 검증된 실수 `mistology new` / 표준 `canon` |
| ③ 티어·단계 계획 | **`effort-router`** | `S/M/L/XL/보안감사` 티어 판정, 계획→검토→구현→리뷰 단계, 증거번들(`state.json`) |
| ④ **멀티 CLI 배차·안전·통계** | **`decision-orchestrator`** (본 스킬) | **`sharp`/`split` 확률 게이트**, `roster.json` 기반 `hc` 워커(`pi`/`devin`/`agy`) 배차, `dg wrap` 감시, 체크포인트 삭제 게이트, `dg stats`/`report` |
| ⑤ 반복 막힘 탈출 | **`neverstuck`** | `forced_split`(연속 실패) 또는 3회+ 실패 시 원인 진단·가설·프롬프트 재설계 |

### `effort-router`와의 충돌 방지 규칙
- **티어·단계·리뷰 규범**은 `effort-router`를 따른다(본 스킬이 티어를 재판정하지 않는다).
- **외부 CLI 워커(`hc run` · `pi`/`devin`/`agy`) 배차, `sharp` 읽기전용 패스트패스, 워크트리 체크포인트, 런타임 실패율 통계**는 본 스킬(`dispatch.ts`/`dg.ts`)이 담당한다.
- `effort-router`의 `jev`와 본 스킬의 `gemini-decision-1`(`DECISION_API`)을 **같은 단계에서 이중 호출하지 않는다**: 단일 세션 단계 판단은 `effort-router`, `hc` 멀티워커 배차·통계 게이트는 `decision-orchestrator`를 쓴다.

---

## 2. 표준 실행 흐름 (5단계)

1. **착수 전 브리핑 (`mistology`)** — 코드 수정/디버깅 전, 해당 저장소에 `mistology`가 있으면 1회 조회:
   ```bash
   mistology search -b "<대상 파일·심볼·작업 의도>"
   ```
2. **작업 라우팅·배차 (`dispatch.ts` / `dg route`)** — 기본은 로컬 통계(`DECISION_API=off`, 0원). 비교 검증 시에만 `--decision-api shadow` 사용:
   ```bash
   # 리허설 (DB 미오염, 모델·API 호출 0회)
   node ~/Projects/Gemini_trick/scripts/herdr-quad-launch.ts \
     --mode orchestrate --repo <TARGET_REPO> --dry-run

   # 실제 디스패치 계획 + fork 발급 (shadow 옵션)
   node ~/Projects/Gemini_trick/scripts/dispatch.ts \
     --task-kind <explore_read|code_search|single_edit|multi_edit|test_or_deploy> \
     --repo <TARGET_REPO> [--decision-api shadow] [--context "<작업 요약>"] --json
   ```
   - `sharp`: 읽기전용 탐색 워커(`pi deepseek`, `--tools read,grep,find,ls --no-approve`)로 직행.
   - `split`: 격리 `git worktree` 코더(`devin`) + 다른 모델 계열 독립 검증자(`pi deepseek`/`glm-5.3`).
   - **하드 가드 불변**: `requires_write=true`, `forced_split=true`, `--risk medium|high`는 API 응답으로 절대 우회할 수 없다.
3. **워커 감시 실행 (`dg wrap`)** — 워커 명령을 `dg wrap`으로 감싸 멈춤(`--stall-ms`)·하트비트·산출물·통계를 자동 기록:
   ```bash
   node ~/Projects/Gemini_trick/src/decision/dg.ts wrap \
     --route <file_select|tool_select|retry_or_abort|delegate_swarm> \
     --tool-class <file_read|code_search|file_edit|shell_exec|swarm_dispatch> \
     --fork <FORK_ID> --project <TARGET_REPO> --require-stdout-nonempty -- <CMD...>
   ```
4. **검증·체크포인트·정리**:
   - 구조화 판정 반영(검증 실패/HEAD 불일치 시 `exit 3` 차단): `dg backprop --fork <FORK_ID> --verdict-file <PATH> --expected-head <SHA>`
   - 워크트리 삭제 전 체크포인트 강제(실패 시 `exit 4`·워크트리 보존): `dg worktree remove --worktree <PATH> --fork <FORK_ID>`
   - 커밋 전 결합 모듈 점검: `mistology impact`
5. **피드백 루프 (`dg report` → `mistology` / `neverstuck`)**:
   - `forced_split: true` 또는 연속 실패 발생 시: `dg retro --fork <FORK_ID>`로 실패 요약 생성 → 3회+ 반복이면 **`neverstuck`** 프로토콜로 전환.
   - 주기적 회고: `dg report --project <TARGET_REPO>`에서 반복 실패 후보(`tool_repetition`, `failure_causes`)를 확인하고, **실제 원인과 수정이 검증된 건만** `mistology new` / `mistology canon`으로 승격.

---

## 3. 시각 모니터링 및 점검 명령

- **실시간 TUI 대시보드**:
  - 백그라운드 모니터 세션 접속: `hc attach dg-monitor` (나오기: `Ctrl+\`)
  - 직접 실행: `node ~/Projects/Gemini_trick/src/cli.ts --watch-db ~/.local/state/gemini-trick/decision.db --watch`
- **비용·타이밍 통계 (읽기전용)**:
  ```bash
  node ~/Projects/Gemini_trick/src/decision/dg.ts stats --cost --timing [--project <TARGET_REPO>]
  ```
- **규칙 후보 + Decision API Shadow 비교 리포트 (읽기전용)**:
  ```bash
  node ~/Projects/Gemini_trick/src/decision/dg.ts report [--project <TARGET_REPO>]
  ```
- **실행 중 워커 목록**: `hc ls`

---

## 4. 안전·보안 가드레일

- **키 관리**: `GEMINI_DECISION_API_KEY`는 `~/.config/herdr-quad/secrets.env`(`chmod 600`, `~/.zshrc` 자동 로드)에서만 읽는다. 저장소 내 커밋·출력 금지.
- **기본 무과금**: `DECISION_API` 기본값은 `off`. `on` 모드 전환이나 실 유료 워커 대량 투입, `git commit`/`push`는 사용자 승인 후 실행한다.
- **`agy` 쿼터 절약**: 전역 `~/.config/herdr-quad/roster.json` 기본 프로필(`quota-saver`, 상시 `agy` 0턴)을 유지한다.
