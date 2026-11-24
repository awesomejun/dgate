---
name: herdr-gemini-quad
description: "(제거됨) Node v1 전용 4분할 오케스트레이터 — v2 SSOT 전환(S5)으로 기반 구현이 삭제되어 더 이상 실행할 수 없다."
---

# Herdr Gemini Quad Orchestrator — 제거됨 (v1 전용)

이 스킬이 다루던 4분할(2×2) Gemini 쿼드 오케스트레이션은 **Node v1 전용 기능**이었다.
`docs/v2-ssot-migration.md`의 S5 단계에서 기반 구현이 전부 제거됐다:

- `scripts/herdr-quad-launch.ts` — 런처 스크립트 (삭제)
- `src/ipc/quadBus.ts` — IPC 버스(`/tmp/herdr-gemini-quad-*.sock`) (삭제)
- `src/cli.ts --watch` — 트랜스크립트 관제 파이프 (삭제)
- `npm run herdr:quad*` — package.json 스크립트 (제거)

Rust v2에는 동등한 쿼드 런처가 아직 이관되지 않았다. 현재 제공되는 관측·오케스트레이션
경로는 `dg dispatch`/`dg wrap`(워커 배차·감시)과 `dgate-tui`/`dgate-gui`(관측 대시보드)다 —
자세한 사용법은 `skills/dgate/SKILL.md`를 참조한다.
