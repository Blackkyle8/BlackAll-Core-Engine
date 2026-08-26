#!/usr/bin/env bash
# 순정 PostgreSQL 로 전체 스택을 세우고 검증까지 돌린다.
# Supabase 프로젝트 없이도 §8 1주차 완료 조건을 재현할 수 있게 하기 위한 것이다.
#
#   ./scripts/local-verify.sh            # 기본 포트 55432 에 임시 클러스터
#   PGPORT=55432 ./scripts/local-verify.sh
#
# pgvector 가 없는 환경에서는 0150 마이그레이션을 건너뛴다 (게이트웨이 동작과 무관).
set -euo pipefail

PORT="${PGPORT:-55432}"
DB="${PGDATABASE:-blackall_local}"
HOST="${PGHOST:-127.0.0.1}"
BASE="postgres://postgres@${HOST}:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql "$BASE/postgres" -tAc "drop database if exists ${DB}"
psql "$BASE/postgres" -tAc "create database ${DB}"

DATABASE_URL="$BASE/$DB" "$ROOT/scripts/run-migrations.sh"

echo
psql "postgres://training_pipeline@${HOST}:${PORT}/${DB}" -v ON_ERROR_STOP=1 \
  -f "$ROOT/scripts/verify-isolation.sql"
echo
psql "postgres://gateway_writer@${HOST}:${PORT}/${DB}" -v ON_ERROR_STOP=1 \
  -f "$ROOT/scripts/verify-contamination-guard.sql"
echo
psql "$BASE/$DB" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/verify-model-policy.sql"

echo
echo "로컬 검증 전부 통과"
