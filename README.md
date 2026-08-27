# BlackAll Core Engine — 자체 범용 LLM 게이트웨이

> 모든 LLM 호출이 통과하는 자체 게이트웨이를 만들고, 그 트래픽 로그로 자체 모델을
> 학습시켜 자체 처리 비중을 점진적으로 끌어올린다.

사양서 원문: [`docs/00-spec.md`](docs/00-spec.md). 코드 주석의 §번호는 전부 그 문서를 가리킨다.

현재 범위: **§8 1주차(기반) · 2주차(게이트웨이)**.
3주차 이후는 §12 미결 사항 1·2 가 확정된 뒤에 시작한다.

---

## 이 저장소의 한 가지 전제

> §2-1 "강제 방법 — 사람 규율 아닌 권한 차단으로 구현"

학습 데이터 오염 금지는 코드 리뷰나 문서로 지킬 수 없다. 지켜지지 않았을 때
비용이 사업 전체(재판매·매각 불가)이기 때문이다. 그래서 이 저장소의 모든 금지는
**실행하면 실패하는 형태**로 구현되어 있다.

| 금지 | 강제 지점 | 실패 방식 |
|---|---|---|
| 외부 상용 API 출력의 학습 유입 (§2-1) | `training.responses` BEFORE INSERT 트리거 | `TRAINING_CONTAMINATION_BLOCKED` |
| 학습 롤의 reference 접근 (§2-1) | GRANT 미부여 + USAGE 미부여 | `permission denied for schema reference` |
| Llama · Gemma 계열 사용 (§2-2) | `training.models` 정책 트리거 | `BLOCKED_MODEL_FAMILY` |
| 라이선스 미확인 모델의 학습 유입 (§2-2) | 같은 트리거 | `LICENSE_UNVERIFIED` |
| 자체 모델 비중 75% 초과 (§5-3) | DB CHECK + 설정 로더 + 환경변수 3중 | `CONFIG_OUT_OF_BOUNDS` |
| 탐색 비율 5% 미만 (§5-3) | DB CHECK | `CONFIG_OUT_OF_BOUNDS` |
| 근거 없는 자체 모델 승격 (§6-1) | `routing_rules` CHECK | `check_violation` |

전부 자동 검증된다.

```bash
./scripts/local-verify.sh    # 순정 PostgreSQL 에서 전 항목 재현
```

---

## 구조

```
supabase/
  migrations/           스키마 · 롤 · 트리거 · 지표 뷰
  functions/
    gateway/index.ts    Deno.serve 진입점 (환경변수·배선만)
    _shared/            로직. 순수 함수 위주로 분리해 계정 없이 테스트된다
      routing.ts        §5-2 라우팅 판정 (순수 함수)
      handler.ts        §5-1 요청 처리 흐름
      providers.ts      OpenAI 호환 제공자 호출
      postgres-db.ts    gateway_writer 롤 직접 연결
scripts/                마이그레이션 · 검증 · 키 발급 · 라이선스 승격
tests/                  52 tests (Deno)
docs/
  00-spec.md            사양서 원문
  02-runbook.md         1·2주차 실행 절차
  decisions/            사양서와 다르게 구현한 지점과 그 이유
```

### 3개 스키마

| 스키마 | 담는 것 | 학습 롤 |
|---|---|---|
| `training` | 요청 원문, 자체·오픈모델 출력, 피드백, 라우팅 규칙, 모델 레지스트리 | 읽기 |
| `reference` | 외부 상용 API 출력, (3주차) 라이선스 문서 | **접근 불가** |
| `ops` | 판정 지표 뷰 (§10) | **접근 불가** |

`ops` 가 학습 롤에게 막혀 있는 이유: 지표 뷰가 `reference` 를 참조하고,
뷰는 소유자 권한으로 실행되므로 그대로 우회 통로가 된다.

### 3개 롤

| 롤 | 용도 |
|---|---|
| `gateway_writer` | 게이트웨이 런타임. 양쪽 스키마에 기록. |
| `training_pipeline` | 학습 파이프라인. `training` 읽기 전용. |
| `analytics_reader` | 대시보드. `ops` 읽기 전용. |

`service_role` 키는 런타임에 쓰지 않는다 — 그 키는 권한 검사를 우회하므로
쓰는 순간 위 표가 전부 무의미해진다. → [`docs/decisions/0003-no-service-role.md`](docs/decisions/0003-no-service-role.md)

---

## API

고객은 주소 하나만 호출한다. OpenAI 호환이라 기존 SDK 를 그대로 쓴다.

```
POST /gateway/v1/chat/completions
POST /gateway/v1/feedback
GET  /gateway/health
```

```bash
curl -sS "$GATEWAY_URL/gateway/v1/chat/completions" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"안녕"}]}'
```

응답 헤더에 라우팅 근거가 실린다.

```
x-blackall-request-id      요청 식별자
x-blackall-routed-to       self | open | external
x-blackall-routing-reason  왜 그리로 갔는가
x-blackall-explored        탐색 당첨 여부 (§5-1 4단계)
x-blackall-cost-krw        이번 호출 비용
```

