# Sublead 파이프라인 설계 — 결정적 상태머신(0토큰) + 단발 LLM 에스컬레이션

상태: 구현됨(2026-11-24, `crates/dgate-core/src/pipeline.rs` + `dg pipeline` CLI).
근거: `paperwork-runtime` Phase 2A–2E 실전 피드백 — 상주 sublead LLM이 60–90분 동안
`hc wait → exit 판독 → verifier 스폰 → verdict 판독 → rework/advisor-g3 → PR` 같은
기계적 상태 전이에 ~70%의 토큰을 쓰고, `--max-ms` 벽시계 타임아웃·고아 워커 위험도 컸다.

## 원칙

- **전이 계산은 결정적(0토큰), 판단은 단발 LLM.** 상주 sublead LLM 없이
  `dgate-core::pipeline`의 순수 함수 `advance_pipeline(state, event)`이 다음 액션을
  계산한다. sublead LLM은 라운드 시작(스카우팅+브리프)과 에스컬레이션 처리에만
  1~2턴 단발로 깨운다.
- **판정은 기존 모듈 재사용.** verdict 수신은 `verdict::validate_verdict_file`의
  `effective_decision`(fail-closed)를 그대로 쓰고, 이종 모델 검사는
  `verdict::normalize_model_family`를 쓴다 — 판정 로직 중복 구현 없음.
- **영속화는 DB가 아니라 JSON 상태 파일.** `.herdr/pipelines/<run_id>.json`
  (`schema_version: 1`) — decision.db 스키마 변경 없음.
- **게이트·머지 조율은 기존 위치 유지.** sublead 설계(docs/sublead-design.md)의
  fork 소유 스코핑·backprop 물리 검증·머지 금지 기본을 파이프라인이 재정의하지 않는다.

## 상태·전이

`PipelinePhase` 8종 — 종결(terminal) 위상은 `ready_pr`·`escalated`·`failed`다.

| 현재 위상 | 이벤트 | 다음 위상 | 액션 |
| --- | --- | --- | --- |
| `init` | `init`(dg pipeline init) | `coder_running` | `spawn_coder{attempt:0}` |
| `coder_running` / `rework_pending` | `coder_exited{exit 0}` | `verifier_running` | `spawn_verifier{fork_id, head_sha, verifier_model}` |
| `coder_running` / `rework_pending` | `coder_exited{exit≠0｜stalled}` | `rework_pending` (attempt<max 시) | `spawn_coder{attempt+1, feedback}` |
| 〃 | 〃 (attempt=max 소진) | `escalated` | `wake_sublead_escalation{reason}` |
| `verifier_running` | `verdict_received{pass}` | `advisor_g3_running` | `spawn_advisor_g3{fork_id, head_sha, verdict_path}` |
| `verifier_running` | `verdict_received{rework｜fail}` | `rework_pending` (attempt<max 시) | `backprop_and_respawn_coder{fork_id, verdict_path, attempt+1}` |
| 〃 | 〃 (소진) | `escalated` | `wake_sublead_escalation{reason}` |
| `verifier_running` | `verdict_received{human}` | `escalated` | `wake_sublead_escalation{reason}` |
| `advisor_g3_running` | `advisor_g3_result{pass, pr_number}` | `ready_pr` | `emit_ready_pr{pr_number, head_sha}` → `READY_PR=<num> HEAD=<sha> G3=PASS` |
| `advisor_g3_running` | `advisor_g3_result{pass, pr_number 없음}` | `escalated` | `wake_sublead_escalation{reason}` (프로토콜 위반) |
| `advisor_g3_running` | `advisor_g3_result{fail}` | `escalated` | `wake_sublead_escalation{reason}` |
| 종결 위상 | 임의 이벤트 | (불변) | `none` — 이력만 기록 |
| 그 외 위상-이벤트 불일치 | 임의 | `escalated` | `wake_sublead_escalation{reason}` (fail-closed) |

`failed` 위상은 예약된 종결 표기다 — 현재 전이 규칙은 생산하지 않는다(외부 강제
중단 표기용). `attempt`는 소비한 재작업 수(0 시작)이며 `max_reworks`(기본 2)까지
재스폰한다 — 첫 coder + 최대 2회 재작업 = 최대 3회 실행.

### 불변식(fail-closed)

- **이종 모델 불변식**: `coder_exited{0}` 처리 시 `normalize_model_family(coder)
  == normalize_model_family(verifier)`이면 `escalated` — 검증 독립성이 깨지는
  구성을 절대 통과시키지 않는다(미지정 모델 두 개도 동등 → fail-closed).
- **verdict fail-closed**: `--event verdict`는 `validate_verdict_file`로 실제
  verdict JSON을 검증하고 `effective_decision`만 사용한다 — 무효·stale·replay
  verdict는 `human`으로 폴백되어 즉시 에스컬레이션된다.
- **프로토콜 위반 fail-closed**: 위상-이벤트 불일치(예: `coder_running`에서 verdict
  수신), g3 pass인데 `pr_number` 없음 → 모두 `escalated`.
