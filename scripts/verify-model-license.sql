-- 모델 라이선스 원문 확인 후 학습 유입을 여는 스크립트. 사양서 §2-2
--
--   1. Hugging Face 모델 카드의 라이선스 원문을 직접 읽는다
--   2. 사본을 docs/licenses/<model>.md 로 저장하고 커밋한다
--   3. 그다음에 이 스크립트를 실행한다
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v model_id="open/gpt-oss-20b" \
--     -v license="Apache-2.0" \
--     -v license_url="https://huggingface.co/openai/gpt-oss-20b" \
--     -f scripts/verify-model-license.sql
--
-- Apache-2.0 / MIT 가 아니면 트리거가 거부한다. Llama·Gemma 계열도 거부한다.
\set ON_ERROR_STOP on

update training.models
   set license             = :'license',
       license_url         = :'license_url',
       license_verified_at = now(),
       training_safe       = true
 where model_id = :'model_id';

select model_id, tier, license, training_safe, license_verified_at
  from training.models
 where model_id = :'model_id';
