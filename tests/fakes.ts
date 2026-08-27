import type {
  FinalizeRequestArgs,
  GatewayDb,
  InsertRequestArgs,
  InsertResponseArgs,
} from "../supabase/functions/_shared/db.ts";
import type {
  ApiKeyRow,
  GatewayConfig,
  ModelRow,
  ProviderCall,
  ProviderResult,
  RoutingRule,
} from "../supabase/functions/_shared/types.ts";
import type { ProviderEndpoint } from "../supabase/functions/_shared/providers.ts";

export const OPEN_MODEL: ModelRow = {
  model_id: "open/gpt-oss-20b",
  provider: "groq",
  provider_model: "openai/gpt-oss-20b",
  tier: "open",
  license: "Apache-2.0",
  training_safe: true,
  input_krw_per_mtok: 100,
  output_krw_per_mtok: 400,
  pricing_verified_at: "2026-08-26",
  active: true,
};

export const EXTERNAL_MODEL: ModelRow = {
  model_id: "external/frontier",
  provider: "external",
  provider_model: "${EXTERNAL_LLM_MODEL}",
  tier: "external",
  license: "proprietary",
  training_safe: false,
  input_krw_per_mtok: 4000,
  output_krw_per_mtok: 20000,
  pricing_verified_at: "2026-08-26",
  active: true,
};

export const SELF_MODEL: ModelRow = {
  model_id: "self/v1",
  provider: "self",
  provider_model: "blackall-v1",
  tier: "self",
  license: "Apache-2.0",
  training_safe: true,
  input_krw_per_mtok: 10,
  output_krw_per_mtok: 30,
  pricing_verified_at: "2026-08-26",
  active: true,
};

export const DEFAULT_CONFIG: GatewayConfig = {
  self_model_max_ratio: 0.75,
  explore_ratio_floor: 0.05,
  external_long_context_threshold: 8000,
  route_unclassified_to_external: false,
  request_timeout_ms: 60_000,
};

export interface FakeDbOptions {
  apiKey?: ApiKeyRow | null;
  config?: GatewayConfig;
  models?: ModelRow[];
  rule?: RoutingRule | null;
  selfRatio?: number;
}

export class FakeDb implements GatewayDb {
  readonly inserted: InsertRequestArgs[] = [];
  readonly finalized: FinalizeRequestArgs[] = [];
  readonly responses: InsertResponseArgs[] = [];
  readonly feedback: { responseId: string; rating: number; text: string | null }[] = [];
  /** 삽입 순서를 검증하기 위한 이벤트 로그. */
  readonly events: string[] = [];

  constructor(private readonly opts: FakeDbOptions = {}) {}

  findApiKey(_hash: string): Promise<ApiKeyRow | null> {
    const key = this.opts.apiKey === undefined
      ? { id: "key-1", user_id: "11111111-1111-1111-1111-111111111111", rate_limit_per_min: 60 }
      : this.opts.apiKey;
    return Promise.resolve(key);
  }
  loadConfig(): Promise<GatewayConfig> {
    return Promise.resolve(this.opts.config ?? DEFAULT_CONFIG);
  }
  loadModels(): Promise<ModelRow[]> {
    return Promise.resolve(this.opts.models ?? [OPEN_MODEL, EXTERNAL_MODEL]);
  }
  loadRule(_t: string): Promise<RoutingRule | null> {
    return Promise.resolve(this.opts.rule ?? null);
  }
  selfTrafficRatio(): Promise<number> {
    return Promise.resolve(this.opts.selfRatio ?? 0);
  }
  insertRequest(args: InsertRequestArgs): Promise<string> {
    this.inserted.push(args);
    this.events.push("insertRequest");
    return Promise.resolve(`req-${this.inserted.length}`);
  }
  finalizeRequest(args: FinalizeRequestArgs): Promise<void> {
    this.finalized.push(args);
    this.events.push("finalizeRequest");
    return Promise.resolve();
  }
  insertResponse(args: InsertResponseArgs): Promise<string> {
    this.responses.push(args);
    this.events.push("insertResponse");
    return Promise.resolve(`resp-${this.responses.length}`);
  }
  insertFeedback(responseId: string, rating: number, text: string | null): Promise<void> {
    this.feedback.push({ responseId, rating, text });
    return Promise.resolve();
  }
  touchApiKey(_id: string): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function endpoints(
  present: { self?: boolean; open?: boolean; external?: boolean } = {},
): Record<"self" | "open" | "external", ProviderEndpoint | null> {
  const mk = (name: string): ProviderEndpoint => ({
    name,
    baseUrl: `https://example.invalid/${name}`,
    apiKey: "test",
  });
  return {
    self: present.self ? mk("self") : null,
    open: present.open === false ? null : mk("groq"),
    external: present.external === false ? null : mk("external"),
  };
}

export function makeCall(
  behaviour: (endpoint: ProviderEndpoint, call: ProviderCall) => ProviderResult | Error,
): (e: ProviderEndpoint, c: ProviderCall) => Promise<ProviderResult> {
  return (e, c) => {
    const out = behaviour(e, c);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
}

export function ok(output = "안녕하세요"): ProviderResult {
  return { output, inputTokens: 12, outputTokens: 7, finishReason: "stop" };
}

export function jsonRequest(body: unknown, key = "ba_live_testkey"): Request {
  return new Request("https://gw.example/gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
