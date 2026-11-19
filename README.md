# herdr-quad — 실측 통계 기반 멀티 에이전트 오케스트레이터

5개 역할 슬롯(lead·explore·coder·verifier·advisor)에 임의의 로컬 CLI 에이전트(`pi`·`agy`·`devin`·`claude`)를 바인딩해, **실측 통계 기반 Decision Gate**가 저비용 경로와 리드 승격 경로를 자동 분기하는 오케스트레이션 시스템이다. 핵심 목적:

- **비용·리드 턴 절감** — 통계적으로 안정된 조사 태스크는 Pre-Lead 라우터가 읽기전용 워커로 직행시켜 리드 LLM 턴을 0으로 만든다.
- **모델 가변성** — 어떤 모델을 어느 역할에 쓸지는 `roster.json` 설정 파일 하나로 교체한다. 코드 수정 불필요.
- **로컬 전체 프로젝트 공용** — `--repo <path>`로 이 머신의 어느 로컬 저장소에서든 같은 오케스트레이터를 실행한다.

결정 엔진은 SQLite(WAL) 위에 EWMA Beta 사후확률을 유지하고, **동일 조건 연속 오류 2회 시 강제 `split`**(리드 승격)으로 안전하게 폴백한다. 외부 npm 의존성은 0개 — Node.js 내장 모듈만으로 동작한다.

---

## 1. 아키텍처 요약 (Pre-Lead Gate + 5계층)

```text
                    ┌────────────────────────────────────────────┐
  태스크 입력 ─────▶ │ Layer 0 · Pre-Lead Router (dg, LLM 0턴)    │
                    │ sharp = 읽기전용 fast-path / split = 리드 승격 │
                    └───────────────┬────────────────────────────┘
              sharp (p≥0.7, 저위험)  │  split
                    ┌───────────────▼────────────────────────────┐
                    │ Layer 1 · Lead — 계획 수립·워커 브리프 발행    │
                    ├────────────────────────────────────────────┤
                    │ Layer 2 · Swarm — 읽기전용 탐색 + worktree    │
                    │            코딩 워커 (동시 최대 2)            │
                    ├────────────────────────────────────────────┤
                    │ Layer 3 · 독립 검증자 — 이종 모델·읽기전용.    │
                    │            [FAIL] → dg backprop → 재작업     │
                    ├────────────────────────────────────────────┤
                    │ Layer 4 · 온디맨드 자문 3관문 (계획/오류/완료) │
                    └────────────────────────────────────────────┘
```

- **Layer 0 (`dg` Pre-Lead Router)** — 태스크 종류 7종(`explore_read`·`code_search`·`single_edit` 등)별 사전확률과 실측 사후확률을 비교해 `sharp`(읽기전용 `pi` 워커 직행, 리드 턴 0) 또는 `split`(리드 승격)을 판정한다. LLM 호출 없이 순수 통계 판정이다.
- **Layer 1 (Lead)** — `split`된 태스크의 계획을 수립하고 Layer 2 워커 브리프를 발행한다. `HERDR_DB_WRITE=1`로 결정 통계를 기록한다.
- **Layer 2 (Swarm)** — 읽기전용 탐색 워커(동시 최대 4)와 `git worktree`에서 격리된 코딩 워커(동시 최대 2, 서로 다른 파일 영역)가 병렬 작업한다.
- **Layer 3 (독립 검증자)** — 리드와 이종 모델·읽기전용 권한으로 검증한다. 판정 SSOT는 구조화 verdict JSON(`.herdr/verify/<fork_id>-verdict.json`)이고, 리드가 `dg backprop --verdict-file`로 pass/rework/fail/human을 원본 fork에 fail-closed 반영한다(§5).
- **Layer 4 (자문 3관문)** — 계획·오류·완료 시점에만 온디맨드로 기동하는 자문 세션이다. 관문 통과 후 즉시 `hc kill; hc rm`으로 정리된다.

세션 관제·런치는 `hc`(Herdr 터미널 CLI) 위에서 동작한다. 모든 통계는 `~/.local/state/gemini-trick/decision.db`(SQLite)에 SSOT로 축적된다.

---

## 2. 요구사항 & 빠른 시작

### 요구사항