- **종결 불변**: `ready_pr`/`escalated`/`failed` 도착 이벤트는 위상을 바꾸지 않고
  이력에만 기록한다(멱등 — 중복 전달 안전).

## 0토큰 결정적 경계 vs 단발 LLM 에스컬레이션

| 결정적(dg pipeline, LLM 0턴) | 단발 LLM(sublead, 1~2턴) |
| --- | --- |
| coder exit → verifier 스폰 지시 | 라운드 시작: 도메인 스카우팅·태스크 분해·브리프 작성(door·blast_radius·Standards·Spec·Merge Danger) |
| verdict 수신 → pass: g3 스폰 / rework·fail: backprop+재스폰(예산 내) | 에스컬레이션 핸들러: 재시도 소진·human 판정·P0 구조 충돌·프로토콜 위반 |
| g3 결과 → READY_PR 신호 또는 에스컬레이션 | — |
| 스코프 경고(`--scope` 도메인 밖 경로 탐지) | — |

에스컬레이션 발생 조건(전부 `wake_sublead_escalation` 액션): ① coder 실패 또는
verdict rework/fail로 `max_reworks` 소진 ② `verdict=human`(무효 verdict의
fail-closed 폴백 포함) ③ advisor-g3 fail 또는 pass+pr_number 부재 ④ 이종 모델
불변식 위반 ⑤ 위상-이벤트 불일치.

## 상태 파일 — `.herdr/pipelines/<run_id>.json`

```json
{
  "schema_version": 1,
  "run_id": "fk_pipe1",
  "fork_id": "fk_pipe1",
  "brief_path": ".herdr/briefs/p1.md",
  "worktree_path": "/abs/wt",
  "branch": "feat/p1",
  "scope_glob": "crates/*",
  "phase": "verifier_running",
  "attempt": 0,
  "max_reworks": 2,
  "coder_model": "codex-gpt5",
  "verifier_model": "glm-5.3",
  "head_sha": "abc1234def",
  "last_verdict_path": ".herdr/verify/fk_pipe1-verdict.json",
  "history": [
    {"from": "init", "event": "init", "to": "coder_running", "action": "spawn_coder"}
  ]
}
```

`run_id` 미지정 시 `fork_id`와 동일. 저장은 tmp+rename 원자 교체. 로드 시
`schema_version != 1`은 오류로 거부한다.

## CLI — `dg pipeline`

```sh
# 초기화 — 상태 파일 생성 + 첫 액션(spawn_coder) 출력. --scope 위반은
# scope_warnings로 경고(비치명적 — 브리프/워크트리 등 선언 대상 경로 검사).
dg pipeline init --fork fk_1 --brief .herdr/briefs/p1.md --branch feat/p1 \
    --worktree /abs/wt --scope "crates/*" --max-reworks 2 \
    --coder-model codex-gpt5 --verifier-model glm-5.3 --json

# 전이 — 상태 파일 로드 → advance_pipeline → 저장 → next_action 출력.
# Escalated 도달 시 exit 3(verdict fail-closed와 같은 계약) — 러너는 이 코드로
# sublead 단발 기동을 트리거한다.
dg pipeline step --fork fk_1 --event coder-ok --head abc1234def --json
dg pipeline step --fork fk_1 --event coder-fail --stalled --json
dg pipeline step --fork fk_1 --event verdict --verdict-file .herdr/verify/fk_1-verdict.json --json
dg pipeline step --fork fk_1 --event g3-pass --pr 42 --json   # → ready_pr_signal: "READY_PR=42 HEAD=abc1234def G3=PASS"
dg pipeline step --fork fk_1 --event g3-fail --reason "P0 conflict" --json

# 조회(읽기 전용) — 위상·시도·전이 이력.
dg pipeline status --fork fk_1 --json
```

공용 `--state-dir <dir>`로 상태 디렉터리를 바꾼다(기본 `<cwd>/.herdr/pipelines`).
환경변수 폴백: `--coder-model`/`HERDR_CODER_MODEL`, `--verifier-model`/`HERDR_VERIFIER_MODEL`.
`--head` 미지정 시 verdict 결속은 상태 파일의 `head_sha`를 쓴다.

## 수용 기준

- `crates/dgate-core` 단위 테스트 8종: 정상 경로(READY_PR 신호 문자열), 재작업
  루프(attempt 소비 → 소진 에스컬레이션), 동종 모델 fail-closed, human/g3-fail/
  프로토콜 위반 에스컬레이션, 스코프 가드 in/out, 상태 파일 라운드트립.
- `crates/dgate-cli` E2E(test_09): `init → step(coder-ok/verdict/g3-pass) → status`
  라이프사이클 + 재작업 소진 exit 3 + 동종 모델 exit 3 + 사용법 오류 exit 2.
- `cargo test --workspace` 전수 통과 · `cargo clippy -p dgate-core -p dgate-cli`
  신규 경고 0건.
