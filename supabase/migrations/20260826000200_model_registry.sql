-- =============================================================================
-- 0200 · 모델 레지스트리 — 라이선스/오염 차단의 단일 진실 공급원
-- 사양서 §2-1(학습 데이터 오염 금지), §2-2(기본 모델 라이선스 제약)
--
-- 이 테이블이 게이트웨이의 라우팅 대상, 비용 단가, 그리고 "이 모델의 출력이
-- 학습 데이터로 들어가도 되는가"를 동시에 결정한다.
-- 게이트웨이 코드에 모델 목록을 하드코딩하지 않는다 — 코드는 규율이고, 이건 권한이다.
-- =============================================================================

create table if not exists training.models (
  model_id            text primary key,          -- 게이트웨이 내부 식별자
  provider            text        not null,      -- 'groq' | 'together' | 'self' | 'openai' | 'anthropic' | 'google' | ...
  provider_model      text        not null,      -- 제공자 API 에 실제로 보내는 모델명
  tier                text        not null check (tier in ('self', 'open', 'external')),
  license             text        not null,      -- 'Apache-2.0' | 'MIT' | 'proprietary' | ...
  license_url         text,
  license_verified_at timestamptz,               -- HF 모델 카드 라이선스 원문 확인일 (§2-2 착수 전 필수)
  training_safe       boolean     not null,      -- 이 모델의 "출력"이 training 스키마에 들어갈 수 있는가
  input_krw_per_mtok  numeric(14,4) not null default 0,
  output_krw_per_mtok numeric(14,4) not null default 0,
  pricing_verified_at timestamptz,               -- 단가 실측 확인일. null 이면 비용 집계는 추정치.
  active              boolean     not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 학습 가능으로 표시하려면 자체/오픈 계층이고 라이선스가 Apache-2.0 또는 MIT 여야 한다.
  constraint models_training_safe_requires_permissive_license
    check (
      training_safe = false
      or (tier in ('self', 'open') and license in ('Apache-2.0', 'MIT'))
    )
);

comment on table training.models is
  '모델 레지스트리. 라우팅 대상 · 비용 단가 · 학습 유입 가부의 단일 진실 공급원. 사양서 §2-1 §2-2';
comment on column training.models.training_safe is
  'true 인 모델의 출력만 training.responses 에 INSERT 될 수 있다 (0400 의 트리거로 강제).';
comment on column training.models.license_verified_at is
  'Hugging Face 모델 카드 라이선스 원문을 확인하고 docs/licenses/ 에 사본을 보관한 날짜. null = 미확인.';

-- ---------------------------------------------------------------------------
-- 금지 모델 계열 차단 (§2-2)
--   Llama : 파생물 동일 라이선스 승계 + 7억 MAU 상한 + EU 멀티모달 제외
--   Gemma : 구글 철회권 + 경쟁 파운데이션 모델 학습 금지 조항
--
--   주의 — 이 규칙은 'deepseek-r1-distill-llama-70b' 같은 Llama 베이스 증류 모델도
--   함께 막는다. 이는 의도된 동작이다. R1 증류본이라도 베이스가 Llama 면
--   Llama 라이선스를 승계하므로 §2-2 위반이다. Qwen 베이스 증류본을 쓸 것.
-- ---------------------------------------------------------------------------
create or replace function training.assert_model_policy()
returns trigger
language plpgsql
as $$
declare
  haystack text := lower(coalesce(new.provider_model, '') || ' ' || coalesce(new.model_id, '') || ' ' || coalesce(new.license, ''));
begin
  if haystack ~ '(^|[^a-z])llama([^a-z]|$)' or haystack ~ 'llama[-_ ]?[0-9]' then
    raise exception
      'BLOCKED_MODEL_FAMILY: Llama 계열은 사양서 §2-2 에 의해 전면 금지됨 (model_id=%, provider_model=%). Llama 베이스 증류 모델도 동일하게 금지된다.',
      new.model_id, new.provider_model
      using errcode = 'check_violation';
  end if;

  if haystack ~ '(^|[^a-z])gemma([^a-z]|$)' then
    raise exception
      'BLOCKED_MODEL_FAMILY: Gemma 계열은 사양서 §2-2 에 의해 전면 금지됨 (model_id=%, provider_model=%).',
      new.model_id, new.provider_model
      using errcode = 'check_violation';
  end if;

  -- 학습 가능으로 표시하려면 라이선스 원문 확인 기록이 있어야 한다.
  if new.training_safe and new.license_verified_at is null then
    raise exception
      'LICENSE_UNVERIFIED: training_safe=true 로 등록하려면 license_verified_at 이 필요하다 (model_id=%). HF 모델 카드 원문 확인 후 docs/licenses/ 에 사본을 보관하고 날짜를 기록할 것.',
      new.model_id
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_assert_model_policy on training.models;
create trigger trg_assert_model_policy
  before insert or update on training.models
  for each row execute function training.assert_model_policy();
