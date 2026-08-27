# 실행 절차 — 1·2주차

이 문서의 순서대로 하면 §8 1주차·2주차 완료 조건까지 도달한다.
코드는 이미 저장소에 있다. 남은 것은 계정 개설과 배포다.

---

## 0. 사람이 해야 하는 일 (코드로 대신할 수 없음)

- [ ] Groq 계정 개설 — console.groq.com, API 키 발급
- [ ] Together AI 계정 개설 (4~6개월차에 필요, 지금 열어둬도 무방)
- [ ] Cloudflare R2 버킷 생성 + S3 호환 키 발급
- [ ] Hugging Face 토큰 발급
- [ ] Supabase **신규** 프로젝트 생성 (기존 프로젝트 재사용 금지 — §3)
- [ ] MCP 연결: GitHub / Hugging Face / Cloudflare

> **§12 게이트**: 미결 사항 1(엔지니어 배정)과 2(이 서비스가 무엇을 하는 제품인지)가
> 확정되기 전에는 3주차 이후로 넘어가지 않는다. 2주차까지는 어느 제품이 되든
> 버려지지 않는 기반이라 먼저 만들어도 손실이 없다. 3주차의 검색 계층과 분류기는
> 제품이 정해지지 않으면 무엇을 색인하고 무엇으로 분류할지 정의할 수 없다.

---

## 1. 로컬에서 먼저 확인 (계정 없이 가능)

순정 PostgreSQL 만 있으면 1주차 완료 조건을 그대로 재현할 수 있다.

```bash
# PostgreSQL 16 로컬 인스턴스가 127.0.0.1:55432 에 떠 있다고 가정
./scripts/local-verify.sh
```

세 검증이 전부 통과해야 한다.

```
PASS[0..6]  학습 롤의 reference 격리          ← §10 1주차 사망 조건
PASS[1..3]  오염 차단 트리거                  ← §2-1
PASS[1..10] 모델·라우팅 정책                  ← §2-2, §5-3
```

게이트웨이 로직도 계정 없이 검증된다.

```bash
deno test tests/        # 52 tests
deno check supabase/functions/gateway/index.ts
deno lint supabase/functions tests
```

---

## 2. Supabase 프로젝트 준비

```bash
export ADMIN_DATABASE_URL="postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres"

DATABASE_URL="$ADMIN_DATABASE_URL" ./scripts/run-migrations.sh
```

`20260826000150_pgvector.sql` 이 SKIP 으로 뜨면 안 된다. Supabase 에는 pgvector 가
있으므로 APPLY 여야 한다. SKIP 이면 프로젝트 설정을 확인할 것.

롤 비밀번호를 설정한다.

```bash
psql "$ADMIN_DATABASE_URL" \
  -v gw_pw="$(openssl rand -hex 24)" \
  -v tp_pw="$(openssl rand -hex 24)" \
  -v an_pw="$(openssl rand -hex 24)" \
  -f scripts/set-role-passwords.sql
```

세 연결 문자열을 만들어 보관한다. 형태는 아래와 같다.

```
GATEWAY_DATABASE_URL=postgres://gateway_writer:<gw_pw>@db.<ref>.supabase.co:6543/postgres
TRAINING_DATABASE_URL=postgres://training_pipeline:<tp_pw>@db.<ref>.supabase.co:5432/postgres
ANALYTICS_DATABASE_URL=postgres://analytics_reader:<an_pw>@db.<ref>.supabase.co:5432/postgres
```

게이트웨이는 6543(트랜잭션 모드 풀러)을 쓴다. Edge Function 은 수명이 짧아
세션 풀러를 쓰면 커넥션이 남는다.

---

## 3. §8 1주차 완료 조건 확인

```bash
export ADMIN_DATABASE_URL=... GATEWAY_DATABASE_URL=... TRAINING_DATABASE_URL=...
./scripts/verify-all.sh
```

`PASS[2a]` 가 뜨면 1주차 완료 조건이 충족된 것이다.
하나라도 FAIL 이면 **데이터 수집을 시작하지 않는다** (§10).

---

## 4. 모델 라이선스 확인 후 학습 유입 열기

