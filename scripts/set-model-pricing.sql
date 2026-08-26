-- 모델 단가 입력. 사양서 §11
--
--   제공자 콘솔에서 실측 단가(USD/100만 토큰)를 확인한 뒤 실행한다.
--   추측값을 넣지 말 것 — ops.metric_monthly_cost 가 거짓 신호를 낸다.
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v model_id="open/gpt-oss-20b" \
--     -v input_usd=0.10 -v output_usd=0.50 \
--     -f scripts/set-model-pricing.sql
--
-- 환율은 training.gateway_config 의 usd_krw_rate 를 쓴다.
\set ON_ERROR_STOP on

update training.models m
   set input_krw_per_mtok  = (:input_usd)::numeric  * rate.value,
       output_krw_per_mtok = (:output_usd)::numeric * rate.value,
       pricing_verified_at = now()
  from (select value from training.gateway_config where key = 'usd_krw_rate') rate
 where m.model_id = :'model_id';

select model_id, input_krw_per_mtok, output_krw_per_mtok, pricing_verified_at
  from training.models
 where model_id = :'model_id';
