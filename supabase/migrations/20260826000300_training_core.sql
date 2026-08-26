-- =============================================================================
-- 0300 · training 스키마 핵심 테이블
-- 사양서 §4-2, §5-1, §8 2주차
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 게이트웨이 설정 (§5-3)
--   자체 모델 비중 상한과 탐색 비율 하한은 "설정값으로 노출하되 기본값을 넘길 수 없다".
--   환경변수만으로 두면 사람이 바꿀 수 있으므로 DB 제약으로 이중 고정한다.
-- ---------------------------------------------------------------------------
create table if not exists training.gateway_config (
  key        text primary key,
  value      numeric     not null,
  updated_at timestamptz not null default now(),
  notes      text
);

create or replace function training.assert_gateway_config()
returns trigger
language plpgsql
as $$
begin
  if new.key = 'self_model_max_ratio' and (new.value < 0 or new.value > 0.75) then
    raise exception
      'CONFIG_OUT_OF_BOUNDS: self_model_max_ratio 는 0 이상 0.75 이하여야 한다 (사양서 §5-3 자체 모델 비중 상한 75%%). 요청값=%', new.value
      using errcode = 'check_violation';
  end if;

  if new.key = 'explore_ratio_floor' and (new.value < 0.05 or new.value > 1) then
    raise exception
      'CONFIG_OUT_OF_BOUNDS: explore_ratio_floor 는 0.05 이상이어야 한다 (사양서 §5-3 탐색 비율 하한 5%%). 요청값=%', new.value
      using errcode = 'check_violation';
  end if;

  if new.key = 'usd_krw_rate' and new.value <= 0 then
    raise exception 'CONFIG_OUT_OF_BOUNDS: usd_krw_rate 는 양수여야 한다. 요청값=%', new.value
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_assert_gateway_config on training.gateway_config;
create trigger trg_assert_gateway_config
  before insert or update on training.gateway_config
  for each row execute function training.assert_gateway_config();

-- ---------------------------------------------------------------------------
-- API 키 (§5-1 1단계 인증 확인)
--   원문 키는 저장하지 않는다. sha256 해시만 저장한다.
-- ---------------------------------------------------------------------------
create table if not exists training.api_keys (
  id                 uuid primary key default gen_random_uuid(),
  key_hash           text        not null unique,   -- sha256(hex) of the raw key
  key_prefix         text        not null,          -- 식별용 앞 8자 (예: 'ba_live_')
  user_id            uuid        not null,
  name               text,
  rate_limit_per_min int         not null default 60 check (rate_limit_per_min > 0),
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);

create index if not exists idx_api_keys_active
  on training.api_keys (key_hash) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- requests — 모든 호출 기록 (§4-2)
--
--   §5-1 흐름상 이 행은 "라우팅 결정 전"에 먼저 삽입된다. 제공자 호출이 터져도
--   기록이 남아야 하기 때문이다 (§8 2주차 완료 조건: 모든 호출이 requests 에 기록됨).
--   따라서 routed_to / model_id / latency_ms 는 삽입 시점에 null 이고 이후 UPDATE 된다.
-- ---------------------------------------------------------------------------
create table if not exists training.requests (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  user_id         uuid,
  session_id      uuid,
  api_key_id      uuid references training.api_keys(id) on delete set null,
  raw_input       text        not null,
  input_tokens    int         not null default 0 check (input_tokens >= 0),
  task_type       text        not null default 'unclassified',
  task_confidence real,
  routed_to       text        check (routed_to in ('self', 'open', 'external')),
  model_id        text        references training.models(model_id),
  latency_ms      int         check (latency_ms >= 0),

  -- 사양서에 없는 운영 필수 컬럼 (docs/decisions/0002 참조)
  explored        boolean     not null default false,  -- §5-1 4단계 탐색 당첨 여부
  routing_reason  text,                                -- 어떤 규칙이 이 라우팅을 만들었는가
  fallback_from   text        check (fallback_from in ('self', 'open', 'external')),
  status          text        not null default 'pending'
                              check (status in ('pending', 'ok', 'error')),
  error_code      text
);

create index if not exists idx_requests_created_at    on training.requests (created_at desc);
create index if not exists idx_requests_task_type     on training.requests (task_type, created_at desc);
create index if not exists idx_requests_routed_to     on training.requests (routed_to, created_at desc);
create index if not exists idx_requests_user          on training.requests (user_id, created_at desc);
create index if not exists idx_requests_status_stuck  on training.requests (created_at) where status = 'pending';

