import type { ModelRow } from "./types.ts";

export interface CostBreakdown {
  costKrw: number;
  /** 단가가 실측 확인되지 않은 모델이면 true — §11 예산 감시가 이 값을 신뢰하면 안 된다. */
  estimated: boolean;
}

/**
 * 사양서 §11. 단가는 training.models 에 원(KRW)/100만 토큰 단위로 저장한다.
 * pricing_verified_at 이 null 이면 단가가 0 이거나 추측값이므로 estimated=true 로
 * 표시해 ops.metric_unverified_models 와 짝을 이룬다.
 */
export function computeCost(
  model: ModelRow,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const cost = (inputTokens / 1_000_000) * Number(model.input_krw_per_mtok) +
    (outputTokens / 1_000_000) * Number(model.output_krw_per_mtok);

  return {
    costKrw: Math.max(0, Number(cost.toFixed(4))),
    estimated: model.pricing_verified_at === null,
  };
}
