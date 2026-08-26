import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { handleChatCompletion, handleFeedback } from "../supabase/functions/_shared/handler.ts";
import type { HandlerDeps } from "../supabase/functions/_shared/handler.ts";
import { GatewayError, ProviderError } from "../supabase/functions/_shared/types.ts";
import {
  DEFAULT_CONFIG,
  endpoints,
  EXTERNAL_MODEL,
  FakeDb,
  jsonRequest,
  makeCall,
  ok,
  OPEN_MODEL,
  SELF_MODEL,
} from "./fakes.ts";

function deps(db: FakeDb, over: Partial<HandlerDeps> = {}): HandlerDeps {
  let t = 1_700_000_000_000;
  return {
    db,
    endpoints: endpoints(),
    preferredModelIds: { open: "open/gpt-oss-20b", external: "external/frontier" },
    call: makeCall(() => ok()),
    random: () => 0.9,
    now: () => (t += 10),
    ...over,
  };
}

const BODY = { messages: [{ role: "user", content: "안녕" }] };

Deno.test("§5-1 1단계 — API 키가 없으면 401", async () => {
  const db = new FakeDb();
  const req = new Request("https://gw/gateway/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(BODY),
  });
  const err = await assertRejects(() => handleChatCompletion(req, deps(db)), GatewayError);
  assertEquals(err.status, 401);
  assertEquals(db.inserted.length, 0, "인증 전에는 아무것도 기록하지 않는다");
});

Deno.test("§5-1 1단계 — 폐기된 키는 401", async () => {
  const db = new FakeDb({ apiKey: null });
  const err = await assertRejects(
    () => handleChatCompletion(jsonRequest(BODY), deps(db)),
    GatewayError,
  );
  assertEquals(err.status, 401);
});

Deno.test("§8 2주차 완료 조건 — requests 삽입이 제공자 호출보다 먼저 일어난다", async () => {
  const db = new FakeDb();
  let insertedBeforeCall = false;
  const res = await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      call: makeCall(() => {
        insertedBeforeCall = db.inserted.length === 1;
        return ok();
      }),
    }),
  );
  assertEquals(res.status, 200);
  assert(insertedBeforeCall, "제공자 호출 시점에 requests 행이 이미 있어야 한다");
  assertEquals(db.events, ["insertRequest", "insertResponse", "finalizeRequest"]);
});

Deno.test("§8 2주차 완료 조건 — 모든 계층이 실패해도 호출은 기록에 남는다", async () => {
  const db = new FakeDb();
  await assertRejects(() =>
    handleChatCompletion(
      jsonRequest(BODY),
      deps(db, {
        call: makeCall((e) => new ProviderError(e.name, 500, "폭발", true)),
      }),
    )
  );
  assertEquals(db.inserted.length, 1);
  assertEquals(db.finalized.length, 1);
  assertEquals(db.finalized[0].status, "error");
  assertEquals(db.responses.length, 0, "실패했으므로 응답 행은 없다");
});

Deno.test("§2-1 — 오픈모델 출력은 training 스키마로 간다", async () => {
  const db = new FakeDb();
  await handleChatCompletion(jsonRequest(BODY), deps(db));
  assertEquals(db.responses[0].trainingSafe, true);
  assertEquals(db.responses[0].modelId, "open/gpt-oss-20b");
  assertEquals(db.finalized[0].routedTo, "open");
});

Deno.test("§2-1 — 외부 상용 API 출력은 절대 training 스키마로 가지 않는다", async () => {
  const db = new FakeDb();
  // 탐색 당첨 → 강제 외부 라우팅
  await handleChatCompletion(jsonRequest(BODY), deps(db, { random: () => 0.001 }));
  assertEquals(db.finalized[0].routedTo, "external");
  assertEquals(db.finalized[0].explored, true);
  assertEquals(db.responses[0].trainingSafe, false, "외부 출력은 reference 로 간다");
  assertEquals(db.responses[0].modelId, "external/frontier");
});

Deno.test("긴 입력은 외부로 라우팅되고 이유가 기록된다", async () => {
  const db = new FakeDb();
  const long = "가".repeat(20000);
  await handleChatCompletion(
    jsonRequest({ messages: [{ role: "user", content: long }] }),
    deps(db),
  );
  assertEquals(db.finalized[0].routedTo, "external");
  assertEquals(db.finalized[0].routingReason, "long_context");
});

Deno.test("오픈모델이 실패하면 외부로 강등되고 강등 사실이 기록된다", async () => {
  const db = new FakeDb();
  const res = await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      call: makeCall((e) =>
        e.name === "groq" ? new ProviderError("groq", 503, "일시 장애", true) : ok("외부 응답")
      ),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(db.finalized[0].routedTo, "external");
  assertEquals(db.finalized[0].fallbackFrom, "open");
  assertEquals(db.responses[0].trainingSafe, false, "강등되어 외부로 갔으면 학습 불가다");
});

