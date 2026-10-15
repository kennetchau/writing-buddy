#!/usr/bin/env bash
# Novel app — install the quadlet (podman) deployment on the host.
#
# Builds the app image from this repo, installs the systemd units into
# ~/.config/containers/systemd/ (quadlets) and ~/.config/systemd/user/
# (plain backup units), and starts everything.
#
#   deploy/install-quadlet.sh                 # defaults
#   NOVEL_APP_IMAGE=novel-app:custom deploy/install-quadlet.sh
#
# Idempotent — re-run after `git pull` to rebuild + pick up unit changes.
#
# Pre-flight (old build DEPLOYMENT.md Phase 0):
#   - port 9187 free, 21000 taken by the llama.cpp container
#   - `loginctl enable-linger "$USER"` for unattended user units

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

APP_IMAGE="${NOVEL_APP_IMAGE:-novel-app:latest}"
QUADLET_DIR="$HOME/.config/containers/systemd"
SDUSER="$HOME/.config/systemd/user"
BACKUP_ROOT="/srv/novel/backups"

echo ">> repo          : $ROOT"
echo ">> app image     : $APP_IMAGE"
echo ">> quadlet dir   : $QUADLET_DIR"

command -v podman >/dev/null || { echo "error: podman not found" >&2; exit 1; }

# 1) build the app image (multi-stage: node:22 build → runtime)
podman build -f "$HERE/Dockerfile" -t "$APP_IMAGE" "$ROOT"

# 1b) generate a session secret and inject it into the app unit
SECRET="$(openssl rand -hex 32)"
install -d -m 0755 "$QUADLET_DIR"
install -m 0644 "$HERE/quadlet/novel.network"     "$QUADLET_DIR/novel.network"
install -m 0644 "$HERE/quadlet/novel-db.container" "$QUADLET_DIR/novel-db.container"
# the unit ships with a placeholder; substitute the generated secret
sed "s|^Environment=SESSION_SECRET=.*|Environment=SESSION_SECRET=$SECRET|" \
    "$HERE/quadlet/novel-app.container" > "$QUADLET_DIR/novel-app.container"
chmod 0644 "$QUADLET_DIR/novel-app.container"
if grep -q "CHANGE_ME_on_first_boot" "$QUADLET_DIR/novel-app.container"; then
  echo ">> WARNING: novel-app.container still has the CHANGE_ME admin password"
  echo ">>          — edit ~/.config/containers/systemd/novel-app.container now"
  echo ">>          and run 'systemctl --user daemon-reload'."
fi

# 2) backup script + plain systemd user units
install -d -m 0755 "$SDUSER"
install -m 0755 "$ROOT/scripts/backup.sh" "$SDUSER/backup-novel.sh"
install -m 0644 "$HERE/quadlet/novel-backup.service" "$SDUSER/novel-backup.service"
install -m 0644 "$HERE/quadlet/novel-backup.timer"   "$SDUSER/novel-backup.timer"
install -m 0644 "$HERE/quadlet/novel.env" "$SDUSER/novel.env"
install -d -m 0755 "$BACKUP_ROOT"

# 3) reload + start.
# Quadlet units (novel-*) are GENERATED into the user-systemd generator
# directory at every daemon-reload: they are started, not enabled (same
# behaviour as the old build's quadlets). The backup units are plain units
# and DO need enabling.
systemctl --user daemon-reload
# Ensure the "novel" CNI network exists BEFORE starting the containers
# (otherwise they fail with "unable to find network with name or ID
# novel"). Created via the podman CLI, NOT via the .network quadlet:
# on the deploy host (podman 5.x) the generator does not surface
# .network files to user systemd — `systemctl --user start novel.network`
# fails with "Unit novel.network.service not found" (observed 2026-10-06)
# even though the .container units generate fine. `podman network create`
# is idempotent here (guarded by `podman network exists`), so re-running
# this script is safe. The novel.network file stays installed for
# documentation / hosts whose generator does create the unit.
if podman network exists novel; then
    echo ">> CNI network 'novel' already exists"
else
    podman network create --subnet=10.91.0.0/24 --gateway=10.91.0.1 novel
    echo ">> created CNI network 'novel' (10.91.0.0/24)"
fi
# restart, not start: on re-runs after `git pull` the units are already
# running, and `start` is a silent no-op — the new image would never be
# picked up (observed 2026-10-07: rebuilt image ran, container kept the
# old one for hours). `restart` is a no-op-equivalent start on first run.
systemctl --user restart novel-db.service
# the app retries its DB connection at boot (NOVEL_BOOT_DB_ATTEMPTS), so
# starting it right away is fine even if postgres is still initializing.
systemctl --user restart novel-app.service
systemctl --user enable --now novel-backup.timer
systemctl --user status --no-pager novel-db.service novel-app.service novel-backup.timer || true

echo
echo "Done. Verify:"
echo "  curl -s http://127.0.0.1:9187/api/health          # → {\"ok\":true}"
echo "  systemctl --user status novel-app.service"
echo "  journalctl --user -u novel-app.service -n 40      # boot log (schema apply, admin)"
echo "  # log in at http://<host>:9187/ with the admin user from"
echo "  # novel-app.container, then IMMEDIATELY reset that password"
echo "  # (Admin → Users) — it is visible in the unit file."
echo
echo "Backups: nightly 03:30 UTC → $BACKUP_ROOT/<date>/ (14× retention)"
echo "  systemctl --user start novel-backup.service       # run now"
echo "  restore: createdb novel; pg_restore-style: psql novel < novel.sql,"
echo "           then extract images.tar.gz into the novel-images volume:"
echo "             podman run --rm -v novel-images:/d docker.io/library/alpine:3 sh -c \"tar -xzf - -C /d\" < images.tar.gz"
