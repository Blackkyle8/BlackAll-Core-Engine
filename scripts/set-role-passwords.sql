-- 롤 비밀번호 설정. 마이그레이션에 비밀번호를 넣지 않기 위해 분리했다.
--
--   psql "$ADMIN_DATABASE_URL" \
--     -v gw_pw="$(openssl rand -hex 24)" \
--     -v tp_pw="$(openssl rand -hex 24)" \
--     -v an_pw="$(openssl rand -hex 24)" \
--     -f scripts/set-role-passwords.sql
--
-- 출력된 값을 각각 GATEWAY_DATABASE_URL / TRAINING_DATABASE_URL / ANALYTICS_DATABASE_URL
-- 에 담아 보관한다. 학습 파이프라인에는 절대 service_role 키를 주지 않는다.
\set ON_ERROR_STOP on

alter role gateway_writer    with login password :'gw_pw';
alter role training_pipeline with login password :'tp_pw';
alter role analytics_reader  with login password :'an_pw';

select 'passwords set for gateway_writer, training_pipeline, analytics_reader' as result;
