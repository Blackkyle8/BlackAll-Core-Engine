-- =============================================================================
-- 사양서 §2-2 기본 모델 라이선스 제약 검증 (관리자 롤로 실행)
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-model-policy.sql
-- =============================================================================
\set ON_ERROR_STOP on

begin;

do $$
begin
  -- 1. Llama 계열 등록 거부
  begin
    insert into training.models (model_id, provider, provider_model, tier, license, training_safe)
    values ('open/llama-3.3-70b', 'groq', 'llama-3.3-70b-versatile', 'open', 'Apache-2.0', false);
    raise exception 'FAIL[1] Llama 계열이 레지스트리에 등록되었다. 사양서 §2-2 위반.';
  exception
    when check_violation then raise notice 'PASS[1] Llama 계열 등록 차단됨';
  end;

  -- 2. Llama 베이스 증류 모델도 거부되어야 한다 (R1 distill 이라도 베이스가 Llama 면 승계)
  begin
    insert into training.models (model_id, provider, provider_model, tier, license, training_safe)
    values ('open/r1-distill', 'groq', 'deepseek-r1-distill-llama-70b', 'open', 'MIT', false);
    raise exception 'FAIL[2] Llama 베이스 증류 모델이 등록되었다.';
  exception
    when check_violation then raise notice 'PASS[2] Llama 베이스 증류 모델 등록 차단됨';
  end;

  -- 3. Gemma 계열 등록 거부
  begin
    insert into training.models (model_id, provider, provider_model, tier, license, training_safe)
    values ('open/gemma2-9b', 'groq', 'gemma2-9b-it', 'open', 'Apache-2.0', false);
    raise exception 'FAIL[3] Gemma 계열이 등록되었다. 사양서 §2-2 위반.';
  exception
    when check_violation then raise notice 'PASS[3] Gemma 계열 등록 차단됨';
  end;

  -- 4. 비허용 라이선스로 training_safe 승격 거부
  begin
    insert into training.models (model_id, provider, provider_model, tier, license, training_safe, license_verified_at)
    values ('open/cc-by-nc', 'groq', 'some-nc-model', 'open', 'CC-BY-NC-4.0', true, now());
    raise exception 'FAIL[4] Apache-2.0/MIT 가 아닌 라이선스가 training_safe 로 등록되었다.';
  exception
    when check_violation then raise notice 'PASS[4] 비허용 라이선스의 training_safe 승격 차단됨';
  end;

  -- 5. external 계층은 training_safe 가 될 수 없다
  begin
    insert into training.models (model_id, provider, provider_model, tier, license, training_safe, license_verified_at)
    values ('external/x', 'openai', 'some-frontier', 'external', 'Apache-2.0', true, now());
    raise exception 'FAIL[5] external 계층이 training_safe 로 등록되었다.';
  exception
    when check_violation then raise notice 'PASS[5] external 계층의 training_safe 승격 차단됨';
  end;

  -- 6. 라이선스 원문 미확인 상태로 training_safe 승격 거부
  begin
    insert into training.models (model_id, provider, provider_model, tier, license, training_safe)
    values ('open/unverified', 'groq', 'some-open-model', 'open', 'Apache-2.0', true);
    raise exception 'FAIL[6] license_verified_at 없이 training_safe 로 등록되었다.';
  exception
    when check_violation then raise notice 'PASS[6] 라이선스 미확인 모델의 승격 차단됨';
  end;

  -- 7. 정상 케이스는 통과해야 한다
  insert into training.models (model_id, provider, provider_model, tier, license, training_safe, license_verified_at)
  values ('open/probe-ok', 'groq', 'qwen/qwen3-32b-probe', 'open', 'Apache-2.0', true, now());
  raise notice 'PASS[7] 확인된 Apache-2.0 오픈모델은 정상 등록됨';
end
$$;

-- 8. §5-3 상한 우회 거부
do $$
begin
  begin
    update training.gateway_config set value = 0.95 where key = 'self_model_max_ratio';
    raise exception 'FAIL[8] self_model_max_ratio 를 0.75 초과로 설정할 수 있다. 사양서 §5-3 위반.';
  exception
    when check_violation then raise notice 'PASS[8] 자체 모델 비중 상한 우회 차단됨';
  end;

  begin
    update training.routing_rules set explore_ratio = 0.0 where task_type = 'unclassified';
    raise exception 'FAIL[9] explore_ratio 를 하한 5%% 미만으로 설정할 수 있다.';
  exception
    when check_violation then raise notice 'PASS[9] 탐색 비율 하한 우회 차단됨';
  end;

  begin
    update training.routing_rules
       set current_target = 'self'
     where task_type = 'unclassified';
    raise exception 'FAIL[10] 승격 근거(promoted_at, sample_count>=200) 없이 self 로 승격할 수 있다.';
  exception
    when check_violation then raise notice 'PASS[10] 근거 없는 self 승격 차단됨';
  end;
end
$$;

rollback;

select '§2-2 / §5-3 모델·라우팅 정책 통과' as verdict;
