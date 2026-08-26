-- =============================================================================
-- 0100 · 스키마 · 롤 · 확장
-- 사양서 §2-1(학습 데이터 오염 금지), §4-1(스키마 분리), §8 1주차
--
-- 이 마이그레이션의 목적은 단 하나다:
--   "학습 파이프라인이 쓰는 DB 롤은 reference 스키마에 물리적으로 접근할 수 없다"
-- 를 사람 규율이 아니라 권한으로 성립시키는 것.
--
-- 롤 비밀번호는 이 파일에 포함하지 않는다. scripts/set-role-passwords.sql 참조.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. 스키마
-- ---------------------------------------------------------------------------
create schema if not exists training;
create schema if not exists reference;

comment on schema training is
  '학습 가능 데이터. 자체 생성물 + 오픈모델(Apache-2.0/MIT) 출력만 유입 가능. 사양서 §2-1';
comment on schema reference is
  '학습 불가 참조 데이터. 외부 폐쇄형 상용 API 출력 + 라이선스 구독 데이터. 학습 롤 접근 금지. 사양서 §2-1';

-- ---------------------------------------------------------------------------
-- 2. 롤
--   gateway_writer   : 게이트웨이 런타임. 양쪽 스키마에 기록. 서비스 롤 키를 쓰지 않는다.
--   training_pipeline: 학습 파이프라인. training 스키마 읽기 전용. reference 접근 불가.
--   analytics_reader : 대시보드/지표. training 읽기 전용 (4주차 이후 사용).
-- ---------------------------------------------------------------------------
-- 주의: COMMENT ON ROLE / ALTER ROLE ... NOSUPERUSER 는 슈퍼유저를 요구한다.
-- Supabase 의 postgres 롤은 슈퍼유저가 아니므로 CREATE ROLE 시점에 속성을 확정한다.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gateway_writer') then
    create role gateway_writer
      login noinherit nocreatedb nocreaterole nobypassrls noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'training_pipeline') then
    create role training_pipeline
      login noinherit nocreatedb nocreaterole nobypassrls noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'analytics_reader') then
    create role analytics_reader
      login noinherit nocreatedb nocreaterole nobypassrls noreplication;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. 기본 권한 회수
--   PUBLIC 은 기본적으로 모든 스키마의 함수 실행 권한 등을 가진다. 전부 회수한다.
-- ---------------------------------------------------------------------------
revoke all on schema training  from public;
revoke all on schema reference from public;
revoke create on schema public from public;

-- reference 스키마: 학습 롤에게 어떤 형태로도 권한이 흘러가지 않도록 명시 회수.
-- (아래는 현재 존재하는 객체 대상. 미래 객체는 0600 의 default privileges 로 차단.)
revoke all on schema reference from training_pipeline;
revoke all on schema reference from analytics_reader;

-- ---------------------------------------------------------------------------
-- 4. 확장
--   pgvector 는 reference.doc_chunks(3주차)에서만 쓰이지만, 1주차 완료 조건이므로
--   지금 설치한다. 로컬 검증 환경에 pgvector 가 없을 수 있으므로 별도 파일로 분리.
--   → 20260826000150_pgvector.sql
-- ---------------------------------------------------------------------------
-- gen_random_uuid() 는 PostgreSQL 13+ 코어 함수이므로 별도 확장이 필요 없다.
