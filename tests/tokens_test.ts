import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  estimateMessagesTokens,
  estimateTokens,
  flattenMessages,
} from "../supabase/functions/_shared/tokens.ts";

Deno.test("빈 문자열은 0 토큰", () => {
  assertEquals(estimateTokens(""), 0);
});

Deno.test("한글은 라틴 문자보다 문자당 토큰이 많다", () => {
  const ko = estimateTokens("가".repeat(100));
  const en = estimateTokens("a".repeat(100));
  assert(ko > en, `한글 ${ko} vs 영문 ${en}`);
});

Deno.test("추정치는 길이에 단조 증가한다", () => {
  let prev = 0;
  for (const n of [10, 100, 1000, 10000]) {
    const t = estimateTokens("안녕하세요 ".repeat(n / 5));
    assert(t > prev);
    prev = t;
  }
});

Deno.test("§5-2 8000 토큰 경계 판정에 쓸 만한 규모가 나온다", () => {
  // 한글 13000자 정도면 8000 토큰을 넘겨야 한다.
  assert(estimateTokens("가".repeat(13000)) > 8000);
  // 한글 3000자 정도면 넘지 않아야 한다.
  assert(estimateTokens("가".repeat(3000)) < 8000);
});

Deno.test("메시지 배열은 역할 오버헤드를 포함한다", () => {
  const msgs = [
    { role: "system", content: "너는 도우미다" },
    { role: "user", content: "안녕" },
  ];
  assert(
    estimateMessagesTokens(msgs) >
      estimateTokens("너는 도우미다") + estimateTokens("안녕"),
  );
});

Deno.test("raw_input 은 역할이 붙은 평문으로 저장된다", () => {
  assertEquals(
    flattenMessages([{ role: "user", content: "안녕" }, { role: "assistant", content: "네" }]),
    "user: 안녕\nassistant: 네",
  );
});
