# 0001 · 응답을 계층에 따라 두 스키마로 물리 분리한다

상태: 채택 · 2026-08-26

## 문제

사양서가 두 곳에서 서로 충돌한다.

- §4-2 는 `responses` 를 **training 스키마**에 둔다.
- §4-2 의 `requests.routed_to` 는 `'external'` 값을 가질 수 있다.
- §2-1 은 외부 폐쇄형 상용 API 출력의 **학습 파이프라인 유입을 절대 금지**한다.

사양서를 글자 그대로 구현하면 외부 고성능 모델의 출력이 `training.responses` 에
쌓인다. 학습 롤은 training 스키마를 읽을 수 있으므로, §2-1 의 격리는 그 순간
무너진다. 실사에서 "학습 표본에 GPT 출력이 섞였는가"를 물으면 답이 "섞였다"가 된다.

## 결정

응답은 **모델의 `training_safe` 값에 따라 물리적으로 다른 스키마에 저장한다.**

| 계층 | 저장 위치 | 학습 롤 접근 |
|---|---|---|
| self, open (Apache-2.0 / MIT) | `training.responses` | 가능 |
| external (폐쇄형 상용) | `reference.responses` | 불가 |

`requests` 는 분리하지 않는다. 입력은 고객과 자사의 자산이지 외부 사업자의
저작물이 아니다. 오염원은 **출력**뿐이다. 따라서 어디로 라우팅되었든 입력은
`training.requests` 에 남고, 이것이 §8 2주차 완료 조건("모든 호출이 requests 에
기록됨")과도 맞는다.

## 강제 방법

코드 분기는 편의일 뿐 안전장치가 아니다. 실제 강제는 DB 트리거다.

- `training.responses` BEFORE INSERT/UPDATE →
  `training.models.training_safe = false` 면 `insufficient_privilege` 로 거부.
- `reference.responses` BEFORE INSERT/UPDATE →
  `training_safe = true` 면 거부. 응답은 정확히 한 스키마에만 존재한다.

게이트웨이 코드에 버그가 있어도, 새 개발자가 규칙을 몰라도, DB 가 거부한다.

## 결과

- `message_feedback` 도 두 벌이 된다 (`training` / `reference`). 외부 응답에 붙은
  피드백은 그 응답의 맥락과 분리할 수 없으므로 학습 경로를 아예 만들지 않는다.
- `verifiable_outcomes` 는 `requests` 를 참조하므로 training 에만 둔다.
  검증 규칙의 통과 여부는 외부 사업자의 저작물이 아니다.
- 두 스키마를 합쳐 보는 뷰 `reference.all_responses` 는 reference 쪽에 둔다.
  뷰는 소유자 권한으로 실행되므로 training 쪽에 두면 격리가 우회된다.
- 지표 뷰도 같은 이유로 별도 `ops` 스키마에 두고 학습 롤에 부여하지 않는다.

## 검증

`scripts/verify-contamination-guard.sql` 이 이 결정을 매번 재확인한다.
`scripts/verify-isolation.sql` PASS[2c] 가 뷰 우회 경로를 확인한다.
