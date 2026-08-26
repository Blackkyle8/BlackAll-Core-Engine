import { type ApiKeyRow, GatewayError } from "./types.ts";

/** 저장되는 값은 원문 키가 아니라 sha256 16진 해시다. */
export async function hashApiKey(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function extractBearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new GatewayError(
      401,
      "missing_api_key",
      "Authorization: Bearer <api_key> 헤더가 필요하다.",
    );
  }
  return match[1].trim();
}

export interface KeyLookup {
  (hash: string): Promise<ApiKeyRow | null>;
}

export async function authenticate(req: Request, lookup: KeyLookup): Promise<ApiKeyRow> {
  const raw = extractBearer(req);
  const row = await lookup(await hashApiKey(raw));
  if (!row) {
    throw new GatewayError(401, "invalid_api_key", "유효하지 않거나 폐기된 API 키다.");
  }
  return row;
}

/** 게이트웨이가 발급하는 키 형식. 앞 12자는 식별용으로 평문 보관한다. */
export function keyPrefix(raw: string): string {
  return raw.slice(0, 12);
}
