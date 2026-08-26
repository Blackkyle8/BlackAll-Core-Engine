-- =============================================================================
-- 0400 · reference 스키마 — 학습 불가 데이터
-- 사양서 §2-1, §4-3
--
-- 이 스키마의 어떤 객체에도 training_pipeline / analytics_reader 롤은 접근할 수 없다.
-- (권한 설정은 0600, 검증은 scripts/verify-isolation.sql)
--
-- 3주차 산출물인 documents / doc_chunks 는 여기 없다. 사양서 §12 에 따라
-- 미결 사항 1·2 확정 전에는 2주차 이후로 진행하지 않는다.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- reference.responses — 외부 폐쇄형 상용 API 출력
--   OpenAI / Anthropic / Google 등의 출력은 이용약관상 모델 학습에 사용할 수 없다.
--   품질 비교(그림자 실행)·서비스 응답에는 쓰되, 학습 표본으로는 영원히 배제된다.
-- ---------------------------------------------------------------------------
create table if not exists reference.responses (
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

create index if not exists idx_ref_responses_request on reference.responses (request_id);
create index if not exists idx_ref_responses_created on reference.responses (created_at desc);

comment on table reference.responses is
  '외부 상용 API 출력. 학습 파이프라인 롤이 SELECT 할 수 없다. 사양서 §2-1';

-- 모든 응답은 정확히 한 곳에만 존재한다: training_safe 면 training, 아니면 reference.
create or replace function reference.assert_non_trainable_response()
returns trigger
language plpgsql
as $$
declare
  is_safe boolean;
begin
  select training_safe into is_safe from training.models where model_id = new.model_id;

  if is_safe is null then
    raise exception 'UNKNOWN_MODEL: training.models 에 없는 모델 (model_id=%).', new.model_id
      using errcode = 'foreign_key_violation';
  end if;

  if is_safe then
    raise exception
      'MISROUTED_RESPONSE: model_id=% 는 training_safe=true 이므로 training.responses 에 넣어야 한다. 응답은 정확히 한 스키마에만 존재해야 한다.',
      new.model_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_assert_non_trainable_response on reference.responses;
create trigger trg_assert_non_trainable_response
  before insert or update on reference.responses
  for each row execute function reference.assert_non_trainable_response();

-- ---------------------------------------------------------------------------
-- reference.message_feedback — 외부 응답에 대한 사람 피드백
--   corrected_text 자체는 사람이 쓴 자사 자산이지만, 어떤 외부 출력을 고친 것인지가
--   맥락에 붙어 있으므로 학습 유입 경로를 아예 만들지 않는다.
-- ---------------------------------------------------------------------------
create table if not exists reference.message_feedback (
  id             uuid primary key default gen_random_uuid(),
  response_id    uuid        not null references reference.responses(id) on delete cascade,
  rating         smallint    not null check (rating in (-1, 0, 1)),
  corrected_text text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_ref_feedback_response on reference.message_feedback (response_id);

-- ---------------------------------------------------------------------------
-- 편의 뷰: 요청 하나에 대한 응답을 계층 구분과 함께 한 줄로 (게이트웨이/운영용)
--   이 뷰는 reference 를 참조하므로 training_pipeline 롤에게 부여하지 않는다.
-- ---------------------------------------------------------------------------
create or replace view reference.all_responses as
  select id, request_id, created_at, output, output_tokens, model_id, cost_krw, is_shadow,
         finish_reason, 'training'::text as home_schema
    from training.responses
  union all
  select id, request_id, created_at, output, output_tokens, model_id, cost_krw, is_shadow,
         finish_reason, 'reference'::text as home_schema
    from reference.responses;
