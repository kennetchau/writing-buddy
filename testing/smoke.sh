#!/usr/bin/env bash
# Novel app — end-to-end smoke (T6.1), mirroring the BRD pages top-to-bottom:
#   login → universe → lore → images → story → verify → chapters →
#   finalize → shelf → AI Monitor (model card + prompts) → admin
#
# Uses plain curl against a running app (any host/port). Works against:
#   - local dev:  PORT=9187 node dist/src/server.js   (with a local Postgres)
#   - the deploy host:  http://<host>:9187
#
# The app must already have the admin bootstrap user created (first boot).
# AI actions are NOT exercised here (they need the llama.cpp server); the
# AI Monitor page and model-status endpoint are checked for *shape*.
#
#   testing/smoke.sh <base_url> <admin_username> <admin_password>
#   e.g. testing/smoke.sh http://127.0.0.1:9187 admin 'secret'

set -euo pipefail

BASE="${1:-http://127.0.0.1:9187}"
ADMIN_USER="${2:-admin}"
ADMIN_PW="${3:?usage: smoke.sh <base_url> <admin_user> <admin_password>}"
BASE="${BASE%/}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

PASS=0
FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
check() { # $1=description  $2=expected  $3=actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2] got [$3])"; fi
}
contains() { # $1=description  $2=needle  $3=haystack
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 (missing [$2])" ;; esac
}

api() { # $1=method $2=path [$3=json-body] → sets RESP, prints body
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -b "$JAR" -c "$JAR" -X "$method" "$BASE$path")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  RESP="$(curl "${args[@]}")"
  echo "$RESP"
}

echo "== smoke: $BASE"

# ---- 1. auth (login page, login, me) ----
echo "[1] auth"
B=$(curl -s "$BASE/login"); contains "login page renders" "Username" "$B"
B=$(curl -s -c "$JAR" -b "$JAR" -X POST -d "username=$ADMIN_USER&password=$ADMIN_PW" -w '%{http_code}' -o /dev/null "$BASE/login")
check "admin login redirects" "302" "$B"
B=$(api GET /api/me); contains "api/me returns the admin" "$ADMIN_USER" "$B"

# ---- 2. universe (BRD §4.2, page 3) ----
echo "[2] universe"
B=$(api POST /api/universes '{"name":"SmokeWorld","description":"smoke"}'); U1=$(echo "$B" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$U1" ] && ok "create universe (id=$U1)" || bad "create universe"
B=$(curl -s -b "$JAR" "$BASE/universe"); contains "universe page lists it" "SmokeWorld" "$B"

# ---- 3. lore (page 2) ----
echo "[3] lore"
B=$(api POST /api/entries/0 "{\"title\":\"Sword of Smoke\",\"body_md\":\"A *sharp* blade.\",\"universe_id\":$U1}")
E1=$(echo "$B" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$E1" ] && ok "create lore entry (id=$E1)" || bad "create lore entry"
api POST "/api/entries/$E1" "{\"title\":\"Sword of Smoke\",\"body_md\":\"A sharper blade.\",\"universe_id\":$U1}" >/dev/null
B=$(curl -s -b "$JAR" "$BASE/lore/universe/$U1"); contains "entry list shows title" "Sword of Smoke" "$B"
B=$(curl -s -b "$JAR" "$BASE/lore/entry/$E1"); contains "entry editor renders" "A sharper blade" "$B"

# ---- 4. images (FR-13) ----
echo "[4] images"
printf '\x89PNG\r\n\x1a\n' > /tmp/smoke.png
B=$(curl -s -b "$JAR" -X POST -F "image=@/tmp/smoke.png" -F "lore_entry_id=$E1" "$BASE/api/images"); I1=$(echo "$B" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$I1" ] && ok "upload image (id=$I1)" || bad "upload image ($B)"

# ---- 5. story (page 1) ----
echo "[5] story"
B=$(api POST /api/stories/0 "{\"title\":\"Smoke Novel\",\"universe_id\":$U1}"); S1=$(echo "$B" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$S1" ] && ok "create story w/ primary universe (id=$S1)" || bad "create story"
# original-world story (nullable primary)
B=$(api POST /api/stories/0 '{"title":"Original World"}'); check "story w/o universe" "201" "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"title":"Original World 2"}' "$BASE/api/stories/0")"
# outline with links: one matching entry, one not
api POST "/api/stories/$S1" "{\"outline_md\":\"The hero wields the [Sword](sword of smoke). A [Ghost Ship](ghost-ship) appears. See [site](https://x.example).\"}" >/dev/null
B=$(api POST "/api/stories/$S1/verify" '{}')
contains "verify matches the entry (ci)" "Sword of Smoke" "$B"
contains "verify marks the unmatched link" '"matched":null' "$B"
contains "story page renders" "Smoke Novel" "$(curl -s -b "$JAR" "$BASE/story/$S1")"

# ---- 6. chapters + finalize → shelf (FR-24, page 5) ----
echo "[6] chapters + shelf"
api POST "/api/stories/$S1/chapters/0" '{"title":"Ch 1","body_md":"It **began** in the dark."}' >/dev/null
api POST "/api/stories/$S1/chapters/0" '{"title":"Ch 2","body_md":"Then the sword was found."}' >/dev/null
B=$(api POST "/api/stories/$S1/finalize" '{}'); contains "finalize story" '"ok":true' "$B"
B=$(curl -s -b "$JAR" "$BASE/shelf"); contains "shelf lists finalized story" "Smoke Novel" "$B"
B=$(curl -s -b "$JAR" "$BASE/shelf/$S1"); contains "shelf reader renders markdown" "<strong>began</strong>" "$B"

# ---- 7. AI Monitor (page 4): shape only — no model needed ----
echo "[7] AI Monitor"
B=$(curl -s -b "$JAR" "$BASE/ai"); contains "ai monitor page" "Model" "$B"
B=$(api GET /api/model); contains "model endpoint shape" '"reachable"' "$B"
B=$(api GET /api/prompts); contains "prompts seeded (4 actions)" "lore_suggest" "$B"
B=$(api POST /api/prompts '{"action":"generate","text_md":"Custom generate prompt."}')
contains "prompt save" '"ok":true' "$B"

# ---- 8. admin (page 6): add + delete a user (cascade) ----
echo "[8] admin"
B=$(curl -s -b "$JAR" "$BASE/admin/users"); contains "admin page renders" "Users" "$B"
B=$(api POST /api/admin/users '{"username":"smoketemp","password":"temp1234"}'); TID=$(echo "$B" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$TID" ] && ok "admin adds user (id=$TID)" || bad "admin adds user ($B)"
B=$(api POST "/api/admin/users/$TID/delete" '{"confirm":"smoketemp"}'); contains "admin deletes user (typed confirm)" '"ok":true' "$B"
B=$(api GET /api/me); contains "admin still logged in" "$ADMIN_USER" "$B"

# ---- 9. logout ----
echo "[9] logout"
B=$(curl -s -b "$JAR" -X POST -w '%{http_code}' -o /dev/null "$BASE/api/logout"); check "logout 200" "200" "$B"
B=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/api/me"); check "session gone after logout" "401" "$B"

echo
echo "== smoke result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
