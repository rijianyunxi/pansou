#!/usr/bin/env bash
# Refresh checked-query metadata against a database with the current migrations.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -z "${PANSOU_DATABASE_URL:-}" ]]; then
    echo '请在环境中设置 DATABASE_URL 或 PANSOU_DATABASE_URL，指向已应用当前迁移的开发数据库。' >&2
    exit 1
  fi
  export DATABASE_URL="$PANSOU_DATABASE_URL"
fi

mkdir -p .sqlx
export SQLX_OFFLINE=false
export SQLX_OFFLINE_DIR="$project_root/.sqlx"
cargo check --all-targets
