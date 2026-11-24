# Sublead 설계 — 조정 위임과 게이트 보존

상태: 승인됨(2026-11-24, 옵션 ③ + 현장 보정 3건 + 제안 엔진). 근거: paperwork 프로젝트 실측 —
리드 병목은 워커 실행(fork로 해결됨)이 아니라 **조정**(계획·브리프 작성·verdict 판독·재작업 분기)의
단일 턴 큐 직렬화와 다중 트랙 컨텍스트 혼합이었다.

## 원칙

- **fork는 작업 단위, sublead는 조정 단위다.** sublead에 새 게이트를 만들지 않는다.
  게이트(merge danger·`--after` 순서·검증 브리프)와 직렬 머지 조율은 최상위 리드에 유지한다.
- **단일 리드 불변식 유지**: parent 없는 세션만 lead. sublead는 parent를 가진 스코프 리드다.
- **판정 생산은 이종 verifier만. sublead는 배달(backprop)까지만.**

## 설계

1. **슬롯 신원** — 라이브 슬롯 6종(`lead|sublead|explore|coder|verifier|advisor`).
   `dg wrap --role sublead`·`HERDR_ROLE=sublead`. 이름 접두 `sublead-`/`sub-` 인정.
   coder 강등 로직(liveWorkerSync `lead-*` + parent → coder)은 그대로.
2. **fork 소유 스코핑** — 기존 `forks.conversation_id`로 sublead 소유 표시. sublead가 발급한
   dispatch fork는 자동으로 sublead conversation에 귀속. roster `ROLE_SLOTS`(5종)은 불변 —
   sublead는 라이브 슬롯·`dg wrap --role sublead`로만 표현하고 별도 roster 프로필을 두지 않는다(소유 귀속은 env·conversation_id로).
3. **손자 attribution** — sublead가 워커를 띄울 때 fork 컨텍스트(`HERDR_FORK_ID` 등) env 전파.
   wrap 텔레메트리·TUI 소유 매칭을 1단계 parent에서 **조상 탐색**으로 확장.
4. **TUI 그룹핑** — Workers 파티션을 소유 sublead별 클러스터로 렌더.
5. **backprop 권한(물리 검증)** — sublead 실행 시 두 검사를 통과해야만 반영:
   ① 대상 fork_id가 호출자 sublead의 conversation_id 하위,
   ② verdict 생산자(verifier fork/모델)가 coder/sublead와 이종.
6. **동시성 예산** — sublead는 coder 슬롯을 소모하지 않는다. 대신
   ① sublead 동시 상한(기본 2, 설정 2~4), ② **전체 트리 합산 active_coding 상한**(기존 값 유지)을
   dispatch/wrap 입구에서 집행. 근거: sublead 다수가 각자 워커를 띄우면 로컬 메모리 급증(실측 재부팅 사고).
7. **reap 스코핑** — `--role sublead` 컨텍스트의 `dg reap`은 자기 조상 트리(소유
   conversation_id) 하위 유휴 워커만 정리. 옆 sublead 워커는 건드리지 않는다.
8. **머지 금지 기본** — sublead 세션에는 `HERDR_MERGE_GATE`와 별개로 머지 금지가 기본.
   완료 신고는 READY_PR 핸드오프로만. strict 브랜치 보호에서 동시 머지·리베이스 경합을 구조적으로 차단.

## 제안 엔진 — `dg suggest-sublead`

sublead는 무조건 필요하지 않다. 리드가 다음 3축을 판단한 뒤 제안받는다. 모든 신호는
decision.db(`forks`·`decision_events`·fork 메타데이터)에서 읽는다(LLM 호출 0).

| 축 | 신호 | 비고 |
| --- | --- | --- |
| 리드 세션 부하 | 활성 fork 수, backprop/rework 빈도, fork당 verdict 처리 지연, 활성 wrap 워커 수 | 임계값 초과 지속 시 부하 경보 |
| 영역 분리 가능성 | 활성 fork들의 `repo_scope` 겹침 여부 | 겹침 없는 그룹 ≥2개여야 sublead 분리 이득 |
| task 범위 | task_kind 분포, brief/`blast_radius` 크기, fork generation/attempt | 대형·다영역일수록 sublead 가치 상승 |

출력: 판정 근거(3축 점수) + 제안 문구(sublead 수·영역 배치·예상 상한)를 stdout/JSON.
dgate 스킬 문서에 "리드가 병목을 체감할 때 호출" 가이드 추가.

## 수용 기준

- 기존 216 테스트 전수 통과 + 슬롯/스코핑/backprop 검증/reap 스코핑/예산 캡/제안 엔진 각 단위 테스트.
- Node v1 ↔ Rust v2 호환 검사 통과(양쪽 구현 일치).
- sublead 없는 기존 워크플로우 회귀 0(기본값 변경 없음 — sublead 명시 시에만 새 경로).

## 단계

1. 슬롯 신원(Node types.ts + Rust live_sync.rs, wrap 검증)
2. fork 스코핑·손자 attribution
3. 권한(backprop 물리 검증·reap 스코핑·머지 금지)
4. 동시성 예산 캡
5. 제안 엔진
6. 테스트·문서·v1/v2 호환
