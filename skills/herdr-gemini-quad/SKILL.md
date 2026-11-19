---
name: herdr-gemini-quad
description: "Herdr App 창을 4분할(2×2)로 자동 분할하여 Gemini 모델 4종(Argon, Carbon, Neon, Hydrogen)을 각 패널에 실행하고 실시간 오케스트레이션을 모니터링하는 스킬. 사용자가 Herdr 4분할, 멀티 모델 오케스트레이션, Carbon/Argon/Neon/Hydrogen 동시 관제를 요청할 때 사용한다."
---

# Herdr Gemini Quad Orchestrator

Herdr App의 현재 스페이스에 새 탭을 열고 창을 자동으로 **4분할(2×2 그리드)** 한 뒤, 각 패널에 Gemini 멀티 에이전트 4종을 배치해 **IPC 버스(`/tmp/herdr-gemini-quad-*.sock`)** 로 실시간 동기화·오케스트레이션하는 스킬입니다.

## 4분할 패널 배치 구조

```text
┌────────────────────────────────────┬────────────────────────────────────┐
│ ◈ [Top-Left] Argon (Lead / Hub)    │ ⬡ [Top-Right] Carbon (Advisor)     │
│ model: gemini-4-argon-high         │ model: gemini-4-carbon-high        │
│ - 전체 미션 계획 수립 & 빌드 제어  │ - 3대 트리거(계획/오류/완료) 감시  │
│ - Decision 1 분기 확률 매트릭스    │ - 아키텍처·보안 전략 자문 스트림   │
├────────────────────────────────────┼────────────────────────────────────┤
│ ✦ [Bottom-Left] Neon (Verifier)    │ ❖ [Bottom-Right] Hydrogen (Swarm)  │
│ model: gemini-4-neon-high          │ model: gemini-4-hydrogen-high      │
│ - 편향 없는 독립 교차 검증 게이지  │ - 50개 워커 동시성 매트릭스 그리드 │
│ - 회귀/계약/엣지케이스 감사 로그   │ - search/grep/audit 병렬 서브태스크│
└────────────────────────────────────┴────────────────────────────────────┘
```

## 실행 방법

### 1. 기본 4분할 오케스트레이션 실행 (동기화 데모 시나리오)
```bash
node /Users/user01/Desktop/Gemini_trick/scripts/herdr-quad-launch.ts --mode demo
```

### 2. 실제 Antigravity(`agy`) / Gemini API 라이브 오케스트레이션 실행
```bash
node /Users/user01/Desktop/Gemini_trick/scripts/herdr-quad-launch.ts --mode live --prompt "현재 저장소 구조를 분석하고 개선점을 제안해줘"
```

### 3. 현재 실행 중인 `agy` 세션 트랜스크립트 실시간 관제 연동
```bash
node /Users/user01/Desktop/Gemini_trick/scripts/herdr-quad-launch.ts --mode watch
```

### 주요 옵션
- `--folder <path>`: 작업 디렉터리 지정 (기본: `/Users/user01/Desktop/Gemini_trick`)
- `--name <title>`: 생성할 Herdr 탭 이름 지정
- `--prompt, -p <text>`: 시작과 동시에 Argon에 전달할 초기 프롬프트 (지정 시 자동 `--live` 전환)
- `--dry-run`: 실제 분할하지 않고 실행될 `herdr-app` 및 `hc` 명령어만 출력

## 실행 후 검증

런처 실행 후 아래 명령으로 4분할 상태와 화면을 확인할 수 있습니다:

```bash
herdr-app status
herdr-app shot /tmp/herdr-gemini-quad.png
```

## 프로젝트 내 npm 스크립트

`/Users/user01/Desktop/Gemini_trick` 디렉터리에서 다음 명령도 바로 사용할 수 있습니다:
- `npm run herdr:quad` (기본 4분할 데모 오케스트레이션)
- `npm run herdr:quad:live` (라이브 에이전트 연동)
- `npm run herdr:quad:watch` (실행 중인 세션 트랜스크립트 관제)