- **Node.js 22.6+** (`node:sqlite` 내장 모듈 필요 — 외부 npm 의존성 0개, `npm install` 불필요)
- 워커로 사용할 로컬 CLI 에이전트 중 최소 1종 (`pi` / `agy` / `devin` / `claude` — 없으면 `--dry-run` 계획 검증만 가능)
- (선택) `hc`·`herdr-app` — 세션 기동·4분할 관제 화면용

### 빠른 시작

```bash
git clone <this-repo> && cd <this-repo>

# 1) 오케스트레이션 계획 리허설 (모델 호출 0회, 실기동 0회 — 무조건 안전)
npm run orchestrate:dry

# 2) 전체 테스트 92건 (외부 의존성 0개)
npm test

# 3) 데모 TUI 스냅샷 (터미널에 관제 화면 정적 출력)
npm run snapshot

# 4) 4분할 데모 오케스트레이션 (Herdr App 필요)
npm run herdr:quad
```

---

## 3. 모델·구독 가변 설정 (`roster.json` & 환경변수)

역할↔모델 바인딩은 전부 외부 설정으로 분리돼 있다. **구독·쿼터·결제 상황이 바뀌면 설정 파일만 교체한다.**

### roster.json 탐색 우선순위

```text
--roster <path> 플래그  >  HERDR_ROSTER_PATH 환경변수  >  <repo>/.herdr/roster.json
>  ~/.config/herdr-quad/roster.json (전역 기본)  >  내장 기본값 (quota-saver)
```

### 설정 예시

[`.herdr/roster.example.json`](.herdr/roster.example.json)을 참고해 자신의 환경에 맞게 복사·편집한다:

```bash
mkdir -p ~/.config/herdr-quad
cp .herdr/roster.example.json ~/.config/herdr-quad/roster.json
# 이후 구독 변동 시 이 파일의 bin·provider·model·dailyTurnBudgets만 수정
```

```jsonc
{
  "defaultProfile": "quota-saver",
  "profiles": {
    "quota-saver": {
      "roles": {
        "lead":     { "cli": "pi", "provider": "opencodex", "model": "<lead-model>", "thinking": "max" },
        "explore":  { "cli": "pi", "provider": "opencodex", "model": "<cheap-model>", "thinking": "medium", "readonly": true },
        "verifier": { "cli": "pi", "provider": "opencodex", "model": "<verifier-model>", "thinking": "max", "readonly": true },
        "advisor":  { "cli": "agy", "model": "<advisor-model>", "readonly": true, "onDemand": true }
      }
    }
  }
}
```

- 미지정 필드는 내장 기본값을 상속한다(부분 오버라이드 허용).
- `bin`은 포터블한 명령 이름(`"pi"` 등)을 권장한다. 절대경로가 필요할 때만 명시.
- 실행 파일 해석 순서: `bin` 필드 → 환경변수 → `PATH` 탐색 → 관례적 설치 위치(`~/.bun/bin/pi`, `~/.local/bin/agy`).

### 환경변수

| 변수 | 용도 |
| :--- | :--- |
| `GEMINI_TRICK_DB_PATH` | 결정 엔진 SQLite DB 경로 (기본 `~/.local/state/gemini-trick/decision.db`) |
| `HERDR_ROSTER_PATH` | roster.json 경로 오버라이드 |
| `PI_BIN` / `HERDR_PI_BIN` | `pi` 실행 파일 경로 오버라이드 |
| `AGY_BIN` / `DEVIN_BIN` / `HC_BIN` / `CLAUDE_BIN` | 각 CLI 실행 파일 경로 오버라이드 |
| `HERDR_AGY_TURN_BUDGET` | agy 일일 턴 예산 (기본 20 — 초과 시 프로필 자동 강등) |
| `DECISION_API` / `GEMINI_DECISION_API_KEY` | TUI 라이브 모드 Gemini REST API 폴백용 |

> **API 키는 절대 이 저장소에 커밋하지 않는다.** 키 주입은 환경변수로만 하고, `.env*` 파일은 `.gitignore`로 차단돼 있다.

### 내장 프로필

| 프로필 | 구성 | 비고 |
| :--- | :--- | :--- |
| `quota-saver` (기본) | lead/verifier는 `pi`, advisor만 온디맨드 `agy` | agy 상시 세션 0 |
| `agy-quad` | lead·verifier·advisor 모두 `agy` 상시 | 일일 예산 초과 시 `quota-saver`로 자동 강등 |

---

