// 게이트웨이 공용 타입. 사양서 §4, §5

export type Tier = "self" | "open" | "external";

export interface ModelRow {
  model_id: string;
  provider: string;
  provider_model: string;
  tier: Tier;
  license: string;
  training_safe: boolean;
  input_krw_per_mtok: number;
  output_krw_per_mtok: number;
  pricing_verified_at: string | null;
  active: boolean;
}

export interface RoutingRule {
  task_type: string;
  current_target: Tier;
  explore_ratio: number;
}

/** training.gateway_config 를 타입화한 것. 값은 전부 DB 가 상한/하한을 강제한다. */
export interface GatewayConfig {
  self_model_max_ratio: number;
  explore_ratio_floor: number;
  external_long_context_threshold: number;
  route_unclassified_to_external: boolean;
  request_timeout_ms: number;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  rate_limit_per_min: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  session_id?: string;
  task_type?: string;
}

export interface ProviderCall {
  providerModel: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
}

export interface ProviderResult {
  output: string;
  /** 제공자가 보고한 실제 토큰 수. 없으면 null — 이 경우에만 추정치를 쓴다. */
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "GatewayError";
  }
}
