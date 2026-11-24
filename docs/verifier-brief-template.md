<!--
  검증자 브리프 템플릿(Change ①) — `dg dispatch --brief-file <path>` / `node ./scripts/dispatch.ts --brief-file <path>` 가 검증하는 표준 형식이다.
  규칙(TS `validateBriefFileBytes`·Rust `validate_brief_bytes` 동일):
    - `## Standards`·`## Spec`·`## Merge Danger` 헤딩 3종 필수(두 축 + 합류 위험)
    - `door: one-way|two-way` 행 1개 필수
    - `blast_radius: <비어있지 않은 값>` 필수(≤500자)
    - 파일 ≤64KB·유효한 UTF-8
  두 축 출처: mattpocock/skills `engineering/code-review` SKILL.md — Standards 축은 기술
  표준(문서화된 코딩 표준 + Fowler 냄새 베이스라인) 위반, Spec 축은 요구사항 누락/부분
  구현·범위 초과(scope creep)·구현됐지만 잘못된 경우를 각각 검토한다. 두 축을 분리
  보고해 한 축이 다른 축을 가리지 못하게 하는 것이 원본 스킬의 핵심 계약이다.
-->

# Verifier Brief — <fork_id>

<!--
  선택 헤더(`.herdr/roles/verifier.md` §3 입력 계약) — 실제 브리프 작성 시 채운다.
  파일명은 `.herdr/verify/<fork_id>-brief.md`를 권장한다.
-->

- fork_id: fk_000000000000
- 원래 요구사항: (원본 task·요구 문서 또는 임무파일 경로 — 리드가 위임한 그대로 인용)
- diff 경로: (검증 대상 diff 명령 — 예: `git diff <base>...HEAD` 또는 워크트리 경로)
- 검증 시점 HEAD: (선택 — `git rev-parse HEAD` 결과, 리드 `--expected-head` 결속용)
- 테스트 명령과 결과: (예: `node --test tests/…` → pass N/fail 0, `cargo test -p …` → OK)

## Standards

<!-- 두 축 ① 기술 표준 — 이 저장소가 문서화한 코딩 표준 위반과 Fowler 냄새 베이스라인
     (판단 보조) 대상을 기재한다. 문서화된 표준이 베이스라인보다 항상 우선한다.
     파일/헝크 단위로 근거(파일:행)를 붙인다. 위반 없으면 "위반 없음"으로 명시한다. -->

- (위반 또는 판단 보조 항목 — 근거: 파일:행)

## Spec

<!-- 두 축 ② 요구사항 충실도 — (a) 누락/부분 구현, (b) 범위 초과(scope creep),
     (c) 구현됐지만 잘못된 요구사항. 각 항목에 원본 요구사항 문장을 인용한다.
     충족 항목만 있으면 "충족"으로 명시한다. -->

- (요구사항 인용 → 실제 구현 대조 결과)

## Merge Danger

<!-- 합류 위험 표기(mattpocock/skills `pr` 어휘) — `door`·`blast_radius` 두 키는
     디스패처가 기계 검증한다. 아래 값을 실제 판정으로 바꿔 쓴다. -->

door: two-way
blast_radius: (변경이 틀렸을 때 깨질 수 있는 것 — 영향 반경 요약, 1~500자)