Deno.test("자체 모델이 실패하면 오픈모델로 강등된다", async () => {
  const db = new FakeDb({
    models: [SELF_MODEL, OPEN_MODEL, EXTERNAL_MODEL],
    rule: { task_type: "unclassified", current_target: "self", explore_ratio: 0.05 },
  });
  await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      endpoints: endpoints({ self: true }),
      preferredModelIds: {
        self: "self/v1",
        open: "open/gpt-oss-20b",
        external: "external/frontier",
      },
      call: makeCall((e) =>
        e.name === "self" ? new ProviderError("self", 500, "콜드스타트 실패", true) : ok()
      ),
    }),
  );
  assertEquals(db.finalized[0].routedTo, "open");
  assertEquals(db.finalized[0].fallbackFrom, "self");
});

Deno.test("제공자 usage 가 오면 추정 토큰 대신 실측값이 기록된다", async () => {
  const db = new FakeDb();
  await handleChatCompletion(jsonRequest(BODY), deps(db));
  assertEquals(db.finalized[0].inputTokens, 12, "제공자가 보고한 prompt_tokens");
  assertEquals(db.responses[0].outputTokens, 7);
});

Deno.test("제공자 usage 가 없으면 추정치로 기록된다", async () => {
  const db = new FakeDb();
  await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      call: makeCall(() => ({
        output: "짧은 답",
        inputTokens: null,
        outputTokens: null,
        finishReason: "stop",
      })),
    }),
  );
  assert(db.finalized[0].inputTokens > 0);
  assert(db.responses[0].outputTokens > 0);
});

Deno.test("§5-1 8단계 — 응답은 OpenAI 호환 형식이고 라우팅 근거가 헤더에 실린다", async () => {
  const db = new FakeDb();
  const res = await handleChatCompletion(jsonRequest(BODY), deps(db));
  const body = await res.json();

  assertEquals(body.object, "chat.completion");
  assertEquals(body.choices[0].message.role, "assistant");
  assertEquals(body.choices[0].message.content, "안녕하세요");
  assertEquals(body.usage.total_tokens, 19);

  assertEquals(res.headers.get("x-blackall-routed-to"), "open");
  assertEquals(res.headers.get("x-blackall-routing-reason"), "default_open");
  assertEquals(res.headers.get("x-blackall-explored"), "false");
  assert(res.headers.get("x-blackall-request-id"));
});

Deno.test("잘못된 본문은 400 이고 기록되지 않는다", async () => {
  const db = new FakeDb();
  for (const bad of [{}, { messages: [] }, { messages: [{ role: "bogus", content: "x" }] }]) {
    const err = await assertRejects(
      () => handleChatCompletion(jsonRequest(bad), deps(db)),
      GatewayError,
    );
    assertEquals(err.status, 400);
  }
  assertEquals(db.inserted.length, 0);
});

Deno.test("§5-1 7단계 — 자체 모델이 없으면 그림자 실행 큐에 넣지 않는다", async () => {
  const db = new FakeDb();
  let enqueued = 0;
  await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, { enqueueShadowRun: () => enqueued++ }),
  );
  assertEquals(enqueued, 0);
});

Deno.test("§5-1 7단계 — 자체 모델이 있고 다른 계층으로 갔으면 그림자 실행을 건다", async () => {
  const db = new FakeDb({ models: [SELF_MODEL, OPEN_MODEL, EXTERNAL_MODEL] });
  let enqueued = 0;
  await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      endpoints: endpoints({ self: true }),
      enqueueShadowRun: () => enqueued++,
    }),
  );
  assertEquals(enqueued, 1);
});

Deno.test("§4-2 message_feedback 수집", async () => {
  const db = new FakeDb();
  const req = new Request("https://gw/gateway/v1/feedback", {
    method: "POST",
    headers: { authorization: "Bearer k" },
    body: JSON.stringify({ response_id: "resp-1", rating: -1, corrected_text: "이렇게 고쳐야" }),
  });
  const res = await handleFeedback(req, deps(db));
  assertEquals(res.status, 202);
  assertEquals(db.feedback[0], { responseId: "resp-1", rating: -1, text: "이렇게 고쳐야" });
});

Deno.test("자리표시자가 담긴 provider_model 은 호출 직전에 치환된다", async () => {
  const db = new FakeDb();
  let sentModel = "";
  await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      random: () => 0.001, // 외부로 강제
      resolveProviderModel: (raw) => raw === "${EXTERNAL_LLM_MODEL}" ? "some-frontier-v3" : raw,
      call: makeCall((_e, c) => {
        sentModel = c.providerModel;
        return ok();
      }),
    }),
  );
  assertEquals(sentModel, "some-frontier-v3");
});

Deno.test("설정으로 지정한 타임아웃이 제공자 호출에 전달된다", async () => {
  const db = new FakeDb({ config: { ...DEFAULT_CONFIG, request_timeout_ms: 1234 } });
  let seen = 0;
  await handleChatCompletion(
    jsonRequest(BODY),
    deps(db, {
      call: makeCall((_e, c) => {
        seen = c.timeoutMs;
        return ok();
      }),
    }),
  );
  assertEquals(seen, 1234);
});
