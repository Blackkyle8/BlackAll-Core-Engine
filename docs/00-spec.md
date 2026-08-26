# 자체 범용 LLM 게이트웨이 — 구축 사양서

> 원본 핸드오프 문서. 코드 주석의 §번호는 전부 이 문서를 가리킨다.
> 작성 기준일: 2026-08-26

---

## 0. 한 줄 정의

**모든 LLM 호출이 통과하는 자체 게이트웨이를 만들고, 그 트래픽 로그로 자체 모델을 학습시켜 자체 처리 비중을 점진적으로 끌어올린다.**

---

## 1. 확정 제약 (변경 금지)

| 항목 | 값 |
|---|---|
| 예산 상한 | **월 10만원 (인프라)** — 초과 설계 금지 |
| 프론티어 자체 학습 | **배제** (2,800억~7,000억원 규모, 조달 없이 불가) |
| 중형 자체 학습 | **보류** (50억~150억원, 별도 조달 시에만) |
| 채택 경로 | **오픈모델 + 자체 부분학습(LoRA)** |
| 인력 | 엔지니어 1명 |
| 최종 산출물 소유권 | **100% 자사 · 재판매 가능해야 함** |

---

## 2. 절대 금지 사항 (위반 시 전체 자산 폐기)

### 2-1. 학습 데이터 오염 금지

다음 출력물은 **학습 파이프라인에 절대 유입 금지**:

- OpenAI(GPT) API 출력
- Anthropic(Claude) API 출력
- Google(Gemini) API 출력
- 기타 폐쇄형 상용 API 출력
- 라이선스 데이터 (MSCI, S&P, CoinDesk 등 유료 구독 데이터)

**이유**: 해당 사업자 이용약관이 출력물의 모델 학습 사용을 금지. 위반 시 재판매·매각 불가, 실사에서 전량 폐기 대상.

**강제 방법 — 사람 규율 아닌 권한 차단으로 구현**:

```
training_*   스키마 → 자체 생성물 · 오픈모델(Apache 2.0/MIT) 출력만 INSERT 허용
reference_*  스키마 → 외부 상용 API · 라이선스 데이터. 학습 파이프라인 계정에 SELECT 권한 미부여
```

학습 스크립트가 사용하는 DB 롤은 `reference_*`에 접근 권한이 없어야 한다.

### 2-2. 기본 모델 라이선스 제약

| 사용 | 모델 | 라이선스 |
|---|---|---|
| ✅ 허용 | Qwen3 계열 (크기별 확인 필수), gpt-oss 20B/120B, DeepSeek R1 distill, GLM, Mistral Small | Apache 2.0 / MIT |
| ❌ 금지 | Llama 전 계열 | 파생물 동일 라이선스 승계 의무 + 7억 MAU 상한 + EU 멀티모달 제외 |
| ❌ 금지 | Gemma 전 계열 | 구글 철회권 + 경쟁 파운데이션 모델 학습 금지 조항 |

**착수 전 필수**: Hugging Face에서 사용할 정확한 모델 카드의 라이선스 원문 확인 후 사본 보관. Qwen은 크기·세대별로 Apache 2.0 / 커스텀 / 비상용 연구용이 갈림.

---

## 3. 기술 스택 확정

| 계층 | 채택 | 근거 |
|---|---|---|
| 프론트엔드 | Vercel (BlackWall 팀, Pro) | 기존 |
| 게이트웨이 API | Vercel Edge Function 또는 Supabase Edge Function | 저지연 |
| DB · 인증 | Supabase Postgres (**신규 프로젝트**) | pgvector 무료 포함 |
| 벡터 검색 | pgvector 0.8.0 (HNSW) | Supabase 내장 |
| 스케줄러 | pg_cron (설치됨) | 별도 인프라 불필요 |
| 대용량 보관 | Cloudflare R2 | egress 0원, 10GB 무료 |
| 추론 서빙 | Groq (1차), Fireworks (대안) | 최고속 + 최저가 |
| 학습 실행 | Together AI (1차) → RunPod (2차) | 가중치 다운로드 가능 |
| 가중치 보관 | R2 + Hugging Face 비공개 저장소 | 3중 백업 |

