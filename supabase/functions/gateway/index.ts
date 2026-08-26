// =============================================================================
// BlackAll LLM 게이트웨이
// 사양서 §5 게이트웨이 동작 사양, §8 2주차
//
// 고객은 이 주소 하나만 호출한다. OpenAI 호환 규격이므로 기존 SDK 를 그대로 쓴다.
//   POST /gateway/v1/chat/completions
//   POST /gateway/v1/feedback
//   GET  /gateway/health
// =============================================================================

import { createPostgresDb } from "../_shared/postgres-db.ts";
import {
  errorResponse,
  handleChatCompletion,
  handleFeedback,
  jsonResponse,
} from "../_shared/handler.ts";
import type { HandlerDeps } from "../_shared/handler.ts";
import { callWithRetry } from "../_shared/providers.ts";
import { applyEnvClamps, expandEnvPlaceholders, loadEnv } from "../_shared/env.ts";
import type { GatewayDb } from "../_shared/db.ts";

const env = loadEnv();
const baseDb: GatewayDb = createPostgresDb(env.databaseUrl);

// 환경변수는 DB 설정을 조일 수만 있다 (§5-3).
const db: GatewayDb = {
  ...baseDb,
  loadConfig: async () => applyEnvClamps(await baseDb.loadConfig(), env),
};

const deps: HandlerDeps = {
  db,
  endpoints: env.endpoints,
  preferredModelIds: env.preferredModelIds,
  call: callWithRetry,
  resolveProviderModel: expandEnvPlaceholders,
  random: Math.random,
  now: Date.now,
  // §5-1 7단계. 자체 모델이 없는 동안은 호출되지 않는다 (§12 게이트).
  enqueueShadowRun: undefined,
  log: (event) => console.log(JSON.stringify(event)),
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path = new URL(req.url).pathname.replace(/^\/gateway/, "").replace(/\/+$/, "") || "/";

  try {
    let res: Response;

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      res = jsonResponse(200, {
        ok: true,
        tiers: {
          self: env.endpoints.self !== null,
          open: env.endpoints.open !== null,
          external: env.endpoints.external !== null,
        },
      });
    } else if (req.method === "POST" && path === "/v1/chat/completions") {
      res = await handleChatCompletion(req, deps);
    } else if (req.method === "POST" && path === "/v1/feedback") {
      res = await handleFeedback(req, deps);
    } else {
      res = jsonResponse(404, {
        error: { code: "not_found", message: `${req.method} ${path} 는 없는 경로다.` },
      });
    }

    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  }
});
