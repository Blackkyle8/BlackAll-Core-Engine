import type { GatewayDb } from "./db.ts";
import { authenticate } from "./auth.ts";
import { computeCost } from "./cost.ts";
import { decideRoute, fallbackTier, selectModel } from "./routing.ts";
import type { RoutingDecision } from "./routing.ts";
import { estimateMessagesTokens, estimateTokens, flattenMessages } from "./tokens.ts";
import type { ProviderEndpoint } from "./providers.ts";
import {
  type ChatMessage,
  type ChatRequest,
  GatewayError,
  type ModelRow,
  type ProviderCall,
  ProviderError,
  type ProviderResult,
  type Tier,
} from "./types.ts";

export interface HandlerDeps {
  db: GatewayDb;
  /** 계층별 제공자 엔드포인트. 설정되지 않은 계층은 null. */
  endpoints: Record<Tier, ProviderEndpoint | null>;
  /** 계층별 선호 model_id (환경변수로 고정). 없으면 레지스트리 첫 활성 모델. */
  preferredModelIds: Partial<Record<Tier, string>>;
  call: (endpoint: ProviderEndpoint, call: ProviderCall) => Promise<ProviderResult>;
  /**
   * 레지스트리의 provider_model 에 담긴 `${ENV_NAME}` 자리표시자를 실제 값으로 바꾼다.
   * 외부 고성능 모델명은 제공자를 갈아끼울 때마다 바뀌므로 DB 가 아니라 환경변수가 진실이다.
   */
  resolveProviderModel?: (raw: string) => string;
  random: () => number;
  now: () => number;
  /**
   * §5-1 7단계. 자체 모델이 존재할 때만 의미가 있다.
   * 4~6개월차 산출물이므로 지금은 no-op 이다 (§12 게이트 참조).
   */
  enqueueShadowRun?: (requestId: string) => void;
  log?: (event: Record<string, unknown>) => void;
}

interface AttemptOutcome {
  tier: Tier;
  model: ModelRow;
  result: ProviderResult;
  fallbackFrom: Tier | null;
}

/**
 * 사양서 §5-1 요청 처리 흐름을 그대로 구현한다.
 *
 *   1. 인증 확인
 *   2. requests 행 삽입              ← 제공자 호출보다 먼저. §8 2주차 완료 조건.
 *   3. routing_rules 조회 → 대상 결정
 *   4. 탐색 비율 적용
 *   5. 대상 모델 호출
 *   6. responses 행 삽입             ← training_safe 에 따라 스키마가 갈린다. §2-1
 *   7. 그림자 실행 큐 투입 (자체 모델 존재 시)
 *   8. 응답 반환
 */
