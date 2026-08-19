#!/bin/bash
# Restore PostgreSQL from backup (T-073)
set -e

: "${DATABASE_URL:?Нужна переменная DATABASE_URL}"
FILE="${1:?Укажи файл бэкапа: ./scripts/restore.sh backups/casino_20260101_000000.sql.gz}"

echo "[restore] restoring from $FILE to $DATABASE_URL"
if [[ "$FILE" == *.gz ]]; then
  gunzip -c "$FILE" | psql "$DATABASE_URL"
else
  psql "$DATABASE_URL" < "$FILE"
fi

echo "[restore] done"
