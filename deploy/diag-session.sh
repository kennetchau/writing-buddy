#!/usr/bin/env bash
# Novel app — diagnose "keep getting logged out".
#
#   deploy/diag-session.sh
#   NOVEL_ADMIN_PW='<pw>' deploy/diag-session.sh    # also does a cookie round-trip
#
# Sessions in this app are random tokens stored in Postgres (NOT signed
# cookies) — see src/auth/session.ts. So the diagnostic splits the problem:
#   [A] is novel-app crash-looping?        (journal: restart count)
#   [B] do session rows exist / persist?   (DB: count per user, ages)
#   [C] does a cookie survive across requests? (curl round-trip, only if
#       NOVEL_ADMIN_PW is set) — if yes, the server is fine and it's a
#       browser/URL issue (e.g. accessing via 127.0.0.1 AND the LAN name).
# Read-only except the test login in [C].

set -uo pipefail

APP_CONTAINER="${APP_CONTAINER:-systemd-novel-app}"
DB_CONTAINER="${DB_CONTAINER:-systemd-novel-db}"
PORT="${PORT:-9187}"
PW="${NOVEL_ADMIN_PW:-}"

hr() { printf '\n== %s\n' "$1"; }

hr "A. novel-app restart history (crash loop?)"
systemctl --user status --no-pager novel-app | head -8
echo "   restarts in last 24h:"
journalctl --user -u novel-app.service --since "24 hours ago" --no-pager 2>/dev/null \
    | grep -c "Started novel-app" | sed 's/^/   count: /'
echo "   last 5 start/stop lines:"
journalctl --user -u novel-app.service --since "24 hours ago" --no-pager 2>/dev/null \
    | grep -E "Started|Stopped|Main process exited|Failed" | tail -5 | sed 's/^/   /'

hr "B. session rows in Postgres"
podman exec "$DB_CONTAINER" psql -U novel -t -c "
SELECT u.username, count(*) AS sessions,
       min(s.created_at) AS oldest, max(s.expires_at) AS newest_expiry
FROM session s JOIN \"user\" u ON u.id = s.user_id
GROUP BY u.username ORDER BY u.username;" 2>&1 | sed 's/^/   /'
echo "   (0 rows for your user = every cookie you hold is dead on arrival;"
echo "    rows present but you're still kicked out = browser-side cookie issue)"

hr "C. cookie round-trip (server-side proof)"
if [ -z "$PW" ]; then
    echo "   skipped (set NOVEL_ADMIN_PW='<pw>' to run)"
else
    CJ="$(mktemp)"
    trap 'rm -f "$CJ"' EXIT
    LOGIN="$(curl -s -c "$CJ" -X POST "http://127.0.0.1:$PORT/api/login" \
        -H 'content-type: application/json' \
        -d "{\"username\":\"admin\",\"password\":\"$PW\"}")"
    echo "   login: $LOGIN"
    for i in 1 2 3; do
        ME="$(curl -s -b "$CJ" "http://127.0.0.1:$PORT/api/me")"
        echo "   /api/me #$i: $ME"
    done
    echo "   cookie file contents (name only):"
    awk 'NR>1 && $6!~/^#/ {print "   " $6}' "$CJ" 2>/dev/null
    echo
    echo "   If all three /api/me calls return your user, the SERVER is fine."
    echo "   A browser then being 'logged out' means the browser is not"
    echo "   sending the cookie — the usual causes:"
    echo "     - two addresses in use (127.0.0.1 vs host name/IP/phone):"
    echo "       cookies are per-hostname; pick ONE address everywhere,"
    echo "     - site data / cookies cleared by the browser or an extension,"
    echo "     - 'block third-party cookies' is NOT the cause here (same-site),"
    echo "     - private window closed and reopened (expected)."
fi
