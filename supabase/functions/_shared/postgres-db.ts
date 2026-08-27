import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import type {
  FinalizeRequestArgs,
  GatewayDb,
  InsertRequestArgs,
  InsertResponseArgs,
} from "./db.ts";
import { toGatewayConfig } from "./db.ts";
import type { ApiKeyRow, GatewayConfig, ModelRow, RoutingRule } from "./types.ts";

/**
 * gateway_writer 롤의 직접 Postgres 연결.
 *
 * service_role 키를 쓰지 않는 이유는 사양서 §2-1 이다. service_role 은 RLS 와
 * 대부분의 권한 검사를 우회하므로, 그 키로 접속하면 스키마 분리가 무의미해진다.
 * 게이트웨이도 학습 파이프라인도 각자의 최소 권한 롤로만 접속한다.
 */
export function createPostgresDb(connectionString: string): GatewayDb {
  const sql = postgres(connectionString, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Supabase 트랜잭션 모드 풀러(6543)와 호환
  });

  // 설정과 모델 레지스트리는 요청마다 읽을 필요가 없다. 60초 캐시.
  let cache: { at: number; config: GatewayConfig; models: ModelRow[] } | null = null;
  const TTL_MS = 60_000;

  async function refresh() {
    if (cache && Date.now() - cache.at < TTL_MS) return cache;
    const [cfgRows, modelRows] = await Promise.all([
      sql<{ key: string; value: string }[]>`select key, value from training.gateway_config`,
      sql<ModelRow[]>`
        select model_id, provider, provider_model, tier, license, training_safe,
               input_krw_per_mtok, output_krw_per_mtok, pricing_verified_at, active
          from training.models
         where active
         order by model_id`,
    ]);
    cache = { at: Date.now(), config: toGatewayConfig(cfgRows), models: modelRows };
    return cache;
  }

  return {
    async findApiKey(hash) {
      const rows = await sql<ApiKeyRow[]>`
        select id, user_id, rate_limit_per_min
          from training.api_keys
         where key_hash = ${hash} and revoked_at is null
         limit 1`;
      return rows[0] ?? null;
    },

    async loadConfig() {
      return (await refresh()).config;
    },

    async loadModels() {
      return (await refresh()).models;
    },

    async loadRule(taskType) {
      const rows = await sql<RoutingRule[]>`
        select task_type, current_target, explore_ratio
          from training.routing_rules
         where task_type = ${taskType}
         limit 1`;
      return rows[0] ?? null;
    },

    async selfTrafficRatio() {
      const rows = await sql<{ ratio: string }[]>`
        select training.self_traffic_ratio(interval '1 hour') as ratio`;
      return Number(rows[0]?.ratio ?? 0);
    },

    async insertRequest(a: InsertRequestArgs) {
      const rows = await sql<{ id: string }[]>`
        insert into training.requests
          (user_id, session_id, api_key_id, raw_input, input_tokens, task_type, status)
        values
          (${a.userId}, ${a.sessionId}, ${a.apiKeyId}, ${a.rawInput},
           ${a.inputTokens}, ${a.taskType}, 'pending')
        returning id`;
      return rows[0].id;
    },

    async finalizeRequest(a: FinalizeRequestArgs) {
      await sql`
        update training.requests
           set routed_to      = ${a.routedTo},
               model_id       = ${a.modelId},
               latency_ms     = ${a.latencyMs},
               input_tokens   = ${a.inputTokens},
               explored       = ${a.explored},
               routing_reason = ${a.routingReason},
               fallback_from  = ${a.fallbackFrom},
               status         = ${a.status},
               error_code     = ${a.errorCode}
         where id = ${a.requestId}`;
    },

    async insertResponse(a: InsertResponseArgs) {
      // 사양서 §2-1: 학습 가능 출력과 외부 출력은 물리적으로 다른 스키마에 들어간다.
      // 잘못 넣으면 DB 트리거가 거부한다 — 이 분기는 편의일 뿐 안전장치가 아니다.
      const rows = a.trainingSafe
        ? await sql<{ id: string }[]>`
            insert into training.responses
              (request_id, output, output_tokens, model_id, cost_krw, is_shadow, finish_reason)
            values (${a.requestId}, ${a.output}, ${a.outputTokens}, ${a.modelId},
                    ${a.costKrw}, ${a.isShadow}, ${a.finishReason})
            returning id`
        : await sql<{ id: string }[]>`
            insert into reference.responses
              (request_id, output, output_tokens, model_id, cost_krw, is_shadow, finish_reason)
            values (${a.requestId}, ${a.output}, ${a.outputTokens}, ${a.modelId},
                    ${a.costKrw}, ${a.isShadow}, ${a.finishReason})
            returning id`;
      return rows[0].id;
    },

    async insertFeedback(responseId, rating, correctedText) {
      // 응답이 어느 스키마에 있는지 모르므로 양쪽을 시도한다.
      const inTraining = await sql<{ id: string }[]>`
        select id from training.responses where id = ${responseId} limit 1`;
      if (inTraining.length > 0) {
        await sql`
          insert into training.message_feedback (response_id, rating, corrected_text)
          values (${responseId}, ${rating}, ${correctedText})`;
        return;
      }
      await sql`
        insert into reference.message_feedback (response_id, rating, corrected_text)
        values (${responseId}, ${rating}, ${correctedText})`;
    },

    async touchApiKey(id) {
      await sql`update training.api_keys set last_used_at = now() where id = ${id}`;
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
