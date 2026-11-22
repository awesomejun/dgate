<!-- dgate:begin v=2026-11-22 — dg setup가 관리하는 블록. 직접 수정 말 것, 갱신은 `dg setup`. -->
## dgate 오케스트레이션 계약 (요약)

- **워커 실행**: `dg wrap --label <역할>-<주제> --fork <게이트발급>` 후 `hc run --bg`로 띄운다. `nohup`/`disown` 분리 금지, wrap 없는 직접 CLI 실행 금지(stall 감시·텔레메트리 누락).
- **배차**: strict dispatch 모드에서 delegate_swarm wrap은 `dg dispatch`/`dg route`가 발급한 `--fork`로만 실행된다(게이트 자동 판정 경유).
- **대기·보고**: 워커 대기는 `hc wait`(sleep·폴링 금지), 완료 보고는 `dg send $HC_TERMINAL_ID <내용>`(전달 확인·재전송 내장, 미확인 exit 1).
- **정리**: 끝난 워커 터미널은 즉시 `hc kill; hc rm` (또는 `dg reap` 일괄 정리).
- **자문 3관문**: ① 계획 확정 전(g1) ② 같은 오류 2회째(g2) ③ 최종 머지 전(g3) — `dg wrap --label advisor-g<N>-<주제>`로 자문 세션, 판정 마커 `[advisor:pass]` / `[advisor:challenge:<이유>]`, pass는 `.herdr/verify/advisor-pass*` 파일로 기록, 판정 후 즉시 정리. g3 pass 없이 머지 금지(리드 세션 생성 시 `HERDR_MERGE_GATE=1`이면 물리 차단).
- **검증 역귀속**: 독립 검증 판정은 `.herdr/verify/<fork_id>-verdict.json` + `dg backprop --verdict-file`로 원본 fork에 반영.
- **검증 pi 워커 격리**: `pi --no-session` 워커는 `PI_CODING_AGENT_DIR=~/.pi/agent-verify` 환경으로 실행(세션 의존 확장 충돌 회피).
- 전체 계약·설명: dgate 저장소 `skills/dgate/SKILL.md`.

<!-- dgate:end -->
