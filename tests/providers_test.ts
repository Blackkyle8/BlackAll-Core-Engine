import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseChatCompletion } from "../supabase/functions/_shared/providers.ts";
import { ProviderError } from "../supabase/functions/_shared/types.ts";

Deno.test("OpenAI 호환 응답을 파싱한다", () => {
  const r = parseChatCompletion("groq", {
    choices: [{ message: { content: "답변" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
  });
  assertEquals(r.output, "답변");
  assertEquals(r.inputTokens, 11);
  assertEquals(r.outputTokens, 22);
  assertEquals(r.finishReason, "stop");
});

Deno.test("usage 가 없으면 null 로 두고 상위에서 추정하게 한다", () => {
  const r = parseChatCompletion("groq", {
    choices: [{ message: { content: "답변" } }],
  });
  assertEquals(r.inputTokens, null);
  assertEquals(r.outputTokens, null);
  assertEquals(r.finishReason, null);
});

Deno.test("content 가 없는 응답은 제공자 오류로 취급한다", () => {
  assertThrows(
    () => parseChatCompletion("groq", { choices: [{}] }),
    ProviderError,
  );
  assertThrows(() => parseChatCompletion("groq", {}), ProviderError);
});

Deno.test("빈 문자열 content 는 유효한 응답이다", () => {
  const r = parseChatCompletion("groq", { choices: [{ message: { content: "" } }] });
  assertEquals(r.output, "");
});
