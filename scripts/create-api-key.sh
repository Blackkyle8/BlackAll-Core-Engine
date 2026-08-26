#!/usr/bin/env bash
# 게이트웨이 API 키 발급.
#   원문 키는 이 스크립트의 출력에만 존재한다. DB 에는 sha256 해시만 들어간다.
#   출력된 키는 다시 볼 수 없으므로 그 자리에서 고객에게 전달할 것.
#
#   사용: ADMIN_DATABASE_URL=postgres://... ./scripts/create-api-key.sh "고객사명" [user_uuid]
set -euo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL 이 필요하다}"
NAME="${1:?발급 대상 이름이 필요하다}"
USER_ID="${2:-$(uuidgen | tr 'A-Z' 'a-z')}"

RAW="ba_live_$(openssl rand -hex 24)"
HASH="$(printf '%s' "$RAW" | openssl dgst -sha256 -hex | awk '{print $NF}')"
PREFIX="${RAW:0:12}"

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
insert into training.api_keys (key_hash, key_prefix, user_id, name)
values ('$HASH', '$PREFIX', '$USER_ID', '$NAME');
SQL

cat <<OUT

발급 완료
  이름      : $NAME
  user_id   : $USER_ID
  API 키    : $RAW

  이 키는 여기서만 볼 수 있다. DB 에는 sha256 해시만 저장되었다.

  사용 예:
    curl -sS "\$GATEWAY_URL/gateway/v1/chat/completions" \\
      -H "authorization: Bearer $RAW" \\
      -H "content-type: application/json" \\
      -d '{"messages":[{"role":"user","content":"안녕"}]}'
OUT
