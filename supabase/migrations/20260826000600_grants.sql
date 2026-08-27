-- =============================================================================
-- 0600 · 권한 — 사양서 §2-1 의 강제 지점, §10 1주차 사망 조건
--
--   완료 조건: "학습 파이프라인용 DB 롤로 reference 스키마 SELECT 가 실패해야 함"
--
-- 이 파일은 모든 테이블이 생성된 뒤에 실행되어야 한다 (파일명 순서로 보장).
-- 미래에 추가될 객체는 ALTER DEFAULT PRIVILEGES 로 차단한다.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. 전면 회수 — 화이트리스트 방식으로 다시 쌓는다
-- ---------------------------------------------------------------------------
revoke all on schema training, reference, ops from public, training_pipeline, analytics_reader, gateway_writer;

revoke all on all tables    in schema training  from public, training_pipeline, analytics_reader, gateway_writer;
revoke all on all sequences in schema training  from public, training_pipeline, analytics_reader, gateway_writer;
revoke all on all functions in schema training  from public, training_pipeline, analytics_reader, gateway_writer;

revoke all on all tables    in schema reference from public, training_pipeline, analytics_reader, gateway_writer;
revoke all on all sequences in schema reference from public, training_pipeline, analytics_reader, gateway_writer;
revoke all on all functions in schema reference from public, training_pipeline, analytics_reader, gateway_writer;

revoke all on all tables    in schema ops       from public, training_pipeline, analytics_reader, gateway_writer;

-- ---------------------------------------------------------------------------
-- 2. gateway_writer — 런타임. 양쪽에 기록한다.
--    삭제 권한은 주지 않는다. 게이트웨이는 지우지 않는다.
-- ---------------------------------------------------------------------------
grant usage on schema training, reference to gateway_writer;

grant select, insert, update on
    training.requests,
    training.responses,
    training.message_feedback,
    training.verifiable_outcomes
  to gateway_writer;

grant select on
    training.models,
    training.routing_rules,
    training.gateway_config
  to gateway_writer;

-- 인증에 필요한 최소 권한. last_used_at 갱신을 위해 UPDATE 포함.
grant select, update on training.api_keys to gateway_writer;

grant select, insert, update on
    reference.responses,
    reference.message_feedback
  to gateway_writer;

grant execute on function training.self_traffic_ratio(interval) to gateway_writer;

-- ---------------------------------------------------------------------------
-- 3. training_pipeline — 학습 파이프라인.
--    training 스키마 읽기 전용. reference 와 ops 는 USAGE 조차 없다.
-- ---------------------------------------------------------------------------
grant usage on schema training to training_pipeline;

grant select on
    training.requests,
    training.responses,
    training.message_feedback,
    training.verifiable_outcomes,
    training.models,
    training.routing_rules
  to training_pipeline;

-- api_keys 는 학습과 무관하고 인증 비밀을 담으므로 부여하지 않는다.
-- gateway_config 역시 부여하지 않는다.

-- reference / ops 는 명시적으로 다시 회수한다 (실수 방지용 이중 안전장치).
revoke all on schema reference from training_pipeline;
revoke all on schema ops       from training_pipeline;
revoke all on all tables in schema reference from training_pipeline;
revoke all on all tables in schema ops       from training_pipeline;

-- ---------------------------------------------------------------------------
-- 4. analytics_reader — 지표/대시보드. 집계만 본다.
-- ---------------------------------------------------------------------------
grant usage on schema ops to analytics_reader;
grant select on all tables in schema ops to analytics_reader;

-- ops 뷰는 소유자 권한으로 실행되므로 analytics_reader 에게 training/reference
-- 원본 테이블 권한을 줄 필요가 없다. 주지 않는다.

-- ---------------------------------------------------------------------------
-- 5. 미래 객체 차단 — ALTER DEFAULT PRIVILEGES
--    앞으로 postgres 가 reference 스키마에 만드는 모든 테이블은 기본적으로
--    training_pipeline 에게 어떤 권한도 주지 않는다.
--    (PostgreSQL 의 기본값은 이미 "권한 없음"이지만, 누군가 GRANT ... ON ALL TABLES
--     를 반복 실행하는 운영 실수를 막기 위해 의도를 명시적으로 남긴다.)
-- ---------------------------------------------------------------------------
alter default privileges in schema reference revoke all on tables    from public;
alter default privileges in schema reference revoke all on sequences from public;
alter default privileges in schema reference revoke all on functions from public;

alter default privileges in schema training  revoke all on tables    from public;
alter default privileges in schema ops       revoke all on tables    from public;

-- training 스키마의 미래 테이블은 학습 파이프라인이 읽을 수 있어야 한다.
alter default privileges in schema training grant select on tables to training_pipeline;
alter default privileges in schema training grant select, insert, update on tables to gateway_writer;
alter default privileges in schema ops      grant select on tables to analytics_reader;

-- ---------------------------------------------------------------------------
-- 6. Supabase 기본 롤 차단
--    anon / authenticated 는 PostgREST 를 통해 노출된다. 이 두 스키마는
--    PostgREST 에 노출하지 않으며, 노출 설정이 바뀌더라도 권한이 없어야 한다.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema training, reference, ops from anon';
    execute 'revoke all on all tables in schema training  from anon';
    execute 'revoke all on all tables in schema reference from anon';
    execute 'revoke all on all tables in schema ops       from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema training, reference, ops from authenticated';
    execute 'revoke all on all tables in schema training  from authenticated';
    execute 'revoke all on all tables in schema reference from authenticated';
    execute 'revoke all on all tables in schema ops       from authenticated';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. 경고
--    Supabase 의 service_role 키는 RLS 와 대부분의 권한 검사를 우회한다.
--    학습 파이프라인은 절대로 service_role 키를 사용해서는 안 된다.
--    학습 파이프라인은 training_pipeline 롤의 직접 Postgres 연결 문자열만 사용한다.
--    → docs/02-runbook.md
-- ---------------------------------------------------------------------------