## 4. 타 로컬 저장소 공용 실행 (`--repo`) & `dg` CLI

### 다른 저장소에서 실행

`dg.ts`·역할 계약서·roster는 오케스트레이터 루트 기준, 작업 cwd·worktree·project_id는 `--repo` 기준으로 해석된다. 어느 프로젝트에서든 동일하게 동작한다:

```bash
node ./scripts/herdr-quad-launch.ts --repo /path/to/your-project --mode orchestrate --dry-run
```

### `dg` 서브커맨드 (10종)

```bash
node ./src/decision/dg.ts <command> [flags]
```

| 명령 | 용도 |
| :--- | :--- |
| `route` | 태스크 종류별 `sharp`/`split` 라우팅 판정 (LLM 턴 0) |
| `gate` | 게이트 진입 시 사후확률·강제 조건 평가 |
| `close` | fork 종료 처리 (`--outcome ok\|fail\|rerouted`) |
| `touch` | fork TTL 갱신 (워커 하트비트) |
| `record` | 도구 사용 결과 표본 기록 (EWMA 입력) |
| `backprop` | 검증 `[FAIL]`을 원본 fork에 역전파 — 수동 또는 `--verdict-file` 구조화 판정 적용(fail-closed) |
| `retro` | fork 회고 마크다운(상태·원인·실패 도구·권고)을 다음 워커 브리프용으로 생성 |
| `settle-orphans` | TTL 만료 fork 일괄 정산 |
| `wrap` | 워커 커맨드 래핑 — 워치독 감시·산출물 계약·원자 커밋으로 SSOT 기록 (§5) |
| `compact` | 결정 DB 압축·통계 정리 |

---

## 5. 보안·격리 설계

- **fail-closed 읽기전용 가드** — `.agents/hooks.json` + `.agents/hooks/dg-hook.ts`가 `HERDR_READONLY=1` 워커의 도구 호출을 사전 차단한다. 개행·제어문자 주입, 위험 플래그(`--dangerously-skip-permissions` 등), 쓰기·위임 도구를 차단하고, 가드 자체 오류 시에도 차단(fail-closed)한다.
- **fail-open 수집** — `PostToolUse` 텔레메트리 수집은 본령이 아니므로 실패해도 워커를 막지 않는다(fail-open).
- **읽기전용 워커 도구 제한** — `pi` 워커는 `--tools read,grep,find,ls`로 기동되며 bash·편집 도구가 계약상 존재하지 않는다. 사용자 roster가 임의 `--tools`를 지정해도 `--exclude-tools edit,write`가 자동 부여된다.
- **세션명 충돌 방지** — 모든 `hc run --name`은 `^[a-z0-9_-]{1,32}$` 계약 + 런타임 6-hex 접미로 유일성을 보장하고, 기동 전 `hc ls` 충돌 점검을 수행한다.
- **dry-run 무오염** — `--dry-run`은 임시 `:memory:` DB에서 리허설해 사용자 결정 DB·파일 시스템을 건드리지 않는다.

### 실행 수명주기 & `dg wrap` 워치독

`dg wrap`이 워커 자식을 `detached` 프로세스 그룹으로 띄워 종료 코드·신호·출력 tail을 함께 수집하고, 결과를 `commitWrapOutcome` 단일 트랜잭션으로 SSOT에 기록한다(이중 표본·TOCTOU 차단). `--expected-gen`/`--expected-attempt` 펜스로 세대·시도 불일치의 stale 커밋을 거부하고, 디스패처는 `repo_scope` cooperative lease로 동일 저장소를 점유 중인 세션과의 중복 디스패치를 미룬다(점유자 생존·만료 시 탈취, 조회 실패는 fail-open). 주요 계약:

