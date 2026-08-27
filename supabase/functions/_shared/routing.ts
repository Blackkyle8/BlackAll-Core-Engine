import type { GatewayConfig, ModelRow, RoutingRule, Tier } from "./types.ts";

export interface RoutingInput {
  taskType: string;
  inputTokens: number;
  rule: RoutingRule | null;
  config: GatewayConfig;
  /** 최근 구간 자체 모델 트래픽 비중 (training.self_traffic_ratio) */
  selfTrafficRatio: number;
  /** 자체 모델 엔드포인트가 실제로 설정되어 있는가 */
  selfModelAvailable: boolean;
  /** 0..1. 테스트 가능하도록 주입한다. */
  random: number;
}

export interface RoutingDecision {
  tier: Tier;
  explored: boolean;
  reason: RoutingReason;
}

export type RoutingReason =
  | "long_context"
  | "explore"
  | "unclassified"
  | "rule_self"
  | "rule_external"
  | "self_ratio_cap"
  | "self_unavailable"
  | "default_open";

/**
 * 사양서 §5-1 3~4단계, §5-2 라우팅 규칙, §5-3 비중 상한.
 *
 * 판정 순서 (앞선 규칙이 이긴다):
 *   1. 입력 토큰 > 임계값        → external   (긴 컨텍스트, §5-2)
 *   2. 탐색 비율 당첨            → external   (§5-1 4단계, explored=true)
 *   3. unclassified + 스위치 ON  → external   (§5-2. 3주차 분류기 도입 전까지 스위치는 OFF)
 *   4. 규칙이 self               → self, 단 §5-3 상한 미만이고 엔드포인트가 있을 때만
 *   5. 규칙이 external           → external
 *   6. 그 외                     → open       (§5-2 "그 외: 오픈모델 기본")
 *
 * 순수 함수다. DB·네트워크·시계·난수에 의존하지 않는다.
 */
export function decideRoute(input: RoutingInput): RoutingDecision {
  const { config, rule } = input;

  if (input.inputTokens > config.external_long_context_threshold) {
    return { tier: "external", explored: false, reason: "long_context" };
  }

  // 탐색 비율은 규칙값과 전역 하한 중 큰 쪽. §5-3 "탐색 비율 하한 5%".
  const exploreRatio = Math.max(
    rule?.explore_ratio ?? config.explore_ratio_floor,
    config.explore_ratio_floor,
  );
  if (input.random < exploreRatio) {
    return { tier: "external", explored: true, reason: "explore" };
  }

  if (input.taskType === "unclassified" && config.route_unclassified_to_external) {
    return { tier: "external", explored: false, reason: "unclassified" };
  }

  if (rule?.current_target === "self") {
    if (!input.selfModelAvailable) {
      return { tier: "open", explored: false, reason: "self_unavailable" };
    }
    if (input.selfTrafficRatio >= config.self_model_max_ratio) {
      // §5-3: 100% 가 되면 신규 유형 학습 원천이 소멸하고 자기 출력 재학습으로 품질이 열화된다.
      return { tier: "open", explored: false, reason: "self_ratio_cap" };
    }
    return { tier: "self", explored: false, reason: "rule_self" };
  }

  if (rule?.current_target === "external") {
    return { tier: "external", explored: false, reason: "rule_external" };
  }

  return { tier: "open", explored: false, reason: "default_open" };
}

/**
 * 제공자 호출 실패 시의 강등 경로. self → open → external → 포기.
 * 외부가 실패하면 더 갈 곳이 없다.
 */
export function fallbackTier(tier: Tier): Tier | null {
  if (tier === "self") return "open";
  if (tier === "open") return "external";
  return null;
}

export interface ModelSelection {
  model: ModelRow;
  tier: Tier;
}

/**
 * 계층 → 실제 모델. 환경변수로 고정된 기본 모델이 있으면 그것을 쓰고,
 * 없으면 해당 계층에서 활성화된 첫 모델을 쓴다.
 */
export function selectModel(
  models: ModelRow[],
  tier: Tier,
  preferredId?: string,
): ModelRow | null {
  const active = models.filter((m) => m.active && m.tier === tier);
  if (preferredId) {
    const hit = active.find((m) => m.model_id === preferredId);
    if (hit) return hit;
  }
  return active[0] ?? null;
}
