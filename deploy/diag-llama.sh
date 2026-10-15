#!/usr/bin/env bash
# Novel app — diagnose "model server unreachable" from the AI Monitor page.
#
#   deploy/diag-llama.sh
#
# Traces the llama.cpp path in four hops and stops at the first broken one:
#   [A] host     -> llama port      (curl 127.0.0.1:21000/v1/models)
#   [B] inside app container: DNS   (does host.containers.internal resolve?)
#   [C] inside app container: TCP   (can we reach each candidate :21000?)
#   [D] inside app container: HTTP  (full /v1/models against the good candidate)
#
# Read-only. The old build hit the same wall on this host (plan/checkpoints
# CP-1 item 9): under rootless podman the CNI bridge has no host-side
# device, and host.containers.internal does NOT always resolve on a custom
# bridge network — the working address is often the rootless-netns gateway
# (10.2.0.2) or the host's LAN IP. This script finds which one works and
# prints the exact one-line unit fix for it.

set -uo pipefail

APP_CONTAINER="${APP_CONTAINER:-systemd-novel-app}"
LLAMA_PORT="${LLAMA_PORT:-21000}"

hr() { printf '\n== %s\n' "$1"; }

hr "A. host -> llama (is llama up at all?)"
if OUT="$(curl -s --max-time 5 "http://127.0.0.1:$LLAMA_PORT/v1/models")"; then
    echo "$OUT" | head -c 300; echo
    echo "   OK: llama is serving on host :$LLAMA_PORT"
else
    echo "   FAIL: host itself cannot reach llama on :$LLAMA_PORT"
    echo "   -> llama.cpp is down or not publishing: systemctl --user status llamacpp"
    exit 1
fi

hr "B. DNS inside the app container"
RESOLVED="$(podman exec "$APP_CONTAINER" getent hosts host.containers.internal 2>/dev/null)"
if [ -n "$RESOLVED" ]; then
    echo "   host.containers.internal -> $RESOLVED"
else
    echo "   FAIL: host.containers.internal does NOT resolve inside the container"
    echo "   (expected on a custom rootless bridge — see candidates below)"
fi

hr "C. TCP candidates from inside the app container"
# node's net module handles name+port uniformly; 3s timeout.
CANDIDATES="host.containers.internal 10.2.0.2"
# add the host's non-loopback, non-podman-internal IPv4s (rootless netns
# gateway + LAN IP are the usual winners on this host)
for ip in $(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
           | grep -vE '^(127\.|10\.0\.2\.|10\.8[89]\.|169\.254\.|172\.1[7-9]\.|172\.2[0-9]\.|172\.3[01]\.|192\.168\.)'); do
    CANDIDATES="$CANDIDATES $ip"
done
echo "   candidates: $CANDIDATES"
GOOD=""
for c in $CANDIDATES; do
    if podman exec "$APP_CONTAINER" node -e "
        const net=require('net');
        const a='$c'.split(':');
        const s=net.connect({host:a[0],port:parseInt('$LLAMA_PORT'),timeout:3000},
            ()=>{s.destroy();process.exit(0)});
        s.on('timeout',()=>{s.destroy();process.exit(1)});
        s.on('error',()=>process.exit(1));" 2>/dev/null; then
        echo "   $c :$LLAMA_PORT  OK"
        GOOD="$c"
    else
        echo "   $c :$LLAMA_PORT  FAIL"
    fi
done

hr "D. HTTP /v1/models against the best candidate"
if [ -n "$GOOD" ]; then
    RESP="$(podman exec "$APP_CONTAINER" node -e "
        fetch('http://$GOOD:$LLAMA_PORT/v1/models').then(r=>r.text())
            .then(t=>process.stdout.write(t)).catch(e=>process.exit(1))" 2>/dev/null)"
    if [ -n "$RESP" ]; then
        echo "$RESP" | head -c 300; echo
        echo
        echo "VERDICT: llama is reachable from the app via http://$GOOD:$LLAMA_PORT"
        echo "   Apply (one-line unit fix):"
        echo "     sed -i 's|^Environment=LLAMA_URL=.*|Environment=LLAMA_URL=http://$GOOD:$LLAMA_PORT/v1|' ~/.config/containers/systemd/novel-app.container"
        echo "     systemctl --user daemon-reload && systemctl --user restart novel-app"
        echo "   then reload the AI Monitor page — model card should show unloaded."
        exit 0
    fi
    echo "   TCP connected to $GOOD but /v1/models failed (unexpected)"
fi
echo "VERDICT: no candidate reached — check the llama container's actual"
echo "   publish (systemctl --user status llamacpp / podman port llamacpp-server)"
exit 1