- **산출물·출력 계약** — `--require-artifact <path>`(파일 존재), `--require-nonempty`(크기 >0), `--require-stdout-nonempty`(비공백 stdout)를 clean exit(0) 시 AND 게이트로 검사한다. stdout 첫 비공백 줄이 `rerouted`면 워커의 리드 승격 신호 — 표본·실패 없이 `rerouted`로만 닫힌다.
- **워치독** — `--stall-ms`(기본 120s) 무출력 스톨 시 프로세스 그룹 전체 SIGTERM→SIGKILL kill + 리댁션된 20줄 tail 보존, `--max-ms`(기본 20분) 총 시간 상한. 출력 진전이 있을 때만 `dg touch` 하트비트(`--heartbeat-ms`, 기본 60s)로 fork TTL을 갱신한다.
- **`FailureCause` 11종** — `ok_pass`·`transient_network`·`tool_error`·`max_turns`·`no_result`·`artifact_missing`·`gate_fail`·`stall`·`timeout`·`config_error`·`interrupted`. 신호·종료코드 우선 분류라 문자열 휴리스틱 오탐을 막는다. `config_error`·`interrupted`는 EWMA·연속오류 카운터에서 격리돼 감사 로그만 남고, `ttl_orphan` 고아 정산은 w=1.0 실패 표본을 강제해 생존편향을 차단한다.

### Fail-Closed 구조화 Verdict & `dg retro`

- **`.herdr/verify/<fork_id>-verdict.json`** — 검증자가 남기는 SSOT 판정 문서(`schema_version: 1`). `decision`은 `pass|rework|fail|human` 4종, `findings[].severity`는 `P0|P1|P2|info`. `dg backprop --verdict-file <path> [--expected-head <sha>] [--max-reworks 2]`가 3중 불변식(스키마·fork_id/HEAD 결속·모순 판정)으로 검증해 fork에 반영한다 — `pass`는 fork→`ok`, `fail`은 역전파, `rework`는 재작업 카운트+w1.0 페널티, `human`/무효·누락·Stale·Replay는 전부 `exit 3` + `waiting_human` 파킹이다. pass에 P0/P1 finding이 있거나 fail/rework에 비공백 evidence가 없으면 모순으로 거부된다.
- **`dg retro --fork <id> [--out <path>]`** — fork의 상태·원인·시도·재작업 횟수·실패 도구 상위 5건·다음 시도 권고를 리댁션된 마크다운으로 생성해 다음 워커 브리프에 주입한다(opt-in — 자동 생성하지 않는다).

### 시크릿 3중 방어

- **헤더 전용 키 전달** — Gemini REST 폴백은 `x-goog-api-key` 헤더로만 키를 보낸다(`?key=` URL 쿼리 폐기 — URL·로그·프록시 기록에 키가 남지 않는다).
- **자식 env 최소 격리** — `buildSanitizedChildEnv`가 자식 워커 env에서 `*_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY` 계열을 제거하고 안전 키(`PATH`·`HOME`·`HERDR_*` 등)+명시 allow 목록만 통과시킨다. `dg wrap --sanitize-env --allow-env K1,K2`로 동일 격리를 래핑 자식에 적용한다.
- **전역 리댁션** — `redactSecrets`(무예외 순수 함수)가 런타임 env 실측값·URL 인코딩 형태와 패턴 세트(`Authorization`/`x-goog-api-key` 헤더, `?key=` 쿼리, Bearer, `AIza…`·`sk-…`·`ghp_…`·`AKIA…` 등)를 `<redacted>`로 치환한다. 로그·`error_snippet`·`command_line`·verdict/retro 출력 등 기록 경로 전체에 적용된다. `tests/redact-security.test.ts`의 키 모양 문자열은 리댁션 검증용 의도된 합성 더미다.

---

## 6. 기존 TUI 관제 화면

원본 프로젝트(`Gemini_trick`)의 5계층 관제 TUI가 그대로 포함돼 있다:

```bash
npm run demo          # 40초 데모 시나리오 (모델 호출 없음)
npm run live          # 실제 agy/Gemini API 연동 라이브 모드
npm run watch         # 실행 중인 agy 세션 트랜스크립트 실시간 관제
npm run snapshot      # 현재 상태 정적 스냅샷 출력
agy --output-format stream-json --print "…" | node ./src/cli.ts --stream   # JSONL 파이프 관제
```

주요 조작: `Tab` 패널 포커스 이동 · `Enter` 상세 모달 · `r` 응답 전문 · `s`/`n`/`c` 스웜·검증·자문 모달 · `/` 프롬프트 입력 · `?` 도움말. JSONL 스트림 프로토콜은 [examples/sample-session.jsonl](examples/sample-session.jsonl) 참고.

---

## 라이선스·크레딧

본 저장소는 로컬 멀티 에이전트 관제 TUI 프로젝트 `Gemini_trick`의 오케스트레이션 후속으로, Decision Gate·roster·읽기전용 격리 계약을 통합해 일반화했다.
