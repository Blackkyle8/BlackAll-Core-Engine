import { assertEquals } from "jsr:@std/assert@1";
import { decideRoute, fallbackTier, selectModel } from "../supabase/functions/_shared/routing.ts";
import type { RoutingInput } from "../supabase/functions/_shared/routing.ts";
import { DEFAULT_CONFIG, EXTERNAL_MODEL, OPEN_MODEL, SELF_MODEL } from "./fakes.ts";

function input(over: Partial<RoutingInput> = {}): RoutingInput {
  return {
    taskType: "unclassified",
    inputTokens: 100,
    rule: null,
    config: DEFAULT_CONFIG,
    selfTrafficRatio: 0,
    selfModelAvailable: false,
    random: 0.9, // 탐색 미당첨
    ...over,
  };
}

// --- §5-2 라우팅 규칙 -------------------------------------------------------

Deno.test("§5-2 그 외에는 오픈모델이 기본이다", () => {
  assertEquals(decideRoute(input()), {
    tier: "open",
    explored: false,
    reason: "default_open",
  });
});

Deno.test("§5-2 입력 토큰이 8000 을 넘으면 외부 고성능으로 간다", () => {
  const d = decideRoute(input({ inputTokens: 8001 }));
  assertEquals(d.tier, "external");
  assertEquals(d.reason, "long_context");
  assertEquals(d.explored, false, "긴 컨텍스트 라우팅은 탐색이 아니다");
});

Deno.test("§5-2 경계값 8000 은 넘지 않은 것이다", () => {
  assertEquals(decideRoute(input({ inputTokens: 8000 })).tier, "open");
});

Deno.test("§5-2 unclassified 외부 라우팅은 스위치가 켜졌을 때만 동작한다", () => {
  // 2주차: 스위치 OFF. 전 트래픽이 외부로 새어나가면 비용이 폭발한다.
  assertEquals(decideRoute(input()).tier, "open");

  // 3주차 분류기 도입 후: 스위치 ON.
  const on = decideRoute(input({
    config: { ...DEFAULT_CONFIG, route_unclassified_to_external: true },
  }));
  assertEquals(on.tier, "external");
  assertEquals(on.reason, "unclassified");
});

// --- §5-1 4단계 탐색 --------------------------------------------------------

Deno.test("§5-1 탐색 비율에 당첨되면 강제로 외부로 가고 explored 로 표시된다", () => {
  const d = decideRoute(input({ random: 0.01 }));
  assertEquals(d.tier, "external");
  assertEquals(d.explored, true);
  assertEquals(d.reason, "explore");
});

Deno.test("§5-3 탐색 비율 하한 5% 는 규칙값이 더 낮아도 유지된다", () => {
  // 규칙이 1% 를 주장해도 하한이 이긴다.
  const rule = { task_type: "t", current_target: "open" as const, explore_ratio: 0.01 };
  assertEquals(decideRoute(input({ rule, random: 0.03 })).explored, true);
});

Deno.test("규칙의 탐색 비율이 하한보다 높으면 규칙이 이긴다", () => {
  const rule = { task_type: "t", current_target: "open" as const, explore_ratio: 0.30 };
  assertEquals(decideRoute(input({ rule, random: 0.25 })).explored, true);
  assertEquals(decideRoute(input({ rule, random: 0.35 })).explored, false);
});

// --- §5-3 자체 모델 비중 상한 ----------------------------------------------

Deno.test("§5-2 승격된 유형은 자체 모델로 간다", () => {
  const rule = { task_type: "summarize", current_target: "self" as const, explore_ratio: 0.05 };
  const d = decideRoute(input({ rule, selfModelAvailable: true, selfTrafficRatio: 0.4 }));
  assertEquals(d.tier, "self");
  assertEquals(d.reason, "rule_self");
});

Deno.test("§5-3 자체 모델 비중이 상한 75% 에 닿으면 오픈모델로 강등된다", () => {
  const rule = { task_type: "summarize", current_target: "self" as const, explore_ratio: 0.05 };
  const d = decideRoute(input({ rule, selfModelAvailable: true, selfTrafficRatio: 0.75 }));
  assertEquals(d.tier, "open");
  assertEquals(d.reason, "self_ratio_cap");
});

Deno.test("자체 모델 엔드포인트가 없으면 승격된 유형도 오픈모델로 간다", () => {
  const rule = { task_type: "summarize", current_target: "self" as const, explore_ratio: 0.05 };
  const d = decideRoute(input({ rule, selfModelAvailable: false }));
  assertEquals(d.tier, "open");
  assertEquals(d.reason, "self_unavailable");
});

Deno.test("긴 컨텍스트는 자체 모델 승격보다 우선한다", () => {
  const rule = { task_type: "summarize", current_target: "self" as const, explore_ratio: 0.05 };
  const d = decideRoute(
    input({ rule, selfModelAvailable: true, inputTokens: 12000 }),
  );
  assertEquals(d.tier, "external");
  assertEquals(d.reason, "long_context");
});

Deno.test("규칙이 external 이면 외부로 간다", () => {
  const rule = { task_type: "legal", current_target: "external" as const, explore_ratio: 0.05 };
  assertEquals(decideRoute(input({ rule })).reason, "rule_external");
});

// --- 강등 경로 --------------------------------------------------------------

Deno.test("강등 경로는 self → open → external → 없음", () => {
  assertEquals(fallbackTier("self"), "open");
  assertEquals(fallbackTier("open"), "external");
  assertEquals(fallbackTier("external"), null);
});

// --- 모델 선택 --------------------------------------------------------------

Deno.test("선호 모델이 있으면 그것을 쓰고 없으면 계층의 첫 활성 모델을 쓴다", () => {
  const models = [OPEN_MODEL, EXTERNAL_MODEL, SELF_MODEL];
  assertEquals(selectModel(models, "open")?.model_id, "open/gpt-oss-20b");
  assertEquals(selectModel(models, "external", "external/frontier")?.model_id, "external/frontier");
  assertEquals(selectModel(models, "self", "self/does-not-exist")?.model_id, "self/v1");
  assertEquals(selectModel([{ ...OPEN_MODEL, active: false }], "open"), null);
});
