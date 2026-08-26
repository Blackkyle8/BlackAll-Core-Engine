-- =============================================================================
-- 0500 · 라우팅
-- 사양서 §4-2(routing_rules), §5-2(라우팅 규칙), §5-3(자체 모델 비중 상한)
-- =============================================================================

create table if not exists training.routing_rules (
  task_type      text primary key,
  current_target text        not null check (current_target in ('self', 'open', 'external')),
  promoted_at    timestamptz,
  sample_count   int         not null default 0 check (sample_count >= 0),
  pass_rate_3w   real        check (pass_rate_3w between 0 and 1),
  explore_ratio  real        not null default 0.05,
  updated_at     timestamptz not null default now(),

  -- §5-3 탐색 비율 하한 5%. 승격된 유형에도 상시 적용되므로 DB 에서 고정한다.
  constraint routing_rules_explore_floor
    check (explore_ratio >= 0.05 and explore_ratio <= 1.0),

  -- self 로 승격되었다면 승격 시각과 표본 수 근거가 있어야 한다 (§6-1 최소 표본 200건).
  constraint routing_rules_self_requires_evidence
    check (
      current_target <> 'self'
      or (promoted_at is not null and sample_count >= 200)
    )
);

comment on table training.routing_rules is
  '유형별 현재 라우팅 대상. 승격/강등은 §6-3 에 따라 pg_cron 주간 잡이 사람 개입 없이 갱신한다 (4~6개월차).';

create or replace function training.touch_routing_rules()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_routing_rules on training.routing_rules;
create trigger trg_touch_routing_rules
  before update on training.routing_rules
  for each row execute function training.touch_routing_rules();

-- ---------------------------------------------------------------------------
-- 자체 모델 트래픽 비중 (§5-3 상한 75% 판정용)
--   탐색 당첨 호출(explored)은 강제 외부 라우팅이므로 분모에서 제외하지 않는다.
--   실제 트래픽 중 자체 모델이 처리한 비율을 그대로 본다.
-- ---------------------------------------------------------------------------
create or replace function training.self_traffic_ratio(p_window interval default interval '1 hour')
returns numeric
language sql
stable
as $$
  select coalesce(
           count(*) filter (where routed_to = 'self')::numeric
             / nullif(count(*) filter (where routed_to is not null), 0),
           0
         )
    from training.requests
   where created_at >= now() - p_window;
$$;

comment on function training.self_traffic_ratio(interval) is
  '최근 구간의 자체 모델 라우팅 비중. 게이트웨이가 §5-3 상한(75%) 초과 시 open 으로 강등하는 데 쓴다.';
