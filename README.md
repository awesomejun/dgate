# Gemini CLI Subagent TUI

[gemini_sub_neon.html](file:///Users/user01/Desktop/Gemini_trick/gemini_sub_neon.html)의 5계층 멀티 에이전트 오케스트레이션 화면(`Argon` · `Decision 1` · `Hydrogen` · `Gemini Neon` · `Carbon`)을 실제 터미널에서 실행·조작·스트림 연동할 수 있도록 구현한 TypeScript 기반 TUI 애플리케이션입니다.

외부 패키지 설치(`npm install`) 없이 **Node.js (v22.6+)** 또는 **Bun**으로 즉시 실행됩니다.

---

## 1. 빠른 실행

```bash
# 1) 실제 Antigravity(agy) / Gemini API 백엔드 연결 실행 (대화형 라이브 모드)
npm run live
# 또는
node ./src/cli.ts --live
node ./src/cli.ts --live --model gemini-4-argon-high --prompt "현재 저장소 구조를 요약해줘"
node ./src/cli.ts --live --model gemini-4-neon-high --prompt "변경 사항 회귀 여부를 검토해줘"

# 2) 실행 중인 agy 세션 트랜스크립트 실시간 관제 모드 (최신 transcript.jsonl 자동 감지 및 추적)
npm run watch
# 또는
node ./src/cli.ts --watch
node ./src/cli.ts --watch /path/to/transcript.jsonl

# 3) 기본 인터랙티브 데모 모드 실행 (gemini_sub_neon.html 40초 24비트 시나리오 재현)
npm run demo
# 또는
node ./src/cli.ts --demo

# 4) 실시간 JSONL / agy stream-json 이벤트 파이프 연동 실행
npm run stream:live
# 또는
agy --output-format stream-json --model gemini-4-argon-high --print="README 요약" | node ./src/cli.ts --stream

# 5) 로컬 JSONL 세션 파일 로드 (--follow 로 실시간 추가 추적 가능)
node ./src/cli.ts --file ./examples/sample-session.jsonl --replay-ms 500
node ./src/cli.ts --file ./examples/sample-session.jsonl --follow
```

---

## 2. 단축키 및 프롬프트 명령어

### 기본 관제 모드 단축키
| 단축키 | 기능 설명 |
| :--- | :--- |
| `Tab` / `Shift+Tab` | 패널 간 포커스 이동 (`Carbon` → `Argon` → `Neon` → `Decision 1` → `Hydrogen` → `세션 기록`) |
| `Enter` | 포커스된 패널의 상세 드릴다운 모달 열기 (`Argon`에서는 프롬프트 입력 진입) |
| `r` | 실제 에이전트가 생성한 **응답 전문 모달** 열기 (`↑`/`↓` 스크롤 지원) |
| `s` / `n` / `c` / `d` / `l` | 스웜 50슬롯(`s`), **Gemini Neon 교차 검증(`n`)**, Carbon 자문(`c`), 분기 상세(`d`), 전체 로그(`l`) 모달 바로가기 |
| `1` `2` `3` `4` `5` / `0` | 세션 기록 에이전트별 필터 토글 (`1`:Argon, `2`:Hydrogen, `3`:Decision, `4`:Neon, `5`:Carbon, `0`:해제) |
| `↑` / `↓` | 세션 기록 스크롤 |
| `Space` / `←` `→` | 데모 일시정지·재생 및 타임라인 `±2초` 탐색 |
| `/` 또는 `i` | 하단 `~/app $ gemini █` 프롬프트 입력 모드 진입 (`Esc`로 복귀) |
| `?` 또는 `h` | 인앱 도움말 모달 열기 |
| `q` / `Ctrl+C` | 종료 |

### 프롬프트 슬래시 명령어
- 일반 텍스트 입력 후 `Enter`: (`--live`) 실제 에이전트(`agy` 또는 `GEMINI_API_KEY`) 호출 및 도구 실행
- `/model <name>`: 실행 모델 변경 (예: `/model gemini-4-argon-high`, `/model gemini-4-neon-high`, `/model gemini-4-hydrogen-high`)
- `/effort <low|medium|high|max>`: Argon의 추론 강도 게이지(`▮▮▮▮`) 변경
- `/neon [검증 대상]`: (`--live`) **Gemini Neon**(`gemini-4-neon-high`) 독립 교차 검증 요청 / (`--demo`) 교차 검증 트리거 및 상세 모달 열기
- `/carbon <질문>`: (`--live`) Carbon 자문 모델(`gemini-4-carbon-high`)에게 별도 조언 요청
- `/new` / `/cancel`: (`--live`) 새 대화 세션 시작 또는 실행 중인 턴(Argon·Carbon·Neon) 중단
- `/response`, `/swarm`, `/neon`, `/advisor`, `/decision`, `/logs`, `/help`: 각 상세 모달 열기
- `/trigger <0|1|2>`, `/seek <0~40>`, `/filter <all|argon|hydrogen|decision|neon|carbon>`, `/pause`, `/play`, `/clear`, `/quit`

---

## 3. JSONL 실시간 스트림 프로토콜 (`--stream` / `--file`)

외부 에이전트 프로세스에서 한 줄당 하나의 JSON 객체를 표준 출력으로 내보내고 파이프(`|`)로 연결하면 실시간 관제 대시보드로 동작합니다. ([examples/sample-session.jsonl](file:///Users/user01/Desktop/Gemini_trick/examples/sample-session.jsonl) 참고)

```json
{"type":"session","sessionId":204,"cwd":"~/app","model":"argon","effort":"high"}
{"type":"phase","phase":"계획 확정","summary":"코드를 수정하고 테스트를 실행","argonBuilds":1}
{"type":"neon","state":"run","progress":64,"label":"계획 교차 검토","model":"gemini-neon"}
{"type":"neon","state":"pass","progress":100,"label":"계획 교차 검토","verified":1,"summary":"계획 교차 검토 완료 — 영향 범위 누락 없음"}
{"type":"decision","forks":1420,"routes":[{"name":"어느 파일","p":0.89},{"name":"어느 도구","p":0.58},{"name":"재시도 또는 중단","p":0.84}]}
{"type":"swarm","active":42,"max":50,"cards":[{"name":"search","progress":75,"description":"저장소 구조를 파악합니다","status":"running"}]}
{"type":"advisor","trigger":0,"calls":2,"tokens":"184k","advice":"인증·DB/트랜잭션 호출을 계획에서 제외"}
{"type":"log","time":"23:48:24","agent":"Neon","color":"neon","message":"계획 교차 검토 완료 — 영향 범위 누락 없음"}
```

---

## 4. 프로젝트 구조

- [src/backend/agentRunner.ts](file:///Users/user01/Desktop/Gemini_trick/src/backend/agentRunner.ts): `agy` CLI 멀티-에이전트 런타임(Argon·Carbon·Gemini Neon) & `GEMINI_API_KEY` REST API 폴백 에이전트 루프
- [src/backend/transcriptMapper.ts](file:///Users/user01/Desktop/Gemini_trick/src/backend/transcriptMapper.ts): Antigravity / Gemini 활성 세션 트랜스크립트(`transcript.jsonl`) 자동 감지 및 5계층 TUI 실시간 매핑기
- [src/backend/agyStreamMapper.ts](file:///Users/user01/Desktop/Gemini_trick/src/backend/agyStreamMapper.ts): `agy --output-format stream-json` NDJSON 이벤트 → 5계층 TUI 실시간 매핑기
- [src/cli.ts](file:///Users/user01/Desktop/Gemini_trick/src/cli.ts): CLI 엔트리포인트, 키보드/리사이즈 이벤트 루프, 스냅샷 출력기
- [src/theme.ts](file:///Users/user01/Desktop/Gemini_trick/src/theme.ts): `gemini_sub_neon.html` 1:1 매칭 24-bit TrueColor 팔레트
- [src/core/width.ts](file:///Users/user01/Desktop/Gemini_trick/src/core/width.ts): 한글(CJK) 전각 2셀 폭 계산 및 어절 단위 줄바꿈 엔진
- [src/core/buffer.ts](file:///Users/user01/Desktop/Gemini_trick/src/core/buffer.ts): 2D 셀 버퍼, 1/8 정밀 프로그레스 바, 와이어 펄스, Zero-Flicker Diff ANSI 렌더러
- [src/core/terminal.ts](file:///Users/user01/Desktop/Gemini_trick/src/core/terminal.ts): Alternate Screen 제어 및 UTF-8 키 이벤트 파서
- [src/state/demoEngine.ts](file:///Users/user01/Desktop/Gemini_trick/src/state/demoEngine.ts): 원본 40초 24비트 시나리오 수식 및 슬래시 커맨드(`/neon`, `/carbon` 등) 처리기
- [src/state/streamAdapter.ts](file:///Users/user01/Desktop/Gemini_trick/src/state/streamAdapter.ts): `stdin` 파이프 및 JSONL 파일(`--follow`) 실시간 스트림 어댑터
- [src/ui/layout.ts](file:///Users/user01/Desktop/Gemini_trick/src/ui/layout.ts): Wide / Standard / Compact 반응형 좌표, Argon-Neon 수평 링크 및 Carbon 트리거 앵커링 계산기
- [src/ui/renderApp.ts](file:///Users/user01/Desktop/Gemini_trick/src/ui/renderApp.ts): 전체 화면, Gemini Neon 교차 검증 패널 및 와이어 토폴로지 컴포지터
- [src/ui/renderModal.ts](file:///Users/user01/Desktop/Gemini_trick/src/ui/renderModal.ts): 50개 스웜 매트릭스, Gemini Neon 교차 검증 인스펙터 및 상세 드릴다운 오버레이 모달
- [src/ui/renderQuadRole.ts](file:///Users/user01/Desktop/Gemini_trick/src/ui/renderQuadRole.ts): Herdr 4분할 전용 역할별(Argon · Carbon · Neon · Hydrogen) 독립 대시보드 렌더러
- [src/ipc/quadBus.ts](file:///Users/user01/Desktop/Gemini_trick/src/ipc/quadBus.ts): Unix Domain Socket 기반 4개 패널 실시간 상태 동기화 IPC 버스
- [scripts/herdr-quad-launch.ts](file:///Users/user01/Desktop/Gemini_trick/scripts/herdr-quad-launch.ts): Herdr App 자동 4분할 및 에이전트 오케스트레이션 런처

---

## 5. Herdr App 4분할 오케스트레이션 (`herdr-gemini-quad` 스킬)

Herdr App에서 새 탭을 만들고 자동으로 2×2 4분할 창을 구성하여 **Argon**, **Carbon**, **Neon**, **Hydrogen** 모델이 동시에 동작·협업하는 모습을 모니터링할 수 있습니다.

```bash
# 1) 동기화 데모 오케스트레이션 (4분할)
npm run herdr:quad

# 2) 실제 Antigravity(agy) / Gemini API 연동 라이브 오케스트레이션
npm run herdr:quad:live -- --prompt "현재 프로젝트 구조를 점검해줘"

# 3) 현재 실행 중인 agy 세션 트랜스크립트 4분할 실시간 관제
npm run herdr:quad:watch
```

- 글로벌 스킬 설치 경로: [SKILL.md](file:///Users/user01/.gemini/config/skills/herdr-gemini-quad/SKILL.md)