### 연결해야 할 MCP

- [x] Supabase — 연결·검증 완료
- [x] Vercel — 연결·검증 완료 (BlackWall, Pro)
- [ ] **GitHub** — 코드 저장소
- [ ] **Hugging Face** — 모델·라이선스 확인, 가중치 보관
- [ ] **Cloudflare** — R2 버킷 관리

### 개설해야 할 API 계정 (MCP 불필요)

- [ ] Groq (console.groq.com)
- [ ] Together AI
- [ ] Cloudflare R2 (S3 호환 키)

---

## 4. 데이터베이스 스키마

### 4-1. 스키마 분리

```sql
create schema training;   -- 학습 가능 데이터
create schema reference;  -- 학습 불가 참조 데이터
create extension if not exists vector;
```

### 4-2. 핵심 테이블 (training 스키마)

**requests** — 모든 호출 기록

```
id              uuid pk
created_at      timestamptz
user_id         uuid
session_id      uuid
raw_input       text
input_tokens    int
task_type       text        -- 자동 분류 결과 (4-4 참조)
task_confidence float
routed_to       text        -- 'self' | 'open' | 'external'
model_id        text        -- 실제 사용된 모델 식별자
latency_ms      int
```

**responses**

```
id              uuid pk
request_id      uuid fk
created_at      timestamptz
output          text
output_tokens   int
model_id        text
cost_krw        numeric
is_shadow       boolean default false
```

**shadow_runs** — 그림자 실행 비교 (승격 판정의 근거)

```
id              uuid pk
request_id      uuid fk
self_response_id uuid fk
base_response_id uuid fk
similarity      float       -- 0~1
verdict         text        -- 'pass' | 'fail'
evaluated_at    timestamptz
evaluator       text        -- 'auto' | 'human'
```

**routing_rules** — 유형별 현재 라우팅 대상

```
task_type       text pk
current_target  text        -- 'self' | 'open' | 'external'
promoted_at     timestamptz
sample_count    int
pass_rate_3w    float
explore_ratio   float default 0.05
```

**model_versions** — 자체 모델 이력

```
id              uuid pk
version         text
base_model      text        -- 정확한 HF 모델 ID
base_license    text
lora_rank       int
train_snapshot_id uuid fk
weights_uri     text        -- R2 경로
created_at      timestamptz
status          text        -- 'training' | 'shadow' | 'active' | 'retired'
```

**training_snapshots** — 학습에 쓴 표본 버전 (재현성·실사 증빙)

```
id              uuid pk
created_at      timestamptz
sample_count    int
source_filter   jsonb
manifest_uri    text        -- R2 경로
```

**message_feedback** — 선호 최적화 학습용

```
id              uuid pk
response_id     uuid fk
rating          smallint    -- -1 | 0 | 1
corrected_text  text
created_at      timestamptz
```

**verifiable_outcomes** — 검증가능 보상 강화학습용

```
id              uuid pk
request_id      uuid fk
rule_id         text
expected        jsonb
actual          jsonb
passed          boolean
```

### 4-3. 참조 테이블 (reference 스키마)

**documents / doc_chunks** — 검색 계층

```
documents:  id, title, source, license, ingested_at
doc_chunks: id, document_id fk, chunk_text, embedding vector(1536)
```

HNSW 인덱스 생성. `license` 필드에 학습 사용 가부를 명시하고, training 파이프라인은 이 스키마 자체에 접근 불가.

### 4-4. 질문 유형 분류

초기 유형 집합은 **하드코딩하지 말 것**. 3개월 축적 후 실측 분포로 결정.
초기에는 `task_type = 'unclassified'`로 두고 원문만 저장. 분류기는 4주차에 추가.

---

## 5. 게이트웨이 동작 사양

### 5-1. 요청 처리 흐름

```
1. 인증 확인
2. requests 행 삽입 (raw_input, task_type)
3. routing_rules 조회 → 대상 결정
4. 탐색 비율 적용: explore_ratio 확률로 강제 외부 라우팅
5. 대상 모델 호출
6. responses 행 삽입
7. (자체 모델 존재 시) 그림자 실행 비동기 큐 투입
8. 응답 반환
```

