import type { ProviderEndpoint } from "./providers.ts";
import type { GatewayConfig, Tier } from "./types.ts";

export interface GatewayEnv {
  databaseUrl: string;
  endpoints: Record<Tier, ProviderEndpoint | null>;
  preferredModelIds: Partial<Record<Tier, string>>;
  /** 사양서 §9 의 SELF_MODEL_MAX_RATIO / EXPLORE_RATIO. DB 설정을 조일 수만 있다. */
  selfModelMaxRatioEnv: number | null;
  exploreRatioEnv: number | null;
}

function opt(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function req(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`환경변수 ${name} 가 필요하다.`);
  return v;
}

function num(name: string): number | null {
  const v = opt(name);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function loadEnv(): GatewayEnv {
  const groqKey = opt("GROQ_API_KEY");
  const externalKey = opt("EXTERNAL_LLM_API_KEY");
  const selfKey = opt("SELF_MODEL_API_KEY");
  const selfBase = opt("SELF_MODEL_BASE_URL");

  return {
    // 게이트웨이는 gateway_writer 롤로만 접속한다. service_role 키를 쓰지 않는다 (§2-1).
    databaseUrl: req("GATEWAY_DATABASE_URL"),

    endpoints: {
      open: groqKey
        ? {
          name: "groq",
          baseUrl: opt("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1",
          apiKey: groqKey,
        }
        : null,
      external: externalKey
        ? {
          name: "external",
          baseUrl: req("EXTERNAL_LLM_BASE_URL"),
          apiKey: externalKey,
        }
        : null,
      // 자체 모델은 4~6개월차 산출물이다. 지금은 설정되지 않은 것이 정상이다.
      self: selfBase && selfKey ? { name: "self", baseUrl: selfBase, apiKey: selfKey } : null,
    },

    preferredModelIds: {
      open: opt("OPEN_MODEL_ID") ?? "open/gpt-oss-20b",
      external: opt("EXTERNAL_MODEL_ID") ?? "external/frontier",
      self: opt("SELF_MODEL_ID"),
    },

    selfModelMaxRatioEnv: num("SELF_MODEL_MAX_RATIO"),
    exploreRatioEnv: num("EXPLORE_RATIO"),
  };
}

/**
 * 환경변수는 DB 설정을 조일 수만 있고 풀 수는 없다.
 * 상한은 더 낮게, 하한은 더 높게만 반영된다. 사양서 §5-3 의 취지가 그렇다.
 */
export function applyEnvClamps(config: GatewayConfig, env: GatewayEnv): GatewayConfig {
  return {
    ...config,
    self_model_max_ratio: env.selfModelMaxRatioEnv === null
      ? config.self_model_max_ratio
      : Math.min(config.self_model_max_ratio, Math.max(0, env.selfModelMaxRatioEnv)),
    explore_ratio_floor: env.exploreRatioEnv === null
      ? config.explore_ratio_floor
      : Math.max(config.explore_ratio_floor, Math.min(1, env.exploreRatioEnv)),
  };
}

/** `${EXTERNAL_LLM_MODEL}` 형태의 자리표시자를 환경변수 값으로 치환한다. */
export function expandEnvPlaceholders(raw: string): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => Deno.env.get(name) ?? "");
}
