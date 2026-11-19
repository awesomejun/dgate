/**
 * 선택적 `gemini-decision-1` API 어댑터 경계 (plan-r2.1 §4.8 — 추가 2).
 *
 * 목적: 향후 콜드스타트(`basis='prior'`) 앞단 분류에 외부 Decision 모델을 붙일 수 있는
 * 얇은 인터페이스만 확보한다. W1~W3 구현 범위는 `off`(기본) 로컬 EWMA Beta 완결이며
 * **외부 API 호출·네트워크 I/O는 일절 구현하지 않는다.**
 *
 * 외부 연결:
 * - `DECISION_API` 환경변수(`off`|`shadow`|`on`) 파싱 — 키(`GEMINI_DECISION_API_KEY`)
 *   미설정 시 `shadow`/`on` 요청도 `off`로 강등해 무키 환경 무비용 로컬 전용을 보장한다.
 *
 * 주의: `shadow`/`on` 실동작(병행 호출·우선 적용)은 명시적 사용자 승인 후 별도 단계에서
 * 구현한다. 현재 노옵 구현은 항상 `null`을 반환해 로컬 판정이 그대로 쓰이게 한다.
 */

export type DecisionApiMode = 'off' | 'shadow' | 'on';

export interface DecisionAdapterInput {
  projectId: string;
  route: 'file_select' | 'tool_select' | 'retry_or_abort' | 'delegate_swarm';
  toolClass: string;
  basis: 'prior' | 'measured';
  pLocal: number;
}

export interface DecisionAdapterResult {
  p: number;
  source: 'local' | 'api';
}

export interface DecisionAdapter {
  classify(input: DecisionAdapterInput): Promise<DecisionAdapterResult | null>;
}

/**
 * `DECISION_API` 파싱 + 무키 강등 규칙.
 * - 정상값이 아니면 `off`.
 * - `shadow`/`on`이어도 `GEMINI_DECISION_API_KEY` 부재 시 `off`.
 */
export function parseDecisionApiMode(env: Record<string, string | undefined> = process.env): DecisionApiMode {
  const raw = (env.DECISION_API ?? 'off').trim().toLowerCase();
  if (raw !== 'shadow' && raw !== 'on') return 'off';
  const key = env.GEMINI_DECISION_API_KEY;
  return key && key.trim() ? raw : 'off';
}

/** 노옵 로컬 구현 — 네트워크 I/O 없음, 항상 로컬 판정 유지(null 반환) */
export class NoopDecisionAdapter implements DecisionAdapter {
  async classify(_input: DecisionAdapterInput): Promise<DecisionAdapterResult | null> {
    return null;
  }
}

export function createDecisionAdapter(mode: DecisionApiMode = parseDecisionApiMode()): DecisionAdapter {
  // off(기본)를 포함해 현재 모든 모드에서 노옵 — 외부 호출 구현은 승인 후 별도 단계(§4.8)
  void mode;
  return new NoopDecisionAdapter();
}
