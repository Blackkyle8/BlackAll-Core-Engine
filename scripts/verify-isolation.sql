-- =============================================================================
-- 사양서 §8 1주차 완료 조건 / §10 1주차 사망 조건 자동 검증
--   "학습 파이프라인용 DB 롤로 reference 스키마 SELECT 가 실패해야 함"
--
-- 반드시 training_pipeline 롤로 접속해서 실행할 것:
--   psql "$TRAINING_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-isolation.sql
--
-- 하나라도 FAIL 이면 psql 이 0 이 아닌 코드로 종료한다.
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  who text := current_user;
begin
  if who <> 'training_pipeline' then
    raise exception 'FAIL[0] 이 스크립트는 training_pipeline 롤로 실행해야 한다. 현재 롤=%', who;
  end if;
  raise notice 'PASS[0] 실행 롤 = %', who;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. training 스키마는 읽을 수 있어야 한다 (학습이 불가능하면 그것도 실패다)
-- ---------------------------------------------------------------------------
do $$
begin
  perform 1 from training.requests limit 1;
  perform 1 from training.responses limit 1;
  perform 1 from training.models limit 1;
  raise notice 'PASS[1] training 스키마 SELECT 가능';
exception
  when insufficient_privilege then
    raise exception 'FAIL[1] 학습 롤이 training 스키마를 읽지 못한다: %', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. reference 스키마 SELECT 는 반드시 실패해야 한다  ← 핵심 조건
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform 1 from reference.responses limit 1;
    raise exception 'FAIL[2a] 학습 롤이 reference.responses 를 읽을 수 있다. 사양서 §2-1 위반 — 데이터 수집 즉시 중단할 것.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[2a] reference.responses SELECT 차단됨';
  end;

  begin
    perform 1 from reference.message_feedback limit 1;
    raise exception 'FAIL[2b] 학습 롤이 reference.message_feedback 를 읽을 수 있다.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[2b] reference.message_feedback SELECT 차단됨';
  end;

  begin
    perform 1 from reference.all_responses limit 1;
    raise exception 'FAIL[2c] 학습 롤이 reference.all_responses 뷰를 읽을 수 있다. 이 뷰는 소유자 권한으로 실행되므로 외부 출력이 그대로 새어나간다.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[2c] reference.all_responses 뷰 차단됨';
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. ops 스키마도 차단되어야 한다 (지표 뷰가 reference 를 참조하므로 우회 통로가 된다)
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform 1 from ops.metric_daily_cost limit 1;
    raise exception 'FAIL[3] 학습 롤이 ops 지표 뷰를 읽을 수 있다. 이 뷰는 reference 를 참조하므로 §2-1 격리가 우회된다.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[3] ops 스키마 차단됨';
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. 학습 롤은 인증 비밀에 접근할 수 없어야 한다
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform 1 from training.api_keys limit 1;
    raise exception 'FAIL[4] 학습 롤이 training.api_keys 를 읽을 수 있다.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[4] training.api_keys 차단됨';
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. 학습 롤은 읽기 전용이어야 한다
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into training.requests (raw_input) values ('isolation-probe');
    raise exception 'FAIL[5] 학습 롤이 training.requests 에 INSERT 할 수 있다. 읽기 전용이어야 한다.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[5] 학습 롤 쓰기 차단됨';
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. 스키마 목록 자체에서 reference 가 보이지 않아야 한다 (USAGE 없음 확인)
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n
    from information_schema.schemata
   where schema_name in ('reference', 'ops')
     and has_schema_privilege(current_user, schema_name, 'USAGE');
  if n > 0 then
    raise exception 'FAIL[6] 학습 롤이 reference/ops 스키마에 USAGE 권한을 가지고 있다 (%개).', n;
  end if;
  raise notice 'PASS[6] reference/ops USAGE 권한 없음';
end
$$;

select '§10 1주차 사망 조건 통과 — 학습 롤은 reference 에 접근할 수 없다' as verdict;
