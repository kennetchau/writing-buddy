#!/usr/bin/env bash
# Novel app — diagnose "browser keeps a valid session cookie but stops
# sending it" (intermittent auto-logout, see agent/issue-autologout.md).
#
# Usage (on the deploy host, as the user that owns nginx access rights):
#   deploy/diag-autologout.sh                              # full diagnostic
#   HOST=story.<lan-domain> SUDO=sudo deploy/diag-autologout.sh
#   NOVEL_ADMIN_PW='<pw>' deploy/diag-autologout.sh        # + cookie round-trip
#   deploy/diag-autologout.sh capture 'HH:MM'              # nginx log around
#                                                          # the flip moment
#
# What it proves:
#   [1] TLS certificate actually served for the hostname — a hygiene issue
#       and a *contributing suspect* for the auto-logout (the wrong
#       cockpit.*.sslip.io cert has been served since before DNS existed).
#       An accepted mismatched cert alone is NOT a proven cause.
#   [2] Full response headers (Set-Cookie flags, HSTS, extra headers) from
#       nginx and from the app directly, plus the nginx :443 response.
#   [3] Whether any plain-http (port 80) vhost for the host exists — a
#       redirector to https would still be fine, but an http-serving vhost
#       would let the Secure flag be stripped/lost.
#   [4] Server-side cookie round-trip (login -> N x /api/me) — expected to
#       pass; if it fails the DB/app is at fault and the rest is moot.
#   [5] nginx access-log capture in the background (start/stop phases) so
#       you can reproduce the logout in the browser between them and then
#       see exactly which response preceded the first 401.
#
# Read-only with respect to the app and nginx (one throwaway test login in
# [4]; that creates one session row, same as any login).

set -uo pipefail

HOST="${HOST:-story.<lan-domain>}"
SUDO="${SUDO:-}"          # e.g. SUDO=sudo if nginx logs need root
APP_PORT="${APP_PORT:-9187}"
PW="${NOVEL_ADMIN_PW:-}"
LOGS="${LOGS:-/var/log/nginx}"

hr() { printf '\n== %s\n' "$1"; }
ok() { printf '   OK: %s\n' "$1"; }
bad() { printf '   *** FAIL: %s\n' "$1"; }

find_logfile() {
    for cand in "$LOGS/access.log" "$LOGS/access.log.1" /var/log/nginx/error.log; do
        [ -f "$cand" ] && { echo "$cand"; return; }
    done
    echo /var/log/nginx/access.log
}

# ------------------------------------------------- capture subcommand
# Runs immediately (before the rest of the diagnostic).
if [ "${1:-}" = "capture" ]; then
    T="${2:-}"
    LF="$(find_logfile)"
    hr "capture: nginx access log around ${T:-now} from $LF"
    if [ -f "$LF" ]; then
        # nginx default log time format: [10/Oct/2026:13:35:00 +0000]
        if [ -n "$T" ]; then
            START="$(grep -n -F " $T" "$LF" | head -1 | cut -d: -f1 || true)"
            if [ -n "$START" ]; then
                A=$(( (START - 100 < 1) ? 1 : START - 100 ))
                echo "   --- lines around first match (line $START) ---"
                sed -n "${A},+$((START * 2))p" "$LF"
            else
                echo "   (no lines containing ' $T ' — try a nearby time)"
                tail -200 "$LF"
            fi
        else
            tail -200 "$LF"
        fi
    else
        bad "log file not found: $LF (override with LOGS=/path/to/dir)"
    fi
    exit 0
fi

# ---------------------------------------------------------------- [1] cert
hr "1. TLS certificate actually served for ${HOST}:443  (top suspect)"
CERT_OK=1
if command -v openssl >/dev/null 2>&1; then
    OUT="$("$SUDO" timeout 10 openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null \
          | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null)"
    SAN="$(printf '%s\n' "$OUT" | awk -F'= ' '/subjectAltName/{print $2}')"
else
    echo "   (openssl not installed on this host — using curl's certificate dump)"
    OUT="$(curl -sv --max-time 10 "https://${HOST}/login" 2>&1 >/dev/null \
          | grep -E '^\* +(subject|issuer|start date|expire date):')"
    SAN=""
fi
if [ -z "$OUT" ]; then
    CERT_OK=0
    bad "could not get a certificate from ${HOST}:443 — is nginx even up / is the name resolving here?"
