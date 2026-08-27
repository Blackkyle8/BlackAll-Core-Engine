# 0003 · 게이트웨이는 service_role 키를 쓰지 않는다

상태: 채택 · 2026-08-26

## 문제

Supabase Edge Function 의 관행적 구현은 `SUPABASE_SERVICE_ROLE_KEY` 로
supabase-js 를 만들어 PostgREST 를 호출하는 것이다. 그런데 `service_role` 은
RLS 와 대부분의 권한 검사를 **우회**한다. 그 키가 런타임에 있으면
§2-1 의 스키마 격리는 "키를 잘못 쓰지 않는다"는 규율로 전락한다.

또 PostgREST 로 `training` / `reference` 스키마를 다루려면 두 스키마를 API 에
노출해야 한다. 학습 표본과 고객 원문이 HTTP 로 노출되는 셈이다.

## 결정

- 게이트웨이는 `gateway_writer` 롤의 **직접 Postgres 연결**만 쓴다.
- `training` / `reference` / `ops` 는 PostgREST 에 노출하지 않는다
  (`supabase/config.toml` 의 `schemas = ["public"]`).
- `service_role` 키는 마이그레이션·관리 스크립트 전용이며 런타임 환경변수에 넣지 않는다.
- 학습 파이프라인은 `training_pipeline` 롤 연결 문자열만 받는다.
  사양서 §9 의 `SUPABASE_TRAINING_ROLE_KEY` 는 이 연결 문자열로 구현된다.

## 대가

- 커넥션 풀 관리를 직접 해야 한다 (Supabase 트랜잭션 모드 풀러 6543 포트,
  `prepare: false`).
- 마이그레이션 없이 스키마를 바꿀 수 없다. 이것은 대가가 아니라 이득이다.

## 결과

`scripts/verify-isolation.sql` 이 실제 롤로 접속해 격리를 확인할 수 있다.
service_role 을 쓰는 설계에서는 이 검증 자체가 성립하지 않는다.