### 5-2. 라우팅 규칙

| 조건 | 대상 |
|---|---|
| `routing_rules.current_target = 'self'` 이고 탐색 미당첨 | 자체 모델 |
| `task_type = 'unclassified'` | 외부 고성능 |
| 입력 토큰 > 8000 | 외부 고성능 (긴 컨텍스트) |
| 그 외 | 오픈모델 기본 |

### 5-3. 자체 모델 비중 상한

```
자체 모델 라우팅 비율 상한 = 75%
탐색 비율 하한 = 5% (승격된 유형에도 상시 적용)
```

**상한을 두는 이유**: 100%가 되면 신규 유형 학습 원천이 소멸하고, 자기 출력 재학습으로 품질이 열화됨. 상한은 설정값으로 노출하되 기본값 75% 초과 불가.

---

## 6. 그림자 승격 메커니즘

### 6-1. 승격 조건 (3개 전부 충족)

| 항목 | 기준 |
|---|---|
| 그림자 일치율 | 3주 연속 주간 95% 이상 |
| 사람 재작업률 | 10% 미만 |
| 최소 표본 | 해당 유형 200건 이상 |

### 6-2. 강등 조건 (하나라도 해당)

- 승격 후 주간 일치율 90% 미만 2주 연속
- 사람 재작업률 15% 초과

강등 시 `current_target`을 'open'으로 자동 되돌리고 알림.

### 6-3. 구현 위치

pg_cron 주간 잡으로 `shadow_runs` 집계 → `routing_rules` 갱신. **사람 판단 개입 없이 자동 실행되어야 함.** 수동 승인 단계를 넣으면 운영 인건비가 발생해 전체 설계 목적이 무효화됨.

---

## 7. 학습 파이프라인

### 7-1. 실행 주기

분기 1회. pg_cron이 트리거하고, 데이터 부족(신규 표본 1,000건 미만) 시 자동 건너뜀.

### 7-2. 단계

```
1. training_snapshots 생성 — 이번 회차 표본 확정 및 R2 업로드
2. 품질 필터 — 중복 제거, 길이 이상치 제거, 저평가 응답 제외
3. 부족분 합성데이터 증폭 — MIT 라이선스 모델(DeepSeek R1 distill)로만 생성
4. Together AI 업로드 → LoRA SFT 실행
5. 가중치 다운로드 → R2 저장 → model_versions 등록 (status='shadow')
6. 그림자 모드 3주 관측
7. 조건 충족 유형만 승격
```

### 7-3. 학습 설정 기본값

| 항목 | 값 | 근거 |
|---|---|---|
| LoRA rank | 16 | 2026 표준 권장값. Groq 업로드 시 rank가 낮을수록 콜드스타트 짧음 |
| LoRA alpha | 16 | scaling factor 1.0 |
| target_modules | all-linear | 시작점, 검증셋으로 attention-only와 비교 |
| epochs | 3 | 과금은 데이터 토큰 × epochs |
| 정밀도 | 4bit(QLoRA) 또는 bf16 | 메모리 여건에 따라 |

### 7-4. 비용 산정식

```
학습 토큰 = 데이터 토큰 × epochs
비용 = 학습 토큰(백만 단위) × $0.48   (Together, 16B 이하 LoRA SFT)

예: 표본 1만 건 × 4,000토큰 = 4,000만 토큰
    × 3 epochs = 1억 2,000만 토큰
    × $0.48/M = $57.6 ≈ 8만원 (1회)
    시행착오 배수 ×10~20 → 1년차 80만~160만원
```

---

## 8. 구현 순서 및 완료 조건

### 1주차 — 기반

- [ ] MCP 3개 연결 (GitHub, Hugging Face, Cloudflare)
- [ ] 신규 Supabase 프로젝트 생성
- [ ] `training` / `reference` 스키마 분리 + DB 롤 권한 차단
- [ ] pgvector 설치
- [ ] R2 버킷 생성 + 키 발급
- [ ] Groq 계정 개설 + 기본모델 호출 확인

