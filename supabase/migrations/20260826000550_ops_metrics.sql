-- =============================================================================
-- 0550 · 판정 지표 자동 산출
-- 사양서 §10 — "각 지표는 자동 산출되어야 하며, 사람이 매번 확인하는 구조면 실패로 간주한다."
--
-- 지표 뷰는 별도의 ops 스키마에 둔다. 일부 지표가 reference 를 참조하기 때문이다.
-- 뷰는 소유자 권한으로 실행되므로, 이 스키마를 training_pipeline 에 부여하면
-- §2-1 격리가 우회된다. 0600 에서 analytics_reader 에게만 부여한다.
-- =============================================================================

create schema if not exists ops;
revoke all on schema ops from public;

comment on schema ops is
  '운영 지표. reference 를 참조하므로 training_pipeline 롤에게 절대 부여하지 않는다.';

-- ---------------------------------------------------------------------------
-- §10 4주차 — 게이트웨이 통과 호출 100% 기록
--   구조상 requests 삽입이 선행되므로 누락은 없다. 실제 감시 대상은
--   "응답까지 완결되지 못하고 pending 으로 남은 비율"이다.
-- ---------------------------------------------------------------------------
create or replace view ops.metric_capture_integrity as
  select
    date_trunc('day', r.created_at)                                       as day,
    count(*)                                                              as requests,
    count(*) filter (where r.status = 'ok')                               as completed,
    count(*) filter (where r.status = 'error')                            as failed,
    count(*) filter (where r.status = 'pending'
                       and r.created_at < now() - interval '10 minutes')  as stuck,
    count(*) filter (where resp.request_id is null and r.status = 'ok')   as ok_without_response,
    round(
      count(*) filter (where r.status <> 'pending')::numeric
        / nullif(count(*), 0), 4)                                         as settle_rate
  from training.requests r
  left join lateral (
    select 1 as request_id from reference.all_responses ar
     where ar.request_id = r.id and not ar.is_shadow limit 1
  ) resp on true
  group by 1
  order by 1 desc;

-- ---------------------------------------------------------------------------
-- §10 3개월 — 질문 유형 20개 이내 수렴
-- ---------------------------------------------------------------------------
create or replace view ops.metric_task_type_convergence as
  with recent as (
    select task_type
      from training.requests
     where created_at >= now() - interval '30 days'
       and task_type <> 'unclassified'
  )
  select
    count(distinct task_type)                                       as distinct_task_types,
    count(*)                                                        as classified_requests,
    (select count(*) from training.requests
      where created_at >= now() - interval '30 days')               as total_requests,
    (count(distinct task_type) <= 20)                               as converged,
    20                                                              as threshold
  from recent;

-- 유형별 분포 (4주차 대시보드 원천, §8 4주차 완료 조건)
create or replace view ops.metric_task_type_distribution as
  select
    task_type,
    count(*)                                                          as requests,
    round(count(*)::numeric / nullif(sum(count(*)) over (), 0), 4)    as share,
    count(*) filter (where routed_to = 'self')                        as to_self,
    count(*) filter (where routed_to = 'open')                        as to_open,
    count(*) filter (where routed_to = 'external')                    as to_external,
    round(avg(latency_ms))                                            as avg_latency_ms
  from training.requests
  where created_at >= now() - interval '30 days'
  group by task_type
  order by requests desc;

-- ---------------------------------------------------------------------------
-- §10 12개월 — 자체 모델 트래픽 50% 이상 / §5-3 상한 75%
-- ---------------------------------------------------------------------------
create or replace view ops.metric_self_traffic_share as
  select
    date_trunc('week', created_at)                                            as week,
    count(*) filter (where routed_to is not null)                             as routed,
    round(count(*) filter (where routed_to = 'self')::numeric
            / nullif(count(*) filter (where routed_to is not null), 0), 4)    as self_share,
    round(count(*) filter (where routed_to = 'external')::numeric
            / nullif(count(*) filter (where routed_to is not null), 0), 4)    as external_share,
    round(count(*) filter (where explored)::numeric
            / nullif(count(*), 0), 4)                                         as explore_share
  from training.requests
  group by 1
  order by 1 desc;

-- ---------------------------------------------------------------------------
-- §11 월 비용 예산 — 10만원 초과 감시
-- ---------------------------------------------------------------------------
create or replace view ops.metric_daily_cost as
  select
    date_trunc('day', created_at)                                  as day,
    round(sum(cost_krw), 2)                                        as cost_krw,
    round(sum(cost_krw) filter (where home_schema = 'training'), 2) as open_and_self_krw,
    round(sum(cost_krw) filter (where home_schema = 'reference'), 2) as external_krw,
    count(*)                                                        as responses
  from reference.all_responses
  group by 1
  order by 1 desc;

create or replace view ops.metric_monthly_cost as
  select
    date_trunc('month', created_at)          as month,
    round(sum(cost_krw), 2)                  as cost_krw,
    100000                                   as budget_krw,
    (sum(cost_krw) > 100000)                 as over_budget
  from reference.all_responses
  group by 1
  order by 1 desc;

-- ---------------------------------------------------------------------------
-- 단가 미확인 모델 감시 — 비용 집계가 추정치인지 실측인지 구분
-- ---------------------------------------------------------------------------
create or replace view ops.metric_unverified_models as
  select model_id, provider, tier, license,
         license_verified_at is null as license_unverified,
         pricing_verified_at is null as pricing_unverified
    from training.models
   where active
     and (license_verified_at is null or pricing_verified_at is null);
