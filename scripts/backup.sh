#!/usr/bin/env bash
# Novel app — nightly backup (backend doc §6, NFR-05: pg_dump + images dir).
#
# Everything the app stores:
#   1. the Postgres database   → `pg_dump` run INSIDE the novel-db container
#   2. the images flat dir     → the `novel-images` podman volume (tarred)
#
# Output: /srv/novel/backups/<UTC date>/{novel.sql, images.tar.gz, MANIFEST.txt}
# Retention: keep the newest $NOVEL_BACKUP_RETENTION (default 14) date dirs.
#
# Runs as a plain systemd user timer (novel-backup.timer), on the host.
# Needs: podman with passwordless access to the novel-db container.

set -euo pipefail

DB_CONTAINER="${NOVEL_DB_CONTAINER:-novel-db}"
IMAGES_VOLUME="${NOVEL_IMAGES_VOLUME:-novel-images}"
BACKUP_ROOT="${NOVEL_BACKUP_DIR:-/srv/novel/backups}"
RETENTION="${NOVEL_BACKUP_RETENTION:-14}"
STAMP="$(date -u +%Y%m%d)"
DEST="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST"

echo ">> novel backup $STAMP -> $DEST"

# 1) database dump (online, crash-consistent; runs as postgres in-container)
if podman ps -q --filter "name=^/${DB_CONTAINER}$" | grep -q .; then
  podman exec "$DB_CONTAINER" pg_dump -U novel novel > "$DEST/novel.sql"
  echo "  pg_dump: $DEST/novel.sql ($(wc -c < "$DEST/novel.sql") bytes)"
else
  echo "  WARNING: $DB_CONTAINER is not running — skipping pg_dump"
fi

# 2) images volume (tar the named volume out of a throwaway alpine container;
#    `:ro` because we only read it)
if podman volume inspect "$IMAGES_VOLUME" >/dev/null 2>&1; then
  podman run --rm -v "${IMAGES_VOLUME}:/data:ro" docker.io/library/alpine:3 \
      tar -cz -C /data . > "$DEST/images.tar.gz"
  echo "  images: $DEST/images.tar.gz ($(wc -c < "$DEST/images.tar.gz") bytes)"
else
  echo "  WARNING: volume $IMAGES_VOLUME not found — skipping images"
fi

# 3) retention: keep newest $RETENTION, prune the rest
(
  cd "$BACKUP_ROOT"
  ls -1d 20* 2>/dev/null | sort -r | tail -n +"$((RETENTION + 1))" | \
  while read -r old; do
    echo "  pruning $old"
    rm -rf -- "$old"
  done
)

# 4) manifest
{
  echo "stamp=$STAMP"
  echo "db_container=$DB_CONTAINER"
  echo "images_volume=$IMAGES_VOLUME"
  echo "retention=$RETENTION"
  ls -1 "$DEST"
} > "$DEST/MANIFEST.txt"

echo "backup complete: $DEST"