시드 상태에서는 **모든 모델이 `training_safe = false`** 다.
즉 이 시점의 게이트웨이는 오픈모델 출력조차 학습 스키마에 쌓지 않는다.
의도된 동작이다 — 라이선스를 확인하기 전에는 닫혀 있어야 한다.

1. `docs/licenses/README.md` 의 절차대로 모델 카드 원문을 확인하고 사본을 커밋한다.
2. 연다.

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v model_id="open/gpt-oss-20b" \
  -v license="Apache-2.0" \
  -v license_url="https://huggingface.co/openai/gpt-oss-20b" \
  -f scripts/verify-model-license.sql
```

Qwen 을 쓸 거라면 **크기·세대별로 라이선스가 갈린다**(§2-2, §12 미결 3).
`open/qwen3-32b` 시드 행의 `license` 값은 확인 전까지 신뢰하지 말 것.

---

## 5. 단가 입력 (§11 예산 감시용)

시드 단가는 0 이다. 추측값을 넣지 않았기 때문이다.
Groq 콘솔에서 실측 단가를 확인해 입력한다.

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v model_id="open/gpt-oss-20b" \
  -v input_usd=<실측> -v output_usd=<실측> \
  -f scripts/set-model-pricing.sql
```

입력 전까지 `ops.metric_unverified_models` 에 계속 뜨고,
게이트웨이 로그의 `cost_estimated` 가 true 로 남는다.

---

## 6. 게이트웨이 배포

Edge Function 환경변수를 설정한다 (`.env.example` 참조).
최소 세트는 다음과 같다.

```
GATEWAY_DATABASE_URL
GROQ_API_KEY
EXTERNAL_LLM_API_KEY
EXTERNAL_LLM_BASE_URL
EXTERNAL_LLM_MODEL
```

배포한다.

```bash
supabase functions deploy gateway --project-ref <ref> --no-verify-jwt
```

`--no-verify-jwt` 인 이유는 고객이 Supabase JWT 가 아니라 **우리 API 키**로
인증하기 때문이다. 인증은 `training.api_keys` 에서 처리한다.

---

## 7. 키 발급 후 §8 2주차 완료 조건 확인

```bash
ADMIN_DATABASE_URL=... ./scripts/create-api-key.sh "내부 테스트"
```

출력된 키로 호출한다.

```bash
curl -sS "$GATEWAY_URL/gateway/v1/chat/completions" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"안녕"}]}' -i
```

확인할 것:

- 응답 본문이 OpenAI 호환 `chat.completion` 형식인가
- `x-blackall-routed-to` 헤더가 `open` 인가
- `x-blackall-routing-reason` 이 `default_open` 인가
- DB 에 기록이 남았는가

```sql
select id, routed_to, model_id, routing_reason, explored, status, latency_ms
  from training.requests order by created_at desc limit 5;
```

긴 입력(한글 15,000자 정도)으로 한 번 더 호출해 `routed_to = 'external'`,
`routing_reason = 'long_context'` 가 나오면 §5-2 라우팅이 살아 있는 것이다.

20번쯤 호출하면 그중 한 건쯤은 `explored = true` 로 외부에 갈 것이다(탐색 5%).
그 건의 응답은 `reference.responses` 에만 있어야 한다.

```sql
-- 이 쿼리 결과가 0 이어야 한다. 아니면 §2-1 이 깨진 것이다.
select count(*)
  from training.responses r
  join training.models m using (model_id)
 where not m.training_safe;
```

---

## 8. 여기서 멈춘다

§12 의 미결 1·2 가 확정될 때까지 3주차(검색 계층·분류기)로 넘어가지 않는다.
그동안 게이트웨이는 트래픽을 계속 기록하므로, 3개월차 §10 판정
("질문 유형 20개 이내 수렴")에 필요한 원문은 그대로 쌓인다.

```sql
-- 3개월차 판정용 (아직 분류기가 없으므로 전부 unclassified 다)
select * from ops.metric_task_type_distribution;
select * from ops.metric_capture_integrity limit 7;
select * from ops.metric_monthly_cost;
```