else
    printf '%s\n' "$OUT" | sed 's/^/   /'
    SUBJECT="$(printf '%s\n' "$OUT" | awk -F': ' '/subject:/{print $2}')"
    if [ -n "$SAN" ]; then
        if printf '%s' "$SAN" | grep -qE "(^|,)${HOST//./\\.}(,|$)"; then
            ok "SAN contains ${HOST} — cert is (probably) not the problem"
        else
            CERT_OK=0
            bad "SAN does NOT contain ${HOST} (got: ${SAN})."
        fi
    elif printf '%s' "$SUBJECT" | grep -qF "$HOST"; then
        ok "subject contains ${HOST} — cert looks right"
    else
        CERT_OK=0
        bad "certificate subject is '${SUBJECT}' — does NOT match ${HOST}."
    fi
    if [ "$CERT_OK" -eq 0 ]; then
        cat <<EOF
   *** WARNING: the certificate does not match ${HOST}.
   This is a hygiene problem (Firefox shows "Not Secure"; old security
   exceptions for this host may linger) and it is a CONTRIBUTING SUSPECT
   for the auto-logout — NOT a proven root cause: an accepted mismatched
   cert alone does not make Firefox withhold cookies.
   Optional fix: point the vhost at a cert covering ${HOST}, then
     nginx -t && nginx -s reload
   and in Firefox clear any old security exception / HSTS entry for this
   host (about:preferences#privacy), then re-login.
EOF
    fi
fi
# also: what does the BROWSER get if the name resolves elsewhere?
echo
echo "   DNS as seen by this host:"
getent hosts "$HOST" | sed 's/^/   /' || echo "   (name does not resolve here)"
echo "   (AdGuard answers the LAN; if this host resolves ${HOST} to a"
echo "    different IP than the user's Firefox, the user's browser is"
echo "    talking to a different server/vhost than the one you check.)"

# ------------------------------------------------- [2] response headers
hr "2. Response headers: login page (via nginx) and app direct"
echo "   --- nginx :443 GET /login (unauthed — shows HSTS + page headers) ---"
curl -skI "https://${HOST}/login" | sed 's/^/   /'
echo
echo "   --- app direct :$APP_PORT GET /login (same app, no nginx) ---"
curl -sI "http://127.0.0.1:${APP_PORT}/login" | sed 's/^/   /'
echo
echo "   Checks:"
NS="$(curl -skI "https://${HOST}/login")"
if printf '%s' "$NS" | grep -qi '^set-cookie:'; then
    echo "   WARN: unauthenticated GET /login set a cookie — expected: none"
else
    ok "no Set-Cookie on the unauthed login page"
fi
if printf '%s' "$NS" | grep -qi 'strict-transport-security'; then
    echo "   note: HSTS present — good, but then any past cert error on this"
    echo "         host name may be cached by Firefox for 2 years"
    echo "         (about:preferences#privacy -> HSTS -> delete the entry and retry)"
else
    echo "   note: no HSTS header (that alone is not a bug for a LAN app)"
fi

# ------------------------------------------- [3] any plain http vhost?
hr "3. Is anything serving this host on plain http (port 80)?"
RESP80="$(curl -sI --max-time 5 "http://${HOST}/login" 2>/dev/null || true)"
if [ -z "$RESP80" ]; then
    ok "nothing answers on http:// (443 only) — no insecure copy of the site"
else
    printf '%s\n' "$RESP80" | sed 's/^/   /'
    if printf '%s' "$RESP80" | grep -qi '^location:.*https'; then
        ok "port 80 exists but redirects to https (fine)"
    else
        bad "port 80 serves the site over PLAIN HTTP."
        bad "If Firefox ever visits http://$(echo "$HOST"), it can drop cookies"
        bad "for the whole host (SameSite=Lax + insecure origin interaction)."
        bad "Also check the user's bookmarks/URL bar: they MUST use https://"
    fi
fi
echo "   vhosts mentioning this host (grep nginx confs):"
grep -rn "$HOST" /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null \
    | sed 's/^/   /' || echo "   (not found in default nginx conf dirs — may live elsewhere)"

# ------------------------------------------------- [4] cookie round-trip
hr "4. Server-side cookie round-trip (test login, expect 3x authed)"
if [ -z "$PW" ]; then
    echo "   skipped (set NOVEL_ADMIN_PW='<pw>' to run)"
else
    CJ="$(mktemp)"
    LOGIN="$(curl -s -c "$CJ" -X POST "http://127.0.0.1:${APP_PORT}/api/login" \
        -H 'content-type: application/json' \
        -d "{\"username\":\"admin\",\"password\":\"$PW\"}")"
    echo "   login: $LOGIN"
    printf '%s\n' "$CJ" | awk 'NR>1 && $6=="session" {print "   Set-Cookie jar entry: " $0}'
    FAIL=0
    for i in 1 2 3; do
        ME="$(curl -s -b "$CJ" "http://127.0.0.1:${APP_PORT}/api/me")"
        printf '   /api/me #%d: %s\n' "$i" "$ME"
        printf '%s' "$ME" | grep -q '"username"' || FAIL=1
    done
    [ "$FAIL" -eq 0 ] && ok "server-side session round-trip is fine" \
                      || bad "server-side round-trip FAILED — app/DB problem"
fi

# ------------------------------------------- [5] nginx log capture
hr "5. nginx access-log capture (reproduce the logout in the browser NOW)"
LOGFILE="$(find_logfile)"
echo "   tail the nginx access log yourself (or run:  $SUDO tail -f $LOGFILE)"
echo
echo "   Reproduce: use the app in Firefox until the badge/polls flip to"
echo "   401, note the time, then run:"
echo "     deploy/diag-autologout.sh capture '$(date '+%H:%M')'"
echo "   (pass the time the first 401 appeared) and it will print the"
echo "   log lines around it from $LOGFILE."
echo
echo "   What to look for in the capture:"
echo "     - first 401 immediately after a 502/504/499  -> proxy mid-frame"
echo "     - 401s in a clean 5s cadence from 192.168.x  -> browser-side"
echo "     - a burst of 302/400 or unusual UA just before     -> page reload"
echo

hr "INTERPRETION"
cat <<'EOF'
  The app classifies every 401 itself now (reason: missing | unknown |
  expired) — after a flip, run:
    journalctl --user -u novel-app.service | grep '\[auth\] 401' | tail
  and match the reason against this log capture:
    - missing in a clean 5s cadence, no 502/504/499 before it
        -> browser-side cookie suppression (security-state flip: check old
           security exceptions / HSTS in Firefox; the cert above may be a
           contributor, but an accepted mismatched cert alone is not proven
           to cause it).
    - missing right after 502/504/499 -> nginx/proxy mid-frame; dig there.
    - expired unexpectedly early -> sliding-window/DB clock bug in the app.
    - unknown with a recent login -> session row deleted out-of-band.
  In-stack code facts (full review, agent/issue-autologout.md): the app only
  deletes sessions on logout/expiry; cookie flags correct; no mixed content;
  server round-trip proven fine.
EOF
