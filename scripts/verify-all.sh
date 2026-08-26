#!/usr/bin/env bash
# 사양서 §10 판정 지표 중 자동 검증 가능한 항목 전부를 한 번에 돌린다.
#
#   ADMIN_DATABASE_URL=...    (postgres 등 소유자 롤)
#   GATEWAY_DATABASE_URL=...  (gateway_writer)
#   TRAINING_DATABASE_URL=... (training_pipeline)
#   ./scripts/verify-all.sh
set -euo pipefail

: "${ADMIN_DATABASE_URL:?}"; : "${GATEWAY_DATABASE_URL:?}"; : "${TRAINING_DATABASE_URL:?}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "── §10 1주차 · 학습 롤의 reference 격리 ──────────────────────────"
psql "$TRAINING_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/verify-isolation.sql"

echo
echo "── §2-1 · 오염 차단 트리거 ─────────────────────────────────────"
psql "$GATEWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/verify-contamination-guard.sql"

echo
echo "── §2-2 / §5-3 · 모델·라우팅 정책 ──────────────────────────────"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/verify-model-policy.sql"

echo
echo "── 미확인 라이선스·단가 ────────────────────────────────────────"
psql "$ADMIN_DATABASE_URL" -c "select * from ops.metric_unverified_models"

echo
echo "전부 통과"
