#!/bin/bash
# Бэкап PostgreSQL — pg_dump (T-062)
set -e

: "${DATABASE_URL:?Нужна переменная DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATE=$(date -u +"%Y%m%d_%H%M%S")
mkdir -p "$BACKUP_DIR"

FILE="$BACKUP_DIR/casino_${DATE}.sql.gz"
echo "[backup] dumping to $FILE"
pg_dump "$DATABASE_URL" | gzip > "$FILE"

echo "[backup] done: $FILE (size $(du -h "$FILE" | cut -f1))"
echo "[backup] keeping last 7 days"
find "$BACKUP_DIR" -name "casino_*.sql.gz" -mtime +7 -delete || true

echo "[backup] recent backups:"
ls -lh "$BACKUP_DIR" | tail -n 10
