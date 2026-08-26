import { type ProviderCall, ProviderError, type ProviderResult } from "./types.ts";

export interface ProviderEndpoint {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * OpenAI 호환 /chat/completions 호출.
 *
 * Groq · Together · Fireworks · 대부분의 외부 고성능 제공자가 같은 규격을 쓴다.
 * 제공자별 SDK 를 붙이지 않는 이유는 사양서 §3 의 "Groq(1차), Fireworks(대안)"
 * 처럼 교체가 전제된 설계이기 때문이다. 교체 비용은 환경변수 한 줄이어야 한다.
 */
export async function callChatCompletions(
  endpoint: ProviderEndpoint,
  call: ProviderCall,
): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);

  try {
    const res = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: call.providerModel,
        messages: call.messages,
        temperature: call.temperature,
        max_tokens: call.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        endpoint.name,
        res.status,
        `${endpoint.name} ${res.status}: ${body.slice(0, 500)}`,
        res.status === 429 || res.status >= 500,
      );
    }

    return parseChatCompletion(endpoint.name, await res.json());
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ProviderError(
        endpoint.name,
        null,
        `${endpoint.name} 타임아웃 (${call.timeoutMs}ms)`,
        true,
      );
    }
    throw new ProviderError(
      endpoint.name,
      null,
      `${endpoint.name} 호출 실패: ${String(err)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 응답 파싱은 순수 함수로 분리해 테스트 가능하게 둔다. */
export function parseChatCompletion(provider: string, json: unknown): ProviderResult {
  const body = json as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = body.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content !== "string") {
    throw new ProviderError(provider, null, `${provider}: 응답에 content 가 없다`, false);
  }

  return {
    output: content,
    inputTokens: numOrNull(body.usage?.prompt_tokens),
    outputTokens: numOrNull(body.usage?.completion_tokens),
    finishReason: choice?.finish_reason ?? null,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 재시도 가능한 실패에 한해 1회만 재시도한다. 두 번째 실패는 진짜 실패로 본다. */
export async function callWithRetry(
  endpoint: ProviderEndpoint,
  call: ProviderCall,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ProviderResult> {
  try {
    return await callChatCompletions(endpoint, call);
  } catch (err) {
    if (err instanceof ProviderError && err.retryable) {
      await sleep(500);
      return await callChatCompletions(endpoint, call);
    }
    throw err;
  }
}
