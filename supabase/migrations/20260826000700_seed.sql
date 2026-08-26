-- =============================================================================
-- 0700 · 초기값
-- 사양서 §5-2, §5-3, §9
--
-- 원칙: 닫힌 상태로 시작한다(fail closed).
--   모델은 라이선스 원문을 확인하기 전까지 training_safe = false 다.
--   즉 확인 전에는 오픈모델 출력조차 학습 스키마에 쌓이지 않는다.
--   확인 후 scripts/verify-model-license.sql 한 줄로 연다.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 게이트웨이 설정 (§5-3, §9)
-- ---------------------------------------------------------------------------
insert into training.gateway_config (key, value, notes) values
  ('self_model_max_ratio', 0.75,
   '§5-3 자체 모델 라우팅 비율 상한. DB 제약상 0.75 초과 불가.'),
  ('explore_ratio_floor', 0.05,
   '§5-3 탐색 비율 하한. 승격된 유형에도 상시 적용.'),
  ('external_long_context_threshold', 8000,
   '§5-2 입력 토큰이 이 값을 넘으면 외부 고성능으로 라우팅.'),
  ('route_unclassified_to_external', 0,
   '§5-2 "task_type=unclassified → 외부 고성능" 규칙 스위치. 3주차 분류기 도입 전까지 0. '
   '2주차 라우팅은 §8 에 따라 입력 길이 기준만 쓴다. 지금 1로 두면 전 트래픽이 외부로 가고 비용이 폭발한다.'),
  ('request_timeout_ms', 60000,
   '제공자 호출 타임아웃.'),
  ('usd_krw_rate', 1400,
   '단가 환산용 참고 환율. scripts/set-model-pricing.sql 에서만 사용. 운영자가 갱신할 것.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 모델 레지스트리 (§2-2, §3)
--
--   license_verified_at 이 전부 null 이다 = 아직 아무 모델의 출력도 학습에 못 들어간다.
--   §2-2 "착수 전 필수: Hugging Face 모델 카드의 라이선스 원문 확인 후 사본 보관"
--   을 코드가 아니라 데이터로 강제하는 방식이다.
--
--   단가도 0 으로 둔다. 추측한 숫자를 넣으면 §11 예산 감시가 거짓 신호를 낸다.
--   운영자가 콘솔에서 실측 단가를 확인해 scripts/set-model-pricing.sql 로 채운다.
-- ---------------------------------------------------------------------------
insert into training.models
  (model_id, provider, provider_model, tier, license, license_url, training_safe, active, notes)
values
  ('open/gpt-oss-20b', 'groq', 'openai/gpt-oss-20b', 'open',
   'Apache-2.0', 'https://huggingface.co/openai/gpt-oss-20b',
   false, true,
   '§8 2주차 기본 오픈모델. 라이선스 원문 확인 후 verify-model-license.sql 로 training_safe 승격.'),

  ('open/qwen3-32b', 'groq', 'qwen/qwen3-32b', 'open',
   'Apache-2.0', 'https://huggingface.co/Qwen/Qwen3-32B',
   false, true,
   '§12 미결 3 — Qwen 은 크기·세대별로 Apache-2.0 / 커스텀 / 비상용이 갈린다. '
   '이 행의 license 값은 확인 전까지 신뢰하지 말 것.'),

  ('external/frontier', 'external', '${EXTERNAL_LLM_MODEL}', 'external',
   'proprietary', null,
   false, true,
   '§5-2 외부 고성능 폴백. provider_model 은 EXTERNAL_LLM_MODEL 환경변수로 런타임 치환된다. '
   '출력은 영구적으로 학습 불가 — reference.responses 로만 간다.')
on conflict (model_id) do nothing;

-- ---------------------------------------------------------------------------
-- 라우팅 규칙 (§4-2, §5-2)
--   3개월 축적 전까지 유형 집합을 하드코딩하지 않는다 (§4-4).
--   따라서 규칙은 'unclassified' 한 줄뿐이다.
-- ---------------------------------------------------------------------------
insert into training.routing_rules (task_type, current_target, explore_ratio)
values ('unclassified', 'open', 0.05)
on conflict (task_type) do nothing;
