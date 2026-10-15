#!/usr/bin/env bash
# Novel app — post-install checklist (run on the deploy host, as the quadlet owner).
#
#   deploy/finish-deploy.sh                 # disable bootstrap pw + restart + health + backup now
#   NOVEL_ADMIN_PW='<pw>' deploy/finish-deploy.sh   # also runs the full smoke suite
#
# What it does (all steps are idempotent — safe to re-run):
#   1. neutralize ADMIN_PASSWORD in the installed quadlet unit (bootstrap
#      only ever fires while the user table is empty; after first login the
#      real password lives in the DB, so the unit value should be junk)
#   2. daemon-reload + restart novel-app
#   3. curl /api/health
#   4. (only if NOVEL_ADMIN_PW is set) run testing/smoke.sh
#   5. run the backup job once and list the latest backup
#
# NOT covered (do by hand in a browser):
#   - AI Monitor: Load the model, then one manual Generate
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
UNIT="$HOME/.config/containers/systemd/novel-app.container"
PW="${NOVEL_ADMIN_PW:-}"

hr() { printf '\n== %s\n' "$1"; }
fail() { echo "FAILED: $*" >&2; exit 1; }

hr "1. neutralize ADMIN_PASSWORD in $UNIT"
[ -f "$UNIT" ] || fail "installed unit not found at $UNIT"
if grep -q '^Environment=ADMIN_PASSWORD=' "$UNIT"; then
    sed -i 's|^Environment=ADMIN_PASSWORD=.*|Environment=ADMIN_PASSWORD=x-disabled-x|' "$UNIT"
    echo "   set ADMIN_PASSWORD=x-disabled-x"
else
    echo "   (no ADMIN_PASSWORD line — nothing to do)"
fi

hr "2. daemon-reload + restart novel-app"
systemctl --user daemon-reload || fail "daemon-reload"
systemctl --user restart novel-app || fail "restart novel-app"
sleep 2

hr "3. health check"
if curl -sf --max-time 5 http://127.0.0.1:9187/api/health; then
    echo
    echo "   health OK"
else
    fail "health check failed — journalctl --user -u novel-app.service -n 40"
fi

hr "4. smoke suite"
if [ -z "$PW" ]; then
    echo "   skipped (set NOVEL_ADMIN_PW='<pw>' to run)"
else
    bash "$ROOT/testing/smoke.sh" http://127.0.0.1:9187 admin "$PW" || fail "smoke suite had failures"
fi

hr "5. backup run now"
systemctl --user status --no-pager novel-backup.timer
systemctl --user start novel-backup.service || fail "backup run"
ls -lt /srv/novel/backups/ 2>/dev/null | head -5

hr "DONE"
echo "  Remaining (manual, in browser):"
echo "    - AI Monitor page: Load the model, then one manual Generate on a story"
echo "  Day-to-day:"
echo "    - update:  git pull && deploy/install-quadlet.sh"
echo "    - logs:    journalctl --user -u novel-app.service -f"
echo "    - backup:  systemctl --user start novel-backup.service"
