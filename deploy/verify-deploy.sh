#!/usr/bin/env bash
# Novel app — verify the running image actually contains the source you think
# it does (the "I rebuilt but nothing changed" checker).
#
#   deploy/verify-deploy.sh
#
set -uo pipefail
hr() { printf '\n== %s\n' "$1"; }

hr "1. source on the host (marker string present?)"
ROOT="/srv/novel/repo"
for f in src/auth/middleware.ts; do
    if grep -q "NO cookie at all" "$ROOT/$f" 2>/dev/null; then
        echo "   OK   $f has the debug build"
    else
        echo "   FAIL $f is MISSING the debug build — rsync/copy didn't land"
    fi
done

hr "2. image vs container"
echo "   image built:    $(podman image inspect localhost/novel-app:latest --format '{{.Created}}' 2>/dev/null || echo '?')"
echo "   container:      started $(podman inspect systemd-novel-app --format '{{.State.StartedAt}}' 2>/dev/null || echo '?')"
echo "   image id:       $(podman inspect systemd-novel-app --format '{{.Image}}' 2>/dev/null || echo '?')"
echo "   tag id:         $(podman image inspect localhost/novel-app:latest --format '{{.Id}}' 2>/dev/null || echo '?')"

hr "3. marker inside the RUNNING container's compiled code"
N="$(podman exec systemd-novel-app grep -c 'NO cookie at all' /app/dist/src/auth/middleware.js 2>/dev/null | head -1)"
N="${N:-0}"
if [ "$N" -ge 1 ] 2>/dev/null; then
    echo "   OK   running code HAS the debug build"
else
    echo "   FAIL running container has the OLD code — redeploy (steps below)"
fi

hr "4. session table sanity"
podman exec systemd-novel-db psql -U novel -t -c "SELECT count(*) FROM session;" 2>/dev/null | sed 's/^/   session rows: /'

if [ "$N" -lt 1 ]; then
    cat <<'EOF'

   FIX — run these on the host, in order:
     cd /srv/novel/repo
     git pull                      # (or re-rsync from the correct source dir)
     grep -c "NO cookie at all" src/auth/middleware.ts    # must be >= 1
     deploy/install-quadlet.sh     # watch: COPY src must NOT be a cache hit
     systemctl --user restart novel-app
     ./deploy/verify-deploy.sh     # re-run; sections 2+3 must agree
EOF
fi
