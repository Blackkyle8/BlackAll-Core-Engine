import { assertEquals } from "jsr:@std/assert@1";
import { toGatewayConfig } from "../supabase/functions/_shared/db.ts";

Deno.test("§5-3 자체 모델 비중 상한은 코드에서도 0.75 로 잘린다", () => {
  // DB CHECK 를 우회해 값이 들어왔더라도 게이트웨이가 다시 자른다.
  const c = toGatewayConfig([{ key: "self_model_max_ratio", value: 0.99 }]);
  assertEquals(c.self_model_max_ratio, 0.75);
});

Deno.test("§5-3 탐색 비율 하한은 코드에서도 0.05 로 올라온다", () => {
  const c = toGatewayConfig([{ key: "explore_ratio_floor", value: 0 }]);
  assertEquals(c.explore_ratio_floor, 0.05);
});

Deno.test("설정이 비어 있으면 사양서 기본값을 쓴다", () => {
  const c = toGatewayConfig([]);
  assertEquals(c.self_model_max_ratio, 0.75);
  assertEquals(c.explore_ratio_floor, 0.05);
  assertEquals(c.external_long_context_threshold, 8000);
  assertEquals(c.route_unclassified_to_external, false);
});

Deno.test("route_unclassified_to_external 은 1 이상일 때만 켜진다", () => {
  assertEquals(
    toGatewayConfig([{ key: "route_unclassified_to_external", value: 0 }])
      .route_unclassified_to_external,
    false,
  );
  assertEquals(
    toGatewayConfig([{ key: "route_unclassified_to_external", value: 1 }])
      .route_unclassified_to_external,
    true,
  );
});

Deno.test("문자열로 온 numeric 값도 처리한다 (postgres numeric 은 문자열로 온다)", () => {
  const c = toGatewayConfig([{ key: "external_long_context_threshold", value: "8000" }]);
  assertEquals(c.external_long_context_threshold, 8000);
});
