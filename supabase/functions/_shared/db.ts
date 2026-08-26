import type { ApiKeyRow, GatewayConfig, ModelRow, RoutingRule, Tier } from "./types.ts";

export interface InsertRequestArgs {
  userId: string;
  sessionId: string | null;
  apiKeyId: string;
  rawInput: string;
  inputTokens: number;
  taskType: string;
}

export interface FinalizeRequestArgs {
  requestId: string;
  routedTo: Tier;
  modelId: string;
  latencyMs: number;
  inputTokens: number;
  explored: boolean;
  routingReason: string;
  fallbackFrom: Tier | null;
  status: "ok" | "error";
  errorCode: string | null;
}

export interface InsertResponseArgs {
  requestId: string;
  output: string;
  outputTokens: number;
  modelId: string;
  costKrw: number;
  isShadow: boolean;
  finishReason: string | null;
  /** true 면 training.responses, false 면 reference.responses. */
  trainingSafe: boolean;
}

/**
 * 게이트웨이가 DB 에 하는 일 전부. 구현을 갈아끼울 수 있게 인터페이스로 둔다
 * (테스트는 인메모리 가짜 구현을 쓴다).
 */
export interface GatewayDb {
  findApiKey(hash: string): Promise<ApiKeyRow | null>;
  loadConfig(): Promise<GatewayConfig>;
  loadModels(): Promise<ModelRow[]>;
  loadRule(taskType: string): Promise<RoutingRule | null>;
  selfTrafficRatio(): Promise<number>;
  insertRequest(args: InsertRequestArgs): Promise<string>;
  finalizeRequest(args: FinalizeRequestArgs): Promise<void>;
  insertResponse(args: InsertResponseArgs): Promise<string>;
  insertFeedback(responseId: string, rating: number, correctedText: string | null): Promise<void>;
  touchApiKey(id: string): Promise<void>;
  close(): Promise<void>;
}

const CONFIG_DEFAULTS: GatewayConfig = {
  self_model_max_ratio: 0.75,
  explore_ratio_floor: 0.05,
  external_long_context_threshold: 8000,
  route_unclassified_to_external: false,
  request_timeout_ms: 60_000,
};

/** 원시 key/value 행을 타입화된 설정으로. DB 가 상한을 강제하지만 코드에서도 클램프한다. */
export function toGatewayConfig(rows: { key: string; value: number | string }[]): GatewayConfig {
  const map = new Map(rows.map((r) => [r.key, Number(r.value)]));
  const pick = (k: keyof GatewayConfig, fallback: number) => {
    const v = map.get(k);
    return v === undefined || Number.isNaN(v) ? fallback : v;
  };

  return {
    // §5-3 자체 모델 비중 상한 75% — DB CHECK 와 코드에서 이중 고정.
    self_model_max_ratio: Math.min(0.75, Math.max(0, pick("self_model_max_ratio", 0.75))),
    // §5-3 탐색 비율 하한 5%.
    explore_ratio_floor: Math.min(1, Math.max(0.05, pick("explore_ratio_floor", 0.05))),
    external_long_context_threshold: pick("external_long_context_threshold", 8000),
    route_unclassified_to_external: pick("route_unclassified_to_external", 0) >= 1,
    request_timeout_ms: pick("request_timeout_ms", CONFIG_DEFAULTS.request_timeout_ms),
  };
}

export { CONFIG_DEFAULTS };
