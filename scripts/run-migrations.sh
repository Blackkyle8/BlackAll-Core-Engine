#!/usr/bin/env bash
# 마이그레이션 순차 적용.
#   사용: DATABASE_URL=postgres://... ./scripts/run-migrations.sh
#
# "-- requires: pgvector" 헤더가 있는 파일은 대상 DB 에 pgvector 가 없으면 건너뛴다.
# (순정 PostgreSQL 로 격리 검증을 돌릴 수 있게 하기 위함. Supabase 에서는 항상 적용된다.)
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL 이 필요하다}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

has_pgvector=$(psql "$DATABASE_URL" -tAc \
  "select count(*) from pg_available_extensions where name = 'vector'")

for f in "$ROOT"/supabase/migrations/*.sql; do
  if grep -q -- '-- requires: pgvector' "$f" && [ "$has_pgvector" = "0" ]; then
    echo "SKIP  $(basename "$f")  (pgvector 미설치 환경)"
    continue
  fi
  echo "APPLY $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "마이그레이션 완료"
