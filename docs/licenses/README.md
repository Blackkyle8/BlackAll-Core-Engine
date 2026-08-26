# 모델 라이선스 원문 사본

사양서 §2-2:

> **착수 전 필수**: Hugging Face에서 사용할 정확한 모델 카드의 라이선스 원문 확인 후
> 사본 보관. Qwen은 크기·세대별로 Apache 2.0 / 커스텀 / 비상용 연구용이 갈림.

## 절차

1. Hugging Face 모델 카드의 라이선스 원문을 연다.
2. 원문 전체를 `docs/licenses/<model-id>.md` 로 저장한다.
   파일 머리에 확인일·URL·커밋 시점의 모델 카드 리비전을 적는다.
3. 커밋한다.
4. 그다음에야 DB 에서 학습 유입을 연다:

   ```bash
   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v model_id="open/gpt-oss-20b" \
     -v license="Apache-2.0" \
     -v license_url="https://huggingface.co/openai/gpt-oss-20b" \
     -f scripts/verify-model-license.sql
   ```

이 순서를 지키지 않으면 `training.assert_model_policy` 트리거가
`LICENSE_UNVERIFIED` 로 거부한다.

## 주의

- **Llama · Gemma 계열은 등록 자체가 거부된다** (§2-2).
  `deepseek-r1-distill-llama-70b` 처럼 이름에 llama 가 든 증류 모델도 마찬가지다.
  R1 증류본이라도 베이스가 Llama 면 Llama 라이선스를 승계하므로 §2-2 위반이다.
  Qwen 베이스 증류본을 쓸 것.
- Apache-2.0 / MIT 가 아닌 라이선스는 `training_safe` 로 승격되지 않는다.
- 아직 확인되지 않은 모델은 `ops.metric_unverified_models` 에 계속 뜬다.

## 현재 사본

(없음 — 1주차 작업 항목)