### 라우팅 (§5-2)

앞선 규칙이 이긴다.

1. 입력 토큰 > 8000 → **외부 고성능** (긴 컨텍스트)
2. 탐색 비율 당첨 → **외부 고성능** (`explored = true`)
3. `unclassified` + 스위치 ON → **외부 고성능** — *2주차에는 스위치 OFF*
4. 규칙이 `self` → **자체 모델**, 단 §5-3 상한 75% 미만이고 엔드포인트가 있을 때만
5. 규칙이 `external` → **외부 고성능**
6. 그 외 → **오픈모델**

> 3번 스위치를 2주차에 켜면 아직 분류기가 없어 전 트래픽이 `unclassified` 이므로
> **전량이 외부로 간다**. §11 예산이 즉시 무너진다. §8 2주차의 "기본 라우팅
> (입력 길이 기준만)" 지시에 맞춰 꺼두었다. 3주차 분류기 도입 시 켠다.

제공자가 실패하면 `self → open → external` 로 강등하고, 강등 사실을
`requests.fallback_from` 에 남긴다.

---

## 시작하기

```bash
# 1. 계정 없이 전부 검증
./scripts/local-verify.sh
deno test tests/

# 2. Supabase 프로젝트에 적용
DATABASE_URL="$ADMIN_DATABASE_URL" ./scripts/run-migrations.sh
psql "$ADMIN_DATABASE_URL" -v gw_pw=... -v tp_pw=... -v an_pw=... \
  -f scripts/set-role-passwords.sql

# 3. §8 1주차 완료 조건 확인
./scripts/verify-all.sh
```

전체 절차는 [`docs/02-runbook.md`](docs/02-runbook.md).

---

## 지금 닫혀 있는 것 (의도된 상태)

- **모든 모델이 `training_safe = false`** 다. 라이선스 원문을 확인하고
  `docs/licenses/` 에 사본을 커밋한 뒤 `scripts/verify-model-license.sql` 로 연다.
  확인 전에는 오픈모델 출력조차 학습 스키마에 쌓이지 않는다 (§2-2).
- **모든 단가가 0** 이다. 추측값을 넣으면 §11 예산 감시가 거짓 신호를 낸다.
  Groq 콘솔에서 실측 단가를 확인해 `scripts/set-model-pricing.sql` 로 넣는다.
  그때까지 `ops.metric_unverified_models` 에 계속 뜬다.
- **자체 모델 계층은 비활성**이다. `SELF_MODEL_BASE_URL` 이 없으면 승격된 유형도
  오픈모델로 간다. 4~6개월차 산출물이다.
- **그림자 실행 큐는 no-op** 이다. 비교 대상인 자체 모델이 없기 때문이다.
  연결 지점(`HandlerDeps.enqueueShadowRun`)만 열어두었다.

---

## 판정 지표 (§10)

> "각 지표는 자동 산출되어야 하며, 사람이 매번 확인하는 구조면 실패로 간주한다."

| 시점 | 지표 | 산출 위치 |
|---|---|---|
| 1주차 | 학습 롤의 reference 접근 차단 | `scripts/verify-isolation.sql` |
| 4주차 | 게이트웨이 통과 호출 100% 기록 | `ops.metric_capture_integrity` |
| 3개월 | 질문 유형 20개 이내 수렴 | `ops.metric_task_type_convergence` |
| 12개월 | 자체 모델 트래픽 50% 이상 | `ops.metric_self_traffic_share` |
| 상시 | 월 10만원 예산 (§11) | `ops.metric_monthly_cost` |

6개월 지표(승격된 유형 1개 이상)는 `shadow_runs` 가 생기는 4~6개월차에 추가된다.

---

## 사양서와 다르게 구현한 지점

- [`0001`](docs/decisions/0001-response-split.md) — 응답을 계층에 따라 두 스키마로 물리 분리
  (§4-2 와 §2-1 의 충돌 해소)
- [`0002`](docs/decisions/0002-schema-additions.md) — 사양서에 없는 컬럼을 추가한 이유
- [`0003`](docs/decisions/0003-no-service-role.md) — service_role 키를 쓰지 않는 이유

---

## 다음 단계는 사람의 결정에 달려 있다

사양서 §12:

> **1번과 2번이 확정되기 전에는 2주차 이후로 진행하지 말 것.**

1. 엔지니어 1명 배정 출처 — 미지정
2. 이 서비스가 무엇을 하는 제품인지 — 미확정

2번이 특히 중요하다. 3주차의 검색 계층은 "무엇을 색인할 것인가", 분류기는
"무엇으로 분류할 것인가"에 답해야 만들 수 있다. 그리고 §10 의 3개월 판정
("질문 유형 20개 이내 수렴")은 사실상 이 제품 정의가 얼마나 좁은가를 묻는 질문이다.
제품이 정해지지 않은 채 쌓는 트래픽은 그 판정에 쓸 수 없다.
