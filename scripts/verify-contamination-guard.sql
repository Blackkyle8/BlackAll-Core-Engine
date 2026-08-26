-- =============================================================================
-- 사양서 §2-1 오염 차단 트리거 검증
--   gateway_writer 롤로 실행할 것 (쓰기 권한이 필요하다):
--   psql "$GATEWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-contamination-guard.sql
--
-- 검증 데이터는 트랜잭션 안에서 만들고 마지막에 되돌린다.
-- =============================================================================
\set ON_ERROR_STOP on

begin;

do $$
declare
  req_id uuid;
begin
  insert into training.requests (raw_input, input_tokens, task_type, routed_to, model_id, status)
  values ('contamination-guard-probe', 3, 'unclassified', 'external', 'external/frontier', 'ok')
  returning id into req_id;

  -- 1. 외부 모델 출력을 training.responses 에 넣으려 하면 반드시 실패해야 한다.
  begin
    insert into training.responses (request_id, output, output_tokens, model_id)
    values (req_id, '외부 상용 API 출력', 5, 'external/frontier');
    raise exception 'FAIL[1] 외부 모델 출력이 training.responses 에 들어갔다. 사양서 §2-1 위반.';
  exception
    when insufficient_privilege then
      raise notice 'PASS[1] 외부 출력의 training.responses 유입 차단됨';
  end;

  -- 2. 같은 출력을 reference.responses 에 넣는 것은 성공해야 한다.
  insert into reference.responses (request_id, output, output_tokens, model_id)
  values (req_id, '외부 상용 API 출력', 5, 'external/frontier');
  raise notice 'PASS[2] 외부 출력은 reference.responses 로 정상 기록됨';

  -- 3. 레지스트리에 없는 모델은 어느 쪽에도 들어가면 안 된다.
  begin
    insert into training.responses (request_id, output, model_id)
    values (req_id, 'x', 'ghost/unknown-model');
    raise exception 'FAIL[3] 미등록 모델 출력이 기록되었다.';
  exception
    when foreign_key_violation then
      raise notice 'PASS[3] 미등록 모델 차단됨';
  end;
end
$$;

-- 4. 금지 모델 계열은 레지스트리 등록 자체가 거부되어야 한다 (§2-2).
--    gateway_writer 는 models 에 INSERT 권한이 없으므로 이 검사는 관리자 스크립트로 분리했다.
--    → scripts/verify-model-policy.sql

rollback;

select '§2-1 오염 차단 트리거 통과' as verdict;