export async function handleChatCompletion(
  req: Request,
  deps: HandlerDeps,
): Promise<Response> {
  const startedAt = deps.now();

  // 1. 인증
  const apiKey = await authenticate(req, (h) => deps.db.findApiKey(h));

  const body = await parseBody(req);
  const messages = body.messages;
  const taskType = body.task_type?.trim() || "unclassified";

  // 2. requests 삽입 — 이후 무엇이 터지든 이 호출은 기록에 남는다.
  const estimatedInput = estimateMessagesTokens(messages);
  const requestId = await deps.db.insertRequest({
    userId: apiKey.user_id,
    sessionId: body.session_id ?? null,
    apiKeyId: apiKey.id,
    rawInput: flattenMessages(messages),
    inputTokens: estimatedInput,
    taskType,
  });

  try {
    // 3~4. 라우팅
    const [config, models, rule, selfRatio] = await Promise.all([
      deps.db.loadConfig(),
      deps.db.loadModels(),
      deps.db.loadRule(taskType),
      deps.db.selfTrafficRatio(),
    ]);

    const decision = decideRoute({
      taskType,
      inputTokens: estimatedInput,
      rule,
      config,
      selfTrafficRatio: selfRatio,
      selfModelAvailable: deps.endpoints.self !== null,
      random: deps.random(),
    });

    // 5. 호출 (실패 시 self → open → external 강등)
    const outcome = await callWithFallback(deps, decision, models, {
      providerModel: "",
      messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      timeoutMs: config.request_timeout_ms,
    });

    const inputTokens = outcome.result.inputTokens ?? estimatedInput;
    const outputTokens = outcome.result.outputTokens ?? estimateTokens(outcome.result.output);
    const cost = computeCost(outcome.model, inputTokens, outputTokens);

    // 6. responses 삽입
    const responseId = await deps.db.insertResponse({
      requestId,
      output: outcome.result.output,
      outputTokens,
      modelId: outcome.model.model_id,
      costKrw: cost.costKrw,
      isShadow: false,
      finishReason: outcome.result.finishReason,
      trainingSafe: outcome.model.training_safe,
    });

    const latencyMs = deps.now() - startedAt;
    await deps.db.finalizeRequest({
      requestId,
      routedTo: outcome.tier,
      modelId: outcome.model.model_id,
      latencyMs,
      inputTokens,
      explored: decision.explored,
      routingReason: decision.reason,
      fallbackFrom: outcome.fallbackFrom,
      status: "ok",
      errorCode: null,
    });

    deps.db.touchApiKey(apiKey.id).catch(() => {});

    // 7. 그림자 실행 — 자체 모델이 있고 이번 호출이 자체 모델이 아닐 때만 의미가 있다.
    if (deps.endpoints.self && outcome.tier !== "self") {
      deps.enqueueShadowRun?.(requestId);
    }

    deps.log?.({
      event: "gateway.ok",
      request_id: requestId,
      routed_to: outcome.tier,
      reason: decision.reason,
      explored: decision.explored,
      fallback_from: outcome.fallbackFrom,
      model_id: outcome.model.model_id,
      training_safe: outcome.model.training_safe,
      latency_ms: latencyMs,
      cost_krw: cost.costKrw,
      cost_estimated: cost.estimated,
    });

    // 8. 응답
    return jsonResponse(200, {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(deps.now() / 1000),
      model: outcome.model.model_id,
      choices: [{
        index: 0,
        message: { role: "assistant", content: outcome.result.output },
        finish_reason: outcome.result.finishReason ?? "stop",
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }, {
      "x-blackall-request-id": requestId,
      "x-blackall-response-id": responseId,
      "x-blackall-routed-to": outcome.tier,
      "x-blackall-routing-reason": decision.reason,
      "x-blackall-explored": String(decision.explored),
      "x-blackall-model": outcome.model.model_id,
      "x-blackall-cost-krw": String(cost.costKrw),
      "x-blackall-latency-ms": String(latencyMs),
    });
  } catch (err) {
    const latencyMs = deps.now() - startedAt;
    const code = err instanceof ProviderError
      ? `provider_${err.provider}_${err.status ?? "network"}`
      : err instanceof GatewayError
      ? err.code
      : "internal_error";

    await deps.db.finalizeRequest({
      requestId,
      routedTo: "external",
      modelId: deps.preferredModelIds.external ?? "external/frontier",
      latencyMs,
      inputTokens: estimatedInput,
      explored: false,
      routingReason: "error",
      fallbackFrom: null,
      status: "error",
      errorCode: code,
    }).catch(() => {});

    deps.log?.({ event: "gateway.error", request_id: requestId, code, message: String(err) });
    throw err;
  }
}

async function callWithFallback(
  deps: HandlerDeps,
  decision: RoutingDecision,
  models: ModelRow[],
  base: ProviderCall,
): Promise<AttemptOutcome> {
  let tier: Tier | null = decision.tier;
  let fallbackFrom: Tier | null = null;
  let lastError: unknown = null;

  while (tier !== null) {
    const endpoint = deps.endpoints[tier];
    const model = selectModel(models, tier, deps.preferredModelIds[tier]);

    if (endpoint && model) {
      try {
        const providerModel = deps.resolveProviderModel
          ? deps.resolveProviderModel(model.provider_model)
          : model.provider_model;
        const result = await deps.call(endpoint, { ...base, providerModel });
        return { tier, model, result, fallbackFrom };
      } catch (err) {
        lastError = err;
        deps.log?.({
          event: "gateway.tier_failed",
          tier,
          model_id: model.model_id,
          message: String(err),
        });
      }
    } else {
      lastError = new GatewayError(
        503,
        "tier_unconfigured",
        `${tier} 계층이 설정되지 않았다 (endpoint=${!!endpoint}, model=${!!model}).`,
      );
    }

    const next: Tier | null = fallbackTier(tier);
    if (next !== null) fallbackFrom = decision.tier;
    tier = next;
  }

  throw lastError ??
    new GatewayError(502, "all_tiers_failed", "모든 계층 호출이 실패했다.");
}

async function parseBody(req: Request): Promise<ChatRequest> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new GatewayError(400, "invalid_json", "JSON 본문을 해석할 수 없다.");
  }

  const b = body as ChatRequest;
  if (!Array.isArray(b?.messages) || b.messages.length === 0) {
    throw new GatewayError(400, "invalid_request", "messages 배열이 필요하다.");
  }
  for (const m of b.messages as ChatMessage[]) {
    if (!m || typeof m.content !== "string" || !["system", "user", "assistant"].includes(m.role)) {
      throw new GatewayError(
        400,
        "invalid_request",
        "messages 항목은 {role, content} 형식이어야 한다.",
      );
    }
  }
  return b;
}

export function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof GatewayError) {
    return jsonResponse(err.status, { error: { code: err.code, message: err.message } });
  }
  if (err instanceof ProviderError) {
    return jsonResponse(502, {
      error: {
        code: "provider_error",
        message: err.message,
        provider: err.provider,
        provider_status: err.status,
      },
    });
  }
  return jsonResponse(500, {
    error: { code: "internal_error", message: String(err) },
  });
}

/** 사양서 §4-2 message_feedback — 선호 최적화 학습 원천. 1일차부터 받지 않으면 영원히 못 받는다. */
export async function handleFeedback(req: Request, deps: HandlerDeps): Promise<Response> {
  await authenticate(req, (h) => deps.db.findApiKey(h));

  const body = await req.json().catch(() => null) as
    | { response_id?: string; rating?: number; corrected_text?: string }
    | null;

  if (!body?.response_id || ![-1, 0, 1].includes(Number(body.rating))) {
    throw new GatewayError(400, "invalid_request", "response_id 와 rating(-1|0|1) 이 필요하다.");
  }

  await deps.db.insertFeedback(
    body.response_id,
    Number(body.rating),
    body.corrected_text ?? null,
  );
  return jsonResponse(202, { ok: true });
}
