import { assert, assertEquals } from "jsr:@std/assert@1";
import { computeCost } from "../supabase/functions/_shared/cost.ts";
import { EXTERNAL_MODEL, OPEN_MODEL } from "./fakes.ts";

Deno.test("§11 비용은 원/100만 토큰 단가로 계산된다", () => {
  // 입력 100원/M, 출력 400원/M
  const c = computeCost(OPEN_MODEL, 1_000_000, 1_000_000);
  assertEquals(c.costKrw, 500);
  assertEquals(c.estimated, false);
});

Deno.test("소액 호출도 소수점 4자리까지 남는다", () => {
  const c = computeCost(OPEN_MODEL, 1000, 500);
  // 1000/1e6*100 + 500/1e6*400 = 0.1 + 0.2 = 0.3
  assertEquals(c.costKrw, 0.3);
});

Deno.test("외부 고성능은 오픈모델보다 훨씬 비싸다 — 라우팅 유인의 근거", () => {
  const open = computeCost(OPEN_MODEL, 5000, 2000);
  const ext = computeCost(EXTERNAL_MODEL, 5000, 2000);
  assert(ext.costKrw > open.costKrw * 20);
});

Deno.test("단가 미확인 모델은 estimated 로 표시된다 — §11 예산 감시가 속으면 안 된다", () => {
  const unverified = { ...OPEN_MODEL, pricing_verified_at: null };
  assertEquals(computeCost(unverified, 1000, 1000).estimated, true);
});

Deno.test("단가가 0 이면 비용도 0 이다 (초기 시드 상태)", () => {
  const zero = {
    ...OPEN_MODEL,
    input_krw_per_mtok: 0,
    output_krw_per_mtok: 0,
    pricing_verified_at: null,
  };
  const c = computeCost(zero, 10_000, 10_000);
  assertEquals(c.costKrw, 0);
  assertEquals(c.estimated, true, "0원이 사실이 아니라 미입력임을 알려야 한다");
});
