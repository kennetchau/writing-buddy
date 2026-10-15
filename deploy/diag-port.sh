#!/usr/bin/env bash
# Novel app — diagnose "app is listening inside but host :PORT is refused".
#
# Run on the DEPLOY host as the user that owns the quadlet (same user that
# ran deploy/install-quadlet.sh):
#
#   deploy/diag-port.sh                 # defaults: container systemd-novel-app, port 9187
#   CONTAINER=systemd-novel-db PORT=5432 deploy/diag-port.sh   # point it at the DB
#
# Prints six layers of evidence and a one-line verdict. Read-only — it only
# inspects, never restarts or reconfigures anything.
#
# Background (why this script exists): on a rootless host, a container on a
# USER-DEFINED BRIDGE publishes ports via `rootlessport`; the default pasta
# path and pods use a different mechanism. If the host-side listener never
# appears (ss shows nothing on the published port) even though the app logs
# "listening", we must tell which layer is dead:
#   [1] host listener      (ss on the host)
#   [2] podman publish     (podman port / inspect Ports)
#   [3] container network  (is it really attached to the bridge, with an IP?)
#   [4] app socket         (ss inside the container)
#   [5] host -> app direct (curl the container IP, bypasses host publish)
#   [6] rootlessport proc  (the forwarder process, if the bridge path is used)

set -uo pipefail

CONTAINER="${CONTAINER:-systemd-novel-app}"
PORT="${PORT:-9187}"

hr() { printf '\n== %s\n' "${1-}"; }
ok() { printf '   OK   %s\n' "${1-}"; }
bad() { printf '   FAIL %s\n' "${1-}"; }
info() { printf '        %s\n' "${1-}"; }

hr "0. basics"
info "container = $CONTAINER"
info "host port = $PORT"
info "user      = $(id -un) (uid $(id -u))"
podman --version 2>/dev/null | info || true
if [ "$(id -u)" != "0" ]; then
    info "rootless network cmd = $(podman info --format '{{.Host.RootlessNetworkCmd}}' 2>/dev/null)"
fi

# Is the container up at all?
STATE="$(podman inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)"
if [ "${STATE:-}" = "running" ]; then
    ok "container $CONTAINER is running"
else
    bad "container $CONTAINER state = '${STATE:-<not found>}' — start it: systemctl --user start ${CONTAINER%.service}"
    info "(everything below will be empty; fix the unit first)"
fi

hr "1. host listener (is anything bound on :$PORT on the HOST?)"
if ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}\b"; then
    ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}\b" | info
    ok "host :$PORT has a listener"
else
    bad "host :$PORT has NO listener (this is the symptom — ss empty)"
fi

hr "2. podman publish (what does podman think it published?)"
PORTS_TBL="$(podman port "$CONTAINER" 2>/dev/null)"
if [ -n "$PORTS_TBL" ]; then
    printf '%s\n' "$PORTS_TBL" | info
    ok "podman reports a publish rule for $CONTAINER"
else
    bad "podman port reports NOTHING for $CONTAINER (no publish applied)"
fi
info "raw: $(podman inspect -f 'NetMode={{.HostConfig.NetworkMode}} Ports={{.NetworkSettings.Ports}}' "$CONTAINER" 2>/dev/null)"

hr "3. container network (is it attached to a bridge with an IP?)"
NETS="$(podman inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{$n}}={{$c.IPAddress}} {{end}}' "$CONTAINER" 2>/dev/null)"
if [ -n "${NETS// /}" ]; then
    info "networks: $NETS"
    ok "container has a network assignment"
else
    bad "container has NO network/IP (empty NetworkSettings.Networks)"
fi

hr "4. app socket (is the app listening inside the container?)"
# node:22 images may not ship ss — fall back to a raw /proc/net/tcp scan
# (port in hex, local-address column 2, state 0A = LISTEN).
HEXPORT="$(printf '%04X' "$PORT")"
LISTEN="$(podman exec "$CONTAINER" sh -c '
    ss -ltn 2>/dev/null | grep -E "[:.]'"${PORT}"'\b" || {
      awk -v p=":'"$HEXPORT"'" '"'"'NR>1 && split($2,a,":") && a[2]==substr(p,2) && $4=="0A" {print "LISTEN " $2}'"'"' \
          /proc/net/tcp /proc/net/tcp6 2>/dev/null
    }' 2>/dev/null)"