comment on table training.requests is
  '게이트웨이를 통과한 모든 호출. 입력은 자사/고객 소유이므로 라우팅 대상과 무관하게 training 에 남는다. 사양서 §4-2';
comment on column training.requests.explored is
  '§5-1 4단계 탐색 비율에 당첨되어 강제 외부 라우팅된 호출. 승격 판정 통계에서 분리해야 하므로 필수.';

-- ---------------------------------------------------------------------------
-- responses — 학습 가능 출력만 (§4-2 + §2-1)
--
--   사양서 §4-2 는 responses 를 training 스키마에 두지만, §2-1 은 외부 상용 API
--   출력의 학습 파이프라인 유입을 절대 금지한다. 두 조항이 충돌한다.
--   해결: 출력은 계층에 따라 물리적으로 분리한다.
--     training.responses  ← self / open (Apache-2.0·MIT) 출력만
--     reference.responses ← external 출력 (학습 롤 접근 불가)
--   requests 는 분리하지 않는다. 입력은 우리 자산이므로 오염원이 아니다.
--   상세: docs/decisions/0001-response-split.md
-- ---------------------------------------------------------------------------
create table if not exists training.responses (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid        not null references training.requests(id) on delete cascade,
  created_at    timestamptz not null default now(),
  output        text        not null,
  output_tokens int         not null default 0 check (output_tokens >= 0),
  model_id      text        not null references training.models(model_id),
  cost_krw      numeric(14,4) not null default 0 check (cost_krw >= 0),
  is_shadow     boolean     not null default false,
  finish_reason text
);

create index if not exists idx_responses_request on training.responses (request_id);
create index if not exists idx_responses_created on training.responses (created_at desc);
create index if not exists idx_responses_model   on training.responses (model_id, created_at desc);

comment on table training.responses is
  '학습에 사용 가능한 출력만. training_safe=false 모델의 출력은 트리거가 물리적으로 거부한다. 사양서 §2-1';

-- ---------------------------------------------------------------------------
-- 오염 차단 트리거 — 사양서 §2-1 의 실제 강제 지점
-- ---------------------------------------------------------------------------
create or replace function training.assert_trainable_response()
returns trigger
language plpgsql
as $$
declare
  m record;
begin
  select model_id, tier, license, training_safe
    into m
    from training.models
   where model_id = new.model_id;

  if not found then
    raise exception
      'UNKNOWN_MODEL: training.responses 에는 training.models 에 등록된 모델의 출력만 넣을 수 있다 (model_id=%).', new.model_id
      using errcode = 'foreign_key_violation';
  end if;

  if not m.training_safe then
    raise exception
      'TRAINING_CONTAMINATION_BLOCKED: model_id=% (tier=%, license=%) 의 출력은 학습 스키마에 들어갈 수 없다. reference.responses 를 사용할 것. 사양서 §2-1',
      m.model_id, m.tier, m.license
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_assert_trainable_response on training.responses;
create trigger trg_assert_trainable_response
  before insert or update on training.responses
  for each row execute function training.assert_trainable_response();

-- ---------------------------------------------------------------------------
-- message_feedback — 선호 최적화 학습용 (§4-2)
-- ---------------------------------------------------------------------------
create table if not exists training.message_feedback (
  id             uuid primary key default gen_random_uuid(),
  response_id    uuid        not null references training.responses(id) on delete cascade,
  rating         smallint    not null check (rating in (-1, 0, 1)),
  corrected_text text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_feedback_response on training.message_feedback (response_id);

-- ---------------------------------------------------------------------------
-- verifiable_outcomes — 검증가능 보상 강화학습용 (§4-2)
--   요청 단위 채점이므로 외부 라우팅 여부와 무관하게 training 에 둔다.
-- ---------------------------------------------------------------------------
create table if not exists training.verifiable_outcomes (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid        not null references training.requests(id) on delete cascade,
  rule_id    text        not null,
  expected   jsonb,
  actual     jsonb,
  passed     boolean     not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_outcomes_request on training.verifiable_outcomes (request_id);
create index if not exists idx_outcomes_rule    on training.verifiable_outcomes (rule_id, created_at desc);
