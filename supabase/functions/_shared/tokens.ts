// 토큰 수 추정.
//
// 이 값은 어디까지나 "제공자 호출 전"에 필요한 임시값이다. 사양서 §5-1 흐름상
// requests 행은 호출 전에 삽입되어야 하고, §5-2 의 8000 토큰 라우팅 판정도
// 호출 전에 내려야 한다.
//
// 제공자가 usage 를 돌려주면 그 값으로 즉시 덮어쓴다 (db.finalizeRequest).
// 따라서 이 함수의 오차는 라우팅 경계 근처에서만 의미가 있다.

const CJK = /[ㄱ-ㆎ가-힣぀-ヿ一-鿿]/;

/**
 * 한글/CJK 는 라틴 문자보다 문자당 토큰 수가 훨씬 많다.
 * BPE 계열 토크나이저 기준 대략:
 *   라틴  ~4자/토큰
 *   한글  ~1.5자/토큰
 *   기타  ~3자/토큰
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else if (/[A-Za-z0-9\s.,!?'"()\[\]{}:;/\\-]/.test(ch)) latin++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + latin / 4 + other / 3);
}

export function estimateMessagesTokens(
  messages: { role: string; content: string }[],
): number {
  // 메시지당 역할 토큰 오버헤드 ~4
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + 4,
    0,
  );
}

/** requests.raw_input 에 저장할 정규화 문자열. */
export function flattenMessages(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}