if [ -n "$LISTEN" ]; then
    printf '%s\n' "$LISTEN" | info
    ok "app is listening on :$PORT inside the container"
else
    bad "app is NOT listening on :$PORT inside the container"
    info "full inside-listeners:"
    podman exec "$CONTAINER" sh -c 'ss -ltn 2>/dev/null || true' | info || true
fi

hr "5. host -> app direct (bypasses the host-side publish)"
# IMPORTANT (rootless + user bridge): the host CANNOT route to the bridge
# subnet (e.g. 10.91.x) — it lives in the rootless netns. curling the IP
# from the host is a valid check only for ROOTFUL bridges. For rootless we
# exec a tiny TCP connect INSIDE the container's own namespace instead.
IP="$(podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER" 2>/dev/null)"
info "container IP = '${IP:-<none>}'"
DIRECTHOOK=0
if [ -n "$IP" ]; then
    # node is guaranteed present in this image: connect to 127.0.0.1:PORT
    # inside the container (same netns the app listens on).
    if RESP="$(podman exec "$CONTAINER" node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null)" && [ -n "$RESP" ]; then
        info "in-container response: $RESP"
        ok "app answers on 127.0.0.1:$PORT from INSIDE the container -> app + network are healthy; any host-side refusal is a publish-layer problem"
        VERDICT="app healthy inside; host publish layer broken"
        DIRECTHOOK=1
    else
        bad "app did NOT answer on 127.0.0.1:$PORT from inside the container"
        VERDICT="app not answering even in its own namespace"
    fi
    if [ "$DIRECTHOOK" = "1" ] && [ "$(id -u)" != "0" ]; then
        info "(note: host->bridge-IP curl is skipped — on rootless bridges the host"
        info " cannot route into the rootless netns; the in-container check above is the real test)"
    fi
else
    bad "no container IP / assignment"
    VERDICT="no container IP"
fi

hr "6. forwarder process (rootlessport for bridge publish; pasta for default)"
# The forwarder for a user-defined bridge lives in the container's cgroup.
PROC="$(podman exec -u 0 "$CONTAINER" sh -c 'ps -ef 2>/dev/null || true' 2>/dev/null | grep -Ei 'rootlessport|slirp4netns|pasta' | grep -v grep || true)"
# Also scan the unit's cgroup on the host if readable.
CG="$(systemctl --user show "$CONTAINER" -p ControlGroup 2>/dev/null | cut -d= -f2-)"
info "unit cgroup = ${CG:-<unknown>}"
CGPROCS=""
if [ -n "$CG" ] && [ -d "/sys$CG" ]; then
    CGPROCS="$(
        find "/sys$CG" -name cgroup.procs -print0 2>/dev/null | while IFS= read -r -d '' f; do
            while read -r p; do
                [ -r "/proc/$p/comm" ] && cat "/proc/$p/comm"
            done < "$f"
        done | sort -u | tr '\n' ' '
    )"
    info "cgroup procs = ${CGPROCS:-<unreadable>}"
fi
if printf '%s\n' "${PROC:-}${CGPROCS:-}" | grep -qiE 'rootlessport'; then
    ok "rootlessport is present (correct forwarder for a user-defined bridge)"
else
    info "no rootlessport visible in container ps/cgroup (expected if default-pasta or if the forwarder died)"
fi

hr "VERDICT"
case "${VERDICT:-unknown}" in
    "app healthy inside; host publish layer broken")
        info "The app answers inside its own namespace, so the app AND the bridge"
        info "are fine. The failure is purely the host-side publish of :$PORT — on"
        info "this podman a bare single-number PublishPort lands on a RANDOM host"
        info "port. Fix: make it explicit 'PublishPort=$PORT:$PORT' in the .container"
        info "unit (two numbers, like the working llamacpp unit), then"
        info "  systemctl --user daemon-reload && systemctl --user restart novel-app"
        ;;
    "app not answering even in its own namespace")
        info "The app isn't serving :$PORT even from inside the container. Check the"
        info "unit's Environment=PORT matches $PORT, and 'journalctl --user -u novel-app'"
        info "for a boot error (DB race, bad env). Not a networking problem."
        ;;
    "no container IP")
        info "Container has no IP — see 'container network' above."
        ;;
    *)
        info "Look at the FAIL lines above; fix the topmost failing layer first."
        ;;
esac