**완료 조건**: 학습 파이프라인용 DB 롤로 `reference` 스키마 SELECT가 실패해야 함.

### 2주차 — 게이트웨이

- [ ] 인증 + requests/responses 테이블
- [ ] 오픈모델 호출 (gpt-oss 20B)
- [ ] 외부 고성능 폴백 경로
- [ ] 기본 라우팅 (입력 길이 기준만)

**완료 조건**: 고객이 우리 API 주소 하나만 호출해도 응답이 나오고, 모든 호출이 requests에 기록됨.

### 3주차 — 검색 계층 + 분류

- [ ] documents / doc_chunks + HNSW 인덱스
- [ ] 임베딩 생성 파이프라인
- [ ] 검색 결과를 프롬프트에 주입
- [ ] task_type 자동 분류기

**완료 조건**: 참고자료가 필요한 질문에서 검색 결과가 응답에 반영됨.

### 4주차 — 관측

- [ ] 유형별 트래픽 분포 대시보드
- [ ] 비용 집계 (일/월)
- [ ] 지연 시간 모니터링

**완료 조건**: "어떤 유형이 몇 % 인지"를 한 화면에서 확인 가능.

### 3개월차 — 판정 후 진행

유형 분포 실측 결과로 다음을 결정:

- 유형이 20개 이내로 수렴 → 그림자 승격 메커니즘 구축 진행
- 유형이 100개 이상 흩어짐 → **자체 학습 폐기**, 오픈모델 + 검색 계층만 운영

### 4~6개월차 — 학습 (위 판정 통과 시에만)

- [ ] shadow_runs / routing_rules / model_versions / training_snapshots
- [ ] 1차 LoRA 학습
- [ ] 그림자 3주 관측
- [ ] 첫 유형 승격

---

## 9. 환경변수

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_TRAINING_ROLE_KEY      # reference 스키마 접근 불가 롤
GROQ_API_KEY
TOGETHER_API_KEY
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
HF_TOKEN
EXTERNAL_LLM_API_KEY            # 외부 고성능 폴백용
SELF_MODEL_MAX_RATIO=0.75
EXPLORE_RATIO=0.05
```

---

## 10. 판정 지표 (사망 조건)

| 시점 | 지표 | 미달 시 조치 |
|---|---|---|
| 1주차 | training 롤이 reference 접근 차단됨 | 미달 시 데이터 수집 중단 |
| 4주차 | 게이트웨이 통과 호출 100% 기록 | 미달 시 복리 회로 불성립 — 재작업 |
| 3개월 | 질문 유형 20개 이내 수렴 | 미달 시 자체 학습 폐기 |
| 6개월 | 승격된 유형 1개 이상 | 미달 시 그림자 승격 폐기 |
| 12개월 | 자체 모델 트래픽 50% 이상 | 미달 시 학습 계층 동결 |

**각 지표는 자동 산출되어야 하며, 사람이 매번 확인하는 구조면 실패로 간주한다.**

---

## 11. 월 비용 예산

| 항목 | 월 |
|---|---|
| Supabase Pro | 3.5만원 |
| Vercel | 0원 (기존 팀) |
| Cloudflare R2 | 0원 (10GB 무료 한도) |
| GitHub / Hugging Face | 0원 |
| Groq 추론 | 사용량 비례 (1건당 0.19~0.74원) |
| Together 학습 | 분기 1회 월분할 1만~5만원 |
| **합계** | **5만~9만원** |

**월 10만원 초과 설계는 반려 대상.**

---

## 12. 미결 사항 (착수 전 확정 필요)

1. **엔지니어 1명 배정 출처** — 미지정
2. **이 서비스가 무엇을 하는 제품인지** — 미확정. 유형 수렴 가능성 판정에 직결
3. Qwen 계열 중 정확히 어느 모델·크기를 기본모델로 쓸지 — 라이선스 확인 후 결정
4. 기존 3개 사업 데이터 이관 가능 여부 (규제·계약 검토)

**1번과 2번이 확정되기 전에는 2주차 이후로 진행하지 말 것.**
